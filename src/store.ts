import type {
  LockHandle,
  Manifest,
  ManifestInfo,
  Operation,
  StorageBackend,
  StoreOptions,
  StoreStats,
} from "./types.js";
import { createDefaultManifest } from "./manifest.js";
import { FsBackend } from "./backend.js";
import { LamportClock } from "./clock.js";
import { createDelta, applyDelta, isDeltaSmaller } from "./delta.js";
import type { DeltaPatch } from "./delta.js";

/** Core option keys that have defaults. */
interface CoreOptions {
  checkpointThreshold: number;
  checkpointOnClose: boolean;
  version: number;
  migrate: (record: unknown, fromVersion: number) => unknown;
  readOnly: boolean;
  skipLoad: boolean;
}

export class Store<T = Record<string, unknown>> {
  private dir = "";
  private records = new Map<string, T>();
  private ops: Operation<T>[] = [];
  private archiveSegments: string[] = [];
  private opened = false;
  private version = 1;
  private activeOpsPath = "";
  private created = "";
  private coreOpts: CoreOptions = {
    checkpointThreshold: 100,
    checkpointOnClose: true,
    version: 1,
    migrate: (r) => r as T,
    readOnly: false,
    skipLoad: false,
  };
  private archivedRecordCount = 0;
  private batching = false;
  private batchOps: Operation<T>[] = [];
  private _lock: Promise<void> = Promise.resolve();
  private lockHandle: LockHandle | null = null;
  private backend!: StorageBackend;

  // Multi-writer state
  private agentId?: string;
  private clock: LamportClock | null = null;

  // Group commit state
  private groupCommit = false;
  private asyncMode = false;
  private groupBuffer: Operation<T>[] = [];
  private groupSize = 50;
  private groupMs = 100;
  private groupTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestVersion: string | null = null;
  private manifest: Manifest | null = null;

