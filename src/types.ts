export interface Operation<T = Record<string, unknown>> {
  /** ISO 8601 timestamp */
  ts: string;
  /** Operation type */
  op: "set" | "delete";
  /** Record ID */
  id: string;
  /** New value (present for set operations) */
  data?: T;
  /** Previous value (null for creates, full record for updates/deletes) */
  prev: T | null;
  /** Encoding format for prev field. Omitted or "full" = full record. "delta" = JSON Patch (future). */
  encoding?: "full" | "delta";
  /** Agent ID (present in multi-writer mode) */
  agent?: string;
  /** Lamport clock value (present in multi-writer mode) */
  clock?: number;
}

export interface Snapshot<T = Record<string, unknown>> {
  version: number;
  timestamp: string;
  records: Record<string, T>;
}

export interface Manifest {
  version: number;
  currentSnapshot: string;
  activeOps: string;
  /** Per-agent ops file paths (multi-writer mode). Keys are agent IDs. */
  activeAgentOps?: Record<string, string>;
  archiveSegments: string[];
  stats: ManifestStats;
}

export interface ManifestStats {
  activeRecords: number;
  archivedRecords: number;
  opsCount: number;
  created: string;
  lastCheckpoint: string;
}

export interface ArchiveSegment<T = Record<string, unknown>> {
  version: number;
  period: string;
  timestamp: string;
  records: Record<string, T>;
}

export interface StoreOptions {
  /** Auto-checkpoint after this many operations (default: 100) */
  checkpointThreshold?: number;
  /** Checkpoint on close (default: true) */
  checkpointOnClose?: boolean;
  /** Schema version for migration (default: 1) */
  version?: number;
  /** Migration function: called if stored version < current version */
  migrate?: (record: unknown, fromVersion: number) => unknown;
  /** Open in read-only mode: skips directory lock, rejects all mutations. */
  readOnly?: boolean;
  /** Storage backend implementation (default: FsBackend). */
  backend?: StorageBackend;
  /** Agent ID for multi-writer mode. Enables per-agent WAL streams and LWW conflict resolution. */
  agentId?: string;
  /** Write mode: "immediate" flushes every op (default, safe for multi-writer). "group" buffers ops and flushes periodically (~50x faster writes). Forced to "immediate" when agentId is set. */
  writeMode?: "immediate" | "group";
  /** Group commit: max ops to buffer before flush (default: 50). Only used when writeMode is "group". */
  groupCommitSize?: number;
  /** Group commit: max milliseconds before flush (default: 100). Only used when writeMode is "group". */
  groupCommitMs?: number;
}

export interface StoreStats {
  activeRecords: number;
  opsCount: number;
  archiveSegments: number;
}

/** Opaque lock handle returned by StorageBackend locking methods. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LockHandle {}

/** Pluggable storage backend for opslog. */
export interface StorageBackend {
  /** Initialize the backend (create directories, etc.). Called once during store.open(). */
  initialize(dir: string, opts: { readOnly: boolean }): Promise<void>;
  /** Shut down the backend. Called during store.close(). */
  shutdown(): Promise<void>;

  // -- Manifest --
  readManifest(): Promise<Manifest | null>;
  writeManifest(manifest: Manifest): Promise<void>;

  // -- Snapshots (immutable, write-once) --
  writeSnapshot(records: Map<string, unknown>, version: number): Promise<string>;
  loadSnapshot(relativePath: string): Promise<{ records: Map<string, unknown>; version: number }>;

  // -- WAL (ordered operation log) --
  appendOps(relativePath: string, ops: Operation[]): Promise<void>;
  readOps(relativePath: string): Promise<Operation[]>;
  truncateLastOp(relativePath: string): Promise<boolean>;
  createOpsFile(): Promise<string>;

  // -- Archive --
  writeArchiveSegment(period: string, records: Map<string, unknown>): Promise<string>;
  loadArchiveSegment(relativePath: string): Promise<Map<string, unknown>>;
  listArchiveSegments(): Promise<string[]>;

  // -- Locking (single-writer) --
  acquireLock(): Promise<LockHandle>;
  releaseLock(handle: LockHandle): Promise<void>;

  // -- Multi-writer extensions --
  createAgentOpsFile(agentId: string): Promise<string>;
  listOpsFiles(): Promise<string[]>;
  acquireCompactionLock(): Promise<LockHandle>;
  releaseCompactionLock(handle: LockHandle): Promise<void>;
  getManifestVersion(): Promise<string | null>;
}
