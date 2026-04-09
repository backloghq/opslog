import { mkdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Operation, StoreOptions, StoreStats } from "./types.js";
import { appendOp, appendOps, readOps, truncateLastOp } from "./wal.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";
import {
  createDefaultManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
import {
  loadArchiveSegment,
  writeArchiveSegment,
} from "./archive.js";
import { acquireLock, releaseLock } from "./lock.js";

export class Store<T = Record<string, unknown>> {
  private dir = "";
  private records = new Map<string, T>();
  private ops: Operation<T>[] = [];
  private archiveSegments: string[] = [];
  private opened = false;
  private version = 1;
  private activeOpsPath = "";
  private created = "";
  private options: Required<StoreOptions> = {
    checkpointThreshold: 100,
    checkpointOnClose: true,
    version: 1,
    migrate: (r) => r as T,
  };
  private archivedRecordCount = 0;
  private batching = false;
  private batchOps: Operation<T>[] = [];
  private _lock: Promise<void> = Promise.resolve();
  private lockFh: FileHandle | null = null;

  /**
   * Serialize all state-mutating operations through a promise chain.
   * This prevents interleaving of async mutations (e.g. compact + set,
   * undo + set) which could corrupt the WAL or in-memory state.
   * Read operations remain synchronous and lock-free.
   */
  private serialize<R>(fn: () => Promise<R>): Promise<R> {
    const prev = this._lock;
    let resolve!: () => void;
    this._lock = new Promise<void>((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(() => resolve());
  }

  async open(dir: string, options?: StoreOptions): Promise<void> {
    this.dir = dir;
    if (options) {
      this.options = { ...this.options, ...options };
    }

    await mkdir(join(dir, "snapshots"), { recursive: true });
    await mkdir(join(dir, "ops"), { recursive: true });
    await mkdir(join(dir, "archive"), { recursive: true });

    this.lockFh = await acquireLock(dir);

    const manifest = await readManifest(dir);

    if (!manifest) {
      // Fresh store — create empty snapshot and manifest
      const snapshotPath = await writeSnapshot(dir, new Map(), this.options.version);
      const opsFilename = `ops-${Date.now()}.jsonl`;
      const opsPath = `ops/${opsFilename}`;
      await writeFile(join(dir, opsPath), "", "utf-8");
      const newManifest = createDefaultManifest(snapshotPath, opsPath);
      await writeManifest(dir, newManifest);
      this.version = this.options.version;
      this.activeOpsPath = opsPath;
      this.created = newManifest.stats.created;
      this.archiveSegments = [];
    } else {
      // Load existing state
      let snapshotData: { records: Map<string, T>; version: number };
      try {
        snapshotData = await loadSnapshot<T>(dir, manifest.currentSnapshot);
      } catch (err) {
        const isNotFound = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
        if (isNotFound) {
          throw new Error(`Snapshot file not found: ${manifest.currentSnapshot}. The data directory may be corrupted.`, { cause: err });
        }
        throw err;
      }
      const { records, version: storedVersion } = snapshotData;
      this.records = records;
      this.version = storedVersion;
      this.activeOpsPath = manifest.activeOps;
      this.created = manifest.stats.created;
      this.archiveSegments = manifest.archiveSegments;
      this.archivedRecordCount = manifest.stats.archivedRecords;

      // Migrate if needed
      if (storedVersion < this.options.version) {
        for (const [id, record] of this.records) {
          this.records.set(
            id,
            this.options.migrate(record, storedVersion) as T,
          );
        }
        this.version = this.options.version;
      }

      // Replay ops
      const ops = await readOps<T>(join(dir, manifest.activeOps));
      for (const op of ops) {
        this.applyOp(op);
      }
      this.ops = ops;
    }

    this.opened = true;
  }

  async close(): Promise<void> {
    this.ensureOpen();
    if (this.options.checkpointOnClose && this.ops.length > 0) {
      await this.serialize(() => this._compact());
    }
    if (this.lockFh) {
      await releaseLock(this.dir, this.lockFh);
      this.lockFh = null;
    }
    this.opened = false;
  }

  get(id: string): T | undefined {
    this.ensureOpen();
    return this.records.get(id);
  }

  set(id: string, value: T): Promise<void> | void {
    this.ensureOpen();
    if (this.batching) {
      this._setSync(id, value);
      return;
    }
    return this.serialize(() => this._set(id, value));
  }

  delete(id: string): Promise<void> | void {
    this.ensureOpen();
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
    return this.serialize(() => this._batch(fn));
  }

  async undo(): Promise<boolean> {
    this.ensureOpen();
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
    return this.serialize(() => this._compact());
  }

  async archive(
    predicate: (value: T, id: string) => boolean,
    segment?: string,
  ): Promise<number> {
    this.ensureOpen();
    return this.serialize(() => this._archive(predicate, segment));
  }

  listArchiveSegments(): string[] {
    this.ensureOpen();
    return [...this.archiveSegments];
  }

  async loadArchive(segment: string): Promise<Map<string, T>> {
    this.ensureOpen();
    const segmentPath = this.archiveSegments.find((s) => s === `archive/archive-${segment}.json`) || this.archiveSegments.find((s) => s.includes(segment));
    if (!segmentPath) throw new Error(`Archive segment '${segment}' not found`);
    return loadArchiveSegment(this.dir, segmentPath);
  }

  stats(): StoreStats {
    this.ensureOpen();
    return {
      activeRecords: this.records.size,
      opsCount: this.ops.length,
      archiveSegments: this.archiveSegments.length,
    };
  }

  // --- Private mutation implementations ---

  private async _set(id: string, value: T): Promise<void> {
    const prev = this.records.get(id) ?? null;
    const op: Operation<T> = {
      ts: new Date().toISOString(),
      op: "set",
      id,
      data: value,
      prev,
    };
    this.records.set(id, value);
    await this.persistOp(op);
  }

  private _setSync(id: string, value: T): void {
    const prev = this.records.get(id) ?? null;
    const op: Operation<T> = {
      ts: new Date().toISOString(),
      op: "set",
      id,
      data: value,
      prev,
    };
    this.records.set(id, value);
    this.batchOps.push(op);
  }

  private async _delete(id: string): Promise<void> {
    const prev = this.records.get(id);
    if (prev === undefined) {
      throw new Error(`Record '${id}' not found`);
    }
    const op: Operation<T> = {
      ts: new Date().toISOString(),
      op: "delete",
      id,
      prev,
    };
    this.records.delete(id);
    await this.persistOp(op);
  }

  private _deleteSync(id: string): void {
    const prev = this.records.get(id);
    if (prev === undefined) {
      throw new Error(`Record '${id}' not found`);
    }
    const op: Operation<T> = {
      ts: new Date().toISOString(),
      op: "delete",
      id,
      prev,
    };
    this.records.delete(id);
    this.batchOps.push(op);
  }

  private async _batch(fn: () => void): Promise<void> {
    this.batching = true;
    this.batchOps = [];
    try {
      fn();
      // Empty batches are no-ops — no I/O if fn() didn't call set/delete
      if (this.batchOps.length > 0) {
        await appendOps(join(this.dir, this.activeOpsPath), this.batchOps);
        this.ops.push(...this.batchOps);
        if (this.ops.length >= this.options.checkpointThreshold) {
          await this._compact();
        }
      }
    } catch (err) {
      // Rollback in-memory changes on failure
      for (const op of this.batchOps.reverse()) {
        try {
          this.reverseOp(op);
        } catch (rollbackErr) {
          console.error("opslog: rollback failed for op", op.id, rollbackErr);
        }
      }
      throw err;
    } finally {
      this.batching = false;
      this.batchOps = [];
    }
  }

  private async _undo(): Promise<boolean> {
    if (this.ops.length === 0) return false;

    const lastOp = this.ops[this.ops.length - 1];
    this.reverseOp(lastOp);
    this.ops.pop();

    await truncateLastOp(join(this.dir, this.activeOpsPath));

    return true;
  }

  private async _compact(): Promise<void> {
    const snapshotPath = await writeSnapshot(this.dir, this.records, this.version);
    const opsFilename = `ops-${Date.now()}.jsonl`;
    const opsPath = `ops/${opsFilename}`;
    await writeFile(join(this.dir, opsPath), "", "utf-8");

    const updatedManifest = {
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
    await writeManifest(this.dir, updatedManifest);
    this.activeOpsPath = opsPath;
    this.ops = [];
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
    const segmentPath = await writeArchiveSegment(this.dir, period, toArchive);
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

  // --- Helpers ---

  private ensureOpen(): void {
    if (!this.opened) throw new Error("Store is not open. Call open() first.");
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
    } else if (op.op === "delete") {
      // Was a delete — reverse by restoring
      this.records.set(op.id, op.prev);
    } else {
      // Was an update — reverse by restoring prev
      this.records.set(op.id, op.prev);
    }
  }

  private async persistOp(op: Operation<T>): Promise<void> {
    await appendOp(join(this.dir, this.activeOpsPath), op);
    this.ops.push(op);
    if (this.ops.length >= this.options.checkpointThreshold) {
      await this._compact();
    }
  }

  private defaultPeriod(): string {
    const now = new Date();
    const q = Math.ceil((now.getMonth() + 1) / 3);
    return `${now.getFullYear()}-Q${q}`;
  }
}