  /**
   * Serialize all state-mutating operations through a promise chain.
   * Prevents interleaving of async mutations. Reads remain synchronous and lock-free.
   */
  private serialize<R>(fn: () => Promise<R>): Promise<R> {
    const prev = this._lock;
    let resolve!: () => void;
    this._lock = new Promise<void>((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(() => resolve());
  }

  private isMultiWriter(): boolean {
    return this.agentId !== undefined;
  }

  async open(dir: string, options?: StoreOptions): Promise<void> {
    this.dir = dir;
    if (options) {
      const { backend, agentId, writeMode, groupCommitSize, groupCommitMs, skipLoad, ...rest } = options;
      if (skipLoad) {
        this.coreOpts.skipLoad = true;
        // Never checkpoint when skipLoad — Map is empty, would overwrite real data
        this.coreOpts.checkpointOnClose = false;
      }
      this.coreOpts = { ...this.coreOpts, ...rest };
      if (backend) this.backend = backend;
      if (agentId) this.agentId = agentId;

      // Group/async commit: enabled when writeMode is "group"/"async" AND not multi-writer
      if (writeMode === "group" || writeMode === "async") {
        if (agentId) {
          console.error(`opslog: writeMode '${writeMode}' is not compatible with multi-writer (agentId). Using 'immediate'.`);
        } else {
          this.groupCommit = true;
          this.asyncMode = writeMode === "async";
          if (groupCommitSize) this.groupSize = groupCommitSize;
          if (groupCommitMs) this.groupMs = groupCommitMs;
        }
      }
    }
    this.backend ??= new FsBackend();

    await this.backend.initialize(dir, { readOnly: this.coreOpts.readOnly });

    // Acquire write lock (single-writer only, not readOnly)
    if (!this.coreOpts.readOnly && !this.isMultiWriter()) {
      this.lockHandle = await this.backend.acquireLock();
    }

    const manifest = await this.backend.readManifest();

    if (!manifest) {
      if (this.coreOpts.readOnly) {
        throw new Error(
          "Cannot open in readOnly mode: no existing store found",
        );
      }
      await this.initFreshStore();
    } else {
      await this.loadExistingStore(manifest);
    }

    this.manifestVersion = await this.backend.getManifestVersion();
    this.opened = true;
  }

  private async initFreshStore(): Promise<void> {
    const snapshotPath = await this.backend.writeSnapshot(
      new Map(),
      this.coreOpts.version,
    );

    let opsPath: string;
    if (this.isMultiWriter()) {
      opsPath = await this.backend.createAgentOpsFile(this.agentId!);
    } else {
      opsPath = await this.backend.createOpsFile();
    }

    const newManifest = createDefaultManifest(snapshotPath, opsPath);
    if (this.isMultiWriter()) {
      newManifest.activeAgentOps = { [this.agentId!]: opsPath };
    }
    await this.backend.writeManifest(newManifest);

    this.manifest = newManifest;
    this.version = this.coreOpts.version;
    this.activeOpsPath = opsPath;
    this.created = newManifest.stats.created;
    this.archiveSegments = [];

    if (this.isMultiWriter()) {
      this.clock = new LamportClock(0);
    }
  }

  private async loadExistingStore(manifest: Manifest): Promise<void> {
    this.created = manifest.stats.created;
    this.archiveSegments = manifest.archiveSegments;
    this.archivedRecordCount = manifest.stats.archivedRecords;
    this.manifest = manifest;

    // skipLoad: acquire ops path for writes but don't load records or replay WAL
    if (this.coreOpts.skipLoad) {
      this.version = this.coreOpts.version;
      if (this.isMultiWriter()) {
        const maxClock = 0;
        this.clock = new LamportClock(maxClock);
        if (manifest.activeAgentOps?.[this.agentId!]) {
          this.activeOpsPath = manifest.activeAgentOps[this.agentId!];
        } else {
          this.activeOpsPath = await this.backend.createAgentOpsFile(this.agentId!);
          const updatedManifest: Manifest = {
            ...manifest,
            activeAgentOps: { ...(manifest.activeAgentOps ?? {}), [this.agentId!]: this.activeOpsPath },
          };
          await this.backend.writeManifest(updatedManifest);
          this.manifest = updatedManifest;
        }
      } else {
        this.activeOpsPath = manifest.activeOps;
      }
      return;
    }

    // Load snapshot
    let snapshotData: { records: Map<string, unknown>; version: number };
    try {
      snapshotData = await this.backend.loadSnapshot(
        manifest.currentSnapshot,
      );
    } catch (err) {
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isNotFound) {
        throw new Error(
          `Snapshot file not found: ${manifest.currentSnapshot}. The data directory may be corrupted.`,
          { cause: err },
        );
      }
      throw err;
    }

    const { records, version: storedVersion } = snapshotData;
    this.records = records as Map<string, T>;
    this.version = storedVersion;

    // Migrate if needed
    if (storedVersion < this.coreOpts.version) {
      for (const [id, record] of this.records) {
        this.records.set(
          id,
          this.coreOpts.migrate(record, storedVersion) as T,
        );
      }
      this.version = this.coreOpts.version;
    }

    if (this.isMultiWriter()) {
      await this.loadMultiWriterOps(manifest);
    } else {
      // Single-writer: replay ops from active ops file
      const ops = (await this.backend.readOps(
        manifest.activeOps,
      )) as Operation<T>[];
      for (const op of ops) {
        this.applyOp(op);
      }
      this.ops = ops;
      this.activeOpsPath = manifest.activeOps;
    }
  }

  private async loadMultiWriterOps(manifest: Manifest): Promise<void> {
    const allOps: Operation<T>[] = [];

    // Read all agent ops files
    if (manifest.activeAgentOps) {
      for (const opsPath of Object.values(manifest.activeAgentOps)) {
        const ops = (await this.backend.readOps(opsPath)) as Operation<T>[];
        allOps.push(...ops);
      }
    }

    // Also read legacy single-writer ops for backward compat
    if (manifest.activeOps && !manifest.activeAgentOps) {
      const ops = (await this.backend.readOps(
        manifest.activeOps,
      )) as Operation<T>[];
      allOps.push(...ops);
    }

    // Merge-sort by (clock, agent) for deterministic total order
    allOps.sort((a, b) => {
      const clockDiff = (a.clock ?? 0) - (b.clock ?? 0);
      if (clockDiff !== 0) return clockDiff;
      return (a.agent ?? "").localeCompare(b.agent ?? "");
    });

    for (const op of allOps) {
      this.applyOp(op);
    }
    this.ops = allOps;

    // Initialize Lamport clock from max seen value
    const maxClock = allOps.reduce(
      (max, op) => Math.max(max, op.clock ?? 0),
      0,
    );
    this.clock = new LamportClock(maxClock);

    // Find or create our agent's ops file
    if (manifest.activeAgentOps?.[this.agentId!]) {
      this.activeOpsPath = manifest.activeAgentOps[this.agentId!];
    } else {
      // Register this agent in the manifest
      this.activeOpsPath = await this.backend.createAgentOpsFile(
        this.agentId!,
      );
      const updatedManifest: Manifest = {
        ...manifest,
        activeAgentOps: {
          ...(manifest.activeAgentOps ?? {}),
          [this.agentId!]: this.activeOpsPath,
        },
      };
      await this.backend.writeManifest(updatedManifest);
    }
  }

  async close(): Promise<void> {
    this.ensureOpen();
    this.unwatch();
    // Flush any buffered group commit ops before checkpoint
    if (this.groupCommit && this.groupBuffer.length > 0) {
      await this.serialize(() => this.flushGroupBuffer());
    }
    if (
      !this.coreOpts.readOnly &&
      this.coreOpts.checkpointOnClose &&
      this.ops.length > 0
    ) {
      await this.serialize(() => this._compact());
    }
    if (this.lockHandle) {
      await this.backend.releaseLock(this.lockHandle);
      this.lockHandle = null;
    }
    await this.backend.shutdown();
    this.opened = false;
  }

  get(id: string): T | undefined {
    this.ensureOpen();
    return this.records.get(id);
  }

  set(id: string, value: T): Promise<void> | void {
    this.ensureOpen();
    this.ensureWritable();
    if (this.batching) {
      this._setSync(id, value);
      return;
    }
    return this.serialize(() => this._set(id, value));
  }

  delete(id: string): Promise<void> | void {
    this.ensureOpen();
    this.ensureWritable();
    if (this.batching) {
      this._deleteSync(id);
      return;
    }
    return this.serialize(() => this._delete(id));
  }

  has(id: string): boolean {
    this.ensureOpen();
    return this.records.has(id);
  }

  all(): T[] {
    this.ensureOpen();
    return Array.from(this.records.values());
  }

  entries(): [string, T][] {
    this.ensureOpen();
    return Array.from(this.records.entries());
  }

  filter(predicate: (value: T, id: string) => boolean): T[] {
    this.ensureOpen();
    const results: T[] = [];
    for (const [id, value] of this.records) {
      if (predicate(value, id)) results.push(value);
    }
    return results;
  }

  /** Get read-only manifest info. Returns null if store is not open or no manifest exists. */
  getManifest(): ManifestInfo | null {
    const m = this.manifest;
    if (!m) return null;
    return {
      currentSnapshot: m.currentSnapshot,
      activeOps: m.activeOps,
      archiveSegments: m.archiveSegments,
      stats: m.stats,
    };
  }

  /**
   * Stream snapshot records without loading all into memory.
   * Yields [id, record] pairs from the current snapshot.
   * Requires store to be open (manifest must be read).
   */
  async *streamSnapshot(): AsyncGenerator<[string, T]> {
    this.ensureOpen();
    const manifest = this.manifest;
    if (!manifest) return;
    // Note: snapshot is monolithic JSON — must be fully parsed before yielding.
    // Consumer benefits from not accumulating all records (GC can reclaim yielded entries).
    // True streaming would require a JSONL snapshot format (future optimization).
    const snapshotData = await this.backend.loadSnapshot(manifest.currentSnapshot);
    for (const [id, record] of snapshotData.records) {
      yield [id, record as T];
    }
  }

  /**
   * Read WAL operations, optionally filtered to those after a given timestamp.
   * Returns ops in chronological order (by Lamport clock for multi-writer).
   * Does not modify the in-memory Map — consumer handles replay.
   */
  async *getWalOps(sinceTimestamp?: string): AsyncGenerator<Operation<T>> {
    this.ensureOpen();
    const manifest = this.manifest;
    if (!manifest) return;

    if (manifest.activeAgentOps) {
      // Multi-writer: must load all ops for merge-sort by (clock, agent)
      const allOps: Operation<T>[] = [];
      for (const opsPath of Object.values(manifest.activeAgentOps)) {
        const ops = (await this.backend.readOps(opsPath)) as Operation<T>[];
        allOps.push(...ops);
      }
      allOps.sort((a, b) => {
        const clockDiff = (a.clock ?? 0) - (b.clock ?? 0);
        if (clockDiff !== 0) return clockDiff;
        return (a.agent ?? "").localeCompare(b.agent ?? "");
      });
      for (const op of allOps) {
        if (sinceTimestamp && op.ts <= sinceTimestamp) continue;
        yield op;
      }
    } else {
      // Single-writer: yield directly from ops array (no extra accumulation)
      const ops = (await this.backend.readOps(manifest.activeOps)) as Operation<T>[];
      for (const op of ops) {
        if (sinceTimestamp && op.ts <= sinceTimestamp) continue;
        yield op;
      }
    }
  }

  count(predicate?: (value: T, id: string) => boolean): number {
    this.ensureOpen();
    if (!predicate) return this.records.size;
    let n = 0;
    for (const [id, value] of this.records) {
      if (predicate(value, id)) n++;
    }
    return n;
  }

  async batch(fn: () => void): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    return this.serialize(() => this._batch(fn));
  }

