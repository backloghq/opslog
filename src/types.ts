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
}

export interface StoreStats {
  activeRecords: number;
  opsCount: number;
  archiveSegments: number;
}
