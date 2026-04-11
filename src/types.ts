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

/** Read-only manifest info exposed to consumers via store.getManifest(). */
export interface ManifestInfo {
  readonly currentSnapshot: string;
  readonly activeOps: string;
  readonly archiveSegments: readonly string[];
  readonly stats: Readonly<ManifestStats>;
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
  /** Skip loading snapshot and replaying WAL into memory. Store opens for writes only — reads return empty. For consumers that manage their own read path (e.g. Parquet-backed storage). */
  skipLoad?: boolean;
  /** Storage backend implementation (default: FsBackend). */
  backend?: StorageBackend;
  /** Agent ID for multi-writer mode. Enables per-agent WAL streams and LWW conflict resolution. */
  agentId?: string;
  /** Write mode: "immediate" flushes every op (default, safe for multi-writer). "group" buffers ops and flushes periodically (~12x faster writes). "async" buffers ops and resolves immediately without waiting for flush (~50x faster, data lost on crash). Forced to "immediate" when agentId is set. */
  writeMode?: "immediate" | "group" | "async";
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

  // -- Blob storage (files outside the WAL) --
  /** Write a blob at a relative path. Creates directories as needed. */
  writeBlob(relativePath: string, content: Buffer): Promise<void>;
  /** Read a blob from a relative path. */
  readBlob(relativePath: string): Promise<Buffer>;
  /** Read a byte range from a blob. For O(1) point lookups in record stores. */
  readBlobRange(relativePath: string, offset: number, length: number): Promise<Buffer>;
  /** List blob names under a prefix directory. */
  listBlobs(prefix: string): Promise<string[]>;
  /** Delete a single blob. */
  deleteBlob(relativePath: string): Promise<void>;
  /** Delete all blobs under a prefix directory. */
  deleteBlobDir(prefix: string): Promise<void>;
}