  async undo(): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    return this.serialize(() => this._undo());
  }

  getHistory(id: string): Operation<T>[] {
    this.ensureOpen();
    return this.ops.filter((op) => op.id === id);
  }

  getOps(since?: string): Operation<T>[] {
    this.ensureOpen();
    if (!since) return [...this.ops];
    return this.ops.filter((op) => op.ts > since);
  }

  async compact(): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this.coreOpts.skipLoad) {
      throw new Error("Cannot compact in skipLoad mode — in-memory Map is incomplete");
    }
    return this.serialize(() => this._compact());
  }

  async archive(
    predicate: (value: T, id: string) => boolean,
    segment?: string,
  ): Promise<number> {
    this.ensureOpen();
    this.ensureWritable();
    return this.serialize(() => this._archive(predicate, segment));
  }

  listArchiveSegments(): string[] {
    this.ensureOpen();
    return [...this.archiveSegments];
  }

  async loadArchive(segment: string): Promise<Map<string, T>> {
    this.ensureOpen();
    const segmentPath =
      this.archiveSegments.find(
        (s) => s === `archive/archive-${segment}.json`,
      ) || this.archiveSegments.find((s) => s.includes(segment));
    if (!segmentPath) throw new Error(`Archive segment '${segment}' not found`);
    return this.backend.loadArchiveSegment(segmentPath) as Promise<
      Map<string, T>
    >;
  }

  stats(): StoreStats {
    this.ensureOpen();
    return {
      activeRecords: this.records.size,
      opsCount: this.ops.length,
      archiveSegments: this.archiveSegments.length,
    };
  }

  /**
   * Reload state from the backend.
   * In multi-writer mode: re-reads manifest, snapshot, and all agent WAL files.
   * In single-writer/readOnly mode: re-reads the active ops file for new entries.
   * Use this to pick up writes from other agents or processes.
   */
  async refresh(): Promise<void> {
    this.ensureOpen();
    if (this.isMultiWriter()) {
      return this.serialize(() => this._refresh());
    }
    // Single-writer / readOnly: just tail the active ops file
    await this.tail();
  }

  // --- WAL tailing ---

  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchCallback: ((ops: Operation<T>[]) => void) | null = null;

  /**
   * Tail the WAL for new operations.
   * In single-writer/readOnly: re-reads the active ops file for new entries.
   * In multi-writer: re-reads ALL agent WAL files from the manifest.
   * Returns the newly applied operations.
   */
  async tail(): Promise<Operation<T>[]> {
    this.ensureOpen();
    const prevCount = this.ops.length;

    if (this.isMultiWriter()) {
      // Multi-writer: full refresh to pick up all agents' writes
      await this.serialize(() => this._refresh());
      // Return the difference
      if (this.ops.length > prevCount) {
        return this.ops.slice(prevCount);
      }
      return [];
    }

    // Single-writer / readOnly: just re-read our ops file
    const allOps = (await this.backend.readOps(this.activeOpsPath)) as Operation<T>[];
    if (allOps.length <= prevCount) return [];

    const newOps = allOps.slice(prevCount);
    for (const op of newOps) {
      this.applyOp(op);
    }
    this.ops.push(...newOps);

    return newOps;
  }

  /**
   * Watch for new operations on an interval.
   * Calls the callback with new operations whenever they appear.
   * @param callback Called with new operations
   * @param intervalMs Polling interval in milliseconds (default: 1000)
   */
  watch(callback: (ops: Operation<T>[]) => void, intervalMs = 1000): void {
    this.ensureOpen();
    if (this.watchTimer) this.unwatch();
    this.watchCallback = callback;
    this.watchTimer = setInterval(async () => {
      try {
        const newOps = await this.tail();
        if (newOps.length > 0 && this.watchCallback) {
          this.watchCallback(newOps);
        }
      } catch {
        // Silently ignore tail errors during watch
      }
    }, intervalMs);
  }

  /** Stop watching for new operations. */
  unwatch(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchCallback = null;
  }

  // --- Private mutation implementations ---

  private makeOp(
    type: "set" | "delete",
    id: string,
    data: T | undefined,
    prev: T | null,
  ): Operation<T> {
    const op: Operation<T> = {
      ts: new Date().toISOString(),
      op: type,
      id,
      prev,
    };
    if (type === "set") op.data = data;
    if (this.agentId) {
      op.agent = this.agentId;
      op.clock = this.clock!.tick();
    }

    // Try delta encoding for updates (not creates or deletes)
    if (type === "set" && prev !== null && data !== undefined) {
      const delta = createDelta(
        prev as Record<string, unknown>,
        data as Record<string, unknown>,
      );
      if (delta && isDeltaSmaller(delta, prev as Record<string, unknown>)) {
        op.prev = delta as unknown as T;
        op.encoding = "delta";
      }
    }

    return op;
  }

  private async _set(id: string, value: T): Promise<void> {
    const prev = this.records.get(id) ?? null;
    const op = this.makeOp("set", id, value, prev);
    this.records.set(id, value);
    await this.persistOp(op);
  }

  private _setSync(id: string, value: T): void {
    const prev = this.records.get(id) ?? null;
    const op = this.makeOp("set", id, value, prev);
    this.records.set(id, value);
    this.batchOps.push(op);
  }

  private async _delete(id: string): Promise<void> {
    const prev = this.records.get(id);
    if (prev === undefined) {
      throw new Error(`Record '${id}' not found`);
    }
    const op = this.makeOp("delete", id, undefined, prev);
    this.records.delete(id);
    await this.persistOp(op);
  }

  private _deleteSync(id: string): void {
    const prev = this.records.get(id);
    if (prev === undefined) {
      throw new Error(`Record '${id}' not found`);
    }
    const op = this.makeOp("delete", id, undefined, prev);
    this.records.delete(id);
    this.batchOps.push(op);
  }

  private async _batch(fn: () => void): Promise<void> {
    this.batching = true;
    this.batchOps = [];
    try {
      fn();
      if (this.batchOps.length > 0) {
        await this.backend.appendOps(
          this.activeOpsPath,
          this.batchOps as Operation[],
        );
        this.ops.push(...this.batchOps);
        if (this.ops.length >= this.coreOpts.checkpointThreshold) {
          await this._compact();
        }
      }
    } catch (err) {
      for (const op of this.batchOps.reverse()) {
        try {
          this.reverseOp(op);
        } catch (rollbackErr) {
          console.error(
            "opslog: rollback failed for op",
            op.id,
            rollbackErr,
          );
        }
      }
      throw err;
    } finally {
      this.batching = false;
      this.batchOps = [];
    }
  }

  private async _undo(): Promise<boolean> {
    if (this.isMultiWriter()) {
      return this._undoMultiWriter();
    }

    // Single-writer: O(1) undo
    if (this.ops.length === 0) return false;
    const lastOp = this.ops[this.ops.length - 1];
    this.reverseOp(lastOp);
    this.ops.pop();
    await this.backend.truncateLastOp(this.activeOpsPath);
    return true;
  }

  private async _undoMultiWriter(): Promise<boolean> {
    // Find last op from this agent
    const myOps = this.ops.filter((op) => op.agent === this.agentId);
    if (myOps.length === 0) return false;

    // Truncate our WAL file
    await this.backend.truncateLastOp(this.activeOpsPath);

    // Re-derive state from scratch (correct but O(n))
    await this._refresh();
    return true;
  }

  private async _compact(): Promise<void> {
    // Flush group buffer before checkpoint
    if (this.groupCommit) await this.flushGroupBuffer();

    if (this.isMultiWriter()) {
      await this._compactMultiWriter();
      return;
    }

    // Single-writer compaction
    const snapshotPath = await this.backend.writeSnapshot(
      this.records as Map<string, unknown>,
      this.version,
    );
    const opsPath = await this.backend.createOpsFile();

    const updatedManifest: Manifest = {
      version: this.version,
      currentSnapshot: snapshotPath,
      activeOps: opsPath,
      archiveSegments: this.archiveSegments,
      stats: {
        activeRecords: this.records.size,
        archivedRecords: this.archivedRecordCount,
        opsCount: 0,
        created: this.created,
        lastCheckpoint: new Date().toISOString(),
      },
    };
    await this.backend.writeManifest(updatedManifest);
    this.activeOpsPath = opsPath;
    this.ops = [];
  }

  private async _compactMultiWriter(): Promise<void> {
    let compactLock: LockHandle;
    try {
      compactLock = await this.backend.acquireCompactionLock();
    } catch {
      // Another agent is compacting — skip
      return;
    }

    try {
      const snapshotPath = await this.backend.writeSnapshot(
        this.records as Map<string, unknown>,
        this.version,
      );
      const opsPath = await this.backend.createAgentOpsFile(this.agentId!);

      const updatedManifest: Manifest = {
        version: this.version,
        currentSnapshot: snapshotPath,
        activeOps: opsPath,
        activeAgentOps: { [this.agentId!]: opsPath },
        archiveSegments: this.archiveSegments,
        stats: {
          activeRecords: this.records.size,
          archivedRecords: this.archivedRecordCount,
          opsCount: 0,
          created: this.created,
          lastCheckpoint: new Date().toISOString(),
        },
      };
      await this.backend.writeManifest(updatedManifest);
      this.activeOpsPath = opsPath;
      this.ops = [];
      this.manifestVersion = await this.backend.getManifestVersion();
    } finally {
      await this.backend.releaseCompactionLock(compactLock);
    }
  }

  private async _archive(
    predicate: (value: T, id: string) => boolean,
    segment?: string,
  ): Promise<number> {
    const toArchive = new Map<string, T>();
    for (const [id, value] of this.records) {
      if (predicate(value, id)) toArchive.set(id, value);
    }
    if (toArchive.size === 0) return 0;

    const period = segment ?? this.defaultPeriod();
    const segmentPath = await this.backend.writeArchiveSegment(
      period,
      toArchive as Map<string, unknown>,
    );
    if (!this.archiveSegments.includes(segmentPath)) {
      this.archiveSegments.push(segmentPath);
    }

    for (const id of toArchive.keys()) {
      this.records.delete(id);
    }
    this.archivedRecordCount += toArchive.size;

    await this._compact();
    return toArchive.size;
  }

  private async _refresh(): Promise<void> {
    const manifest = await this.backend.readManifest();
    if (!manifest) throw new Error("Manifest not found during refresh");

    const { records, version } = await this.backend.loadSnapshot(
      manifest.currentSnapshot,
    );
    this.records = records as Map<string, T>;
    this.version = version;
    this.archiveSegments = manifest.archiveSegments;
    this.archivedRecordCount = manifest.stats.archivedRecords;
    this.created = manifest.stats.created;

    // Read all agent ops
    const allOps: Operation<T>[] = [];
    if (manifest.activeAgentOps) {
      for (const opsPath of Object.values(manifest.activeAgentOps)) {
        const ops = await this.backend.readOps(opsPath);
        allOps.push(...(ops as Operation<T>[]));
      }
    }
    // Legacy single-writer ops
    if (manifest.activeOps && !manifest.activeAgentOps) {
      const ops = await this.backend.readOps(manifest.activeOps);
      allOps.push(...(ops as Operation<T>[]));
    }

    // Merge-sort
    allOps.sort((a, b) => {
      const clockDiff = (a.clock ?? 0) - (b.clock ?? 0);
      if (clockDiff !== 0) return clockDiff;
      return (a.agent ?? "").localeCompare(b.agent ?? "");
    });

    for (const op of allOps) this.applyOp(op);
    this.ops = allOps;

    // Update clock
    const maxClock = allOps.reduce(
      (max, op) => Math.max(max, op.clock ?? 0),
      0,
    );
    this.clock = new LamportClock(maxClock);

    // Update our ops path if manifest changed
    if (manifest.activeAgentOps?.[this.agentId!]) {
      this.activeOpsPath = manifest.activeAgentOps[this.agentId!];
    } else {
      // Our ops file is not in the manifest (compaction happened)
      this.activeOpsPath = await this.backend.createAgentOpsFile(
        this.agentId!,
      );
      const updatedManifest: Manifest = {
        ...manifest,
        activeAgentOps: {
          ...(manifest.activeAgentOps ?? {}),
          [this.agentId!]: this.activeOpsPath,
        },
      };
      await this.backend.writeManifest(updatedManifest);
    }

    this.manifestVersion = await this.backend.getManifestVersion();
  }

  // --- Helpers ---

  private ensureOpen(): void {
    if (!this.opened) throw new Error("Store is not open. Call open() first.");
  }

  private ensureWritable(): void {
    if (this.coreOpts.readOnly)
      throw new Error("Store is read-only. Cannot perform mutations.");
  }

  private applyOp(op: Operation<T>): void {
    if (op.op === "set" && op.data !== undefined) {
      this.records.set(op.id, op.data);
    } else if (op.op === "delete") {
      this.records.delete(op.id);
    }
  }

  private reverseOp(op: Operation<T>): void {
    if (op.prev === null) {
      // Was a create — reverse by deleting
      this.records.delete(op.id);
    } else if (op.encoding === "delta") {
      // Delta-encoded: apply the reverse patch to the current record
      const current = this.records.get(op.id);
      if (current) {
        const restored = applyDelta(
          current as Record<string, unknown>,
          op.prev as unknown as DeltaPatch,
        );
        this.records.set(op.id, restored as T);
      }
    } else if (op.op === "delete") {
      // Was a delete — reverse by restoring full prev
      this.records.set(op.id, op.prev);
    } else {
      // Was an update — reverse by restoring full prev
      this.records.set(op.id, op.prev);
    }
  }

  private async persistOp(op: Operation<T>): Promise<void> {
    this.ops.push(op);

    if (this.groupCommit) {
      // Buffer the op, flush when buffer is full or timer fires
      this.groupBuffer.push(op);
      if (this.groupBuffer.length >= this.groupSize) {
        if (this.asyncMode) {
          // Async: trigger flush in background, don't await
          this.serialize(() => this.flushGroupBuffer()).catch(() => {});
        } else {
          await this.flushGroupBuffer();
        }
      } else if (!this.groupTimer) {
        this.groupTimer = setTimeout(() => {
          this.serialize(() => this.flushGroupBuffer()).catch(() => {});
        }, this.groupMs);
      }
      // Async mode: return immediately without waiting for disk I/O
      if (this.asyncMode) return;
    } else {
      // Immediate: write to disk now
      await this.backend.appendOps(this.activeOpsPath, [op as Operation]);
    }

    if (this.ops.length >= this.coreOpts.checkpointThreshold) {
      await this._compact();
    }
  }

  /**
   * Flush buffered ops to disk in a single write.
   * In group/async mode: drains the in-memory buffer to disk.
   * Safe to call at any time. No-op if nothing is buffered.
   */
  async flush(): Promise<void> {
    if (!this.groupCommit || this.groupBuffer.length === 0) return;
    return this.serialize(() => this.flushGroupBuffer());
  }

  /**
   * Ensure all buffered operations are durably persisted to disk.
   * Alias for flush(). Use before process exit when using async write mode
   * to prevent data loss.
   */
  async sync(): Promise<void> {
    return this.flush();
  }

  private async flushGroupBuffer(): Promise<void> {
    if (this.groupBuffer.length === 0) return;
    if (this.groupTimer) {
      clearTimeout(this.groupTimer);
      this.groupTimer = null;
    }
    await this.backend.appendOps(
      this.activeOpsPath,
      this.groupBuffer as Operation[],
    );
    this.groupBuffer = [];
  }

  private defaultPeriod(): string {
    const now = new Date();
    const q = Math.ceil((now.getMonth() + 1) / 3);
    return `${now.getFullYear()}-Q${q}`;
  }
}
