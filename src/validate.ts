import type { Operation, Manifest, Snapshot, ArchiveSegment } from "./types.js";

export function validateOp<T>(raw: unknown): Operation<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid operation: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ts !== "string") throw new Error("Invalid operation: missing ts");
  if (obj.op !== "set" && obj.op !== "delete") {
    throw new Error(`Invalid operation: unknown op "${obj.op}"`);
  }
  if (typeof obj.id !== "string") throw new Error("Invalid operation: missing id");
  return raw as Operation<T>;
}

export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid manifest: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid manifest: version must be a positive integer");
  }
  if (typeof obj.currentSnapshot !== "string") throw new Error("Invalid manifest: missing currentSnapshot");
  if (typeof obj.activeOps !== "string") throw new Error("Invalid manifest: missing activeOps");
  if (!Array.isArray(obj.archiveSegments)) throw new Error("Invalid manifest: archiveSegments must be an array");
  if (typeof obj.stats !== "object" || obj.stats === null || Array.isArray(obj.stats)) {
    throw new Error("Invalid manifest: missing stats");
  }
  const stats = obj.stats as Record<string, unknown>;
  if (typeof stats.activeRecords !== "number") throw new Error("Invalid manifest: stats.activeRecords must be a number");
  if (typeof stats.archivedRecords !== "number") throw new Error("Invalid manifest: stats.archivedRecords must be a number");
  if (typeof stats.opsCount !== "number") throw new Error("Invalid manifest: stats.opsCount must be a number");
  if (typeof stats.created !== "string") throw new Error("Invalid manifest: stats.created must be a string");
  if (typeof stats.lastCheckpoint !== "string") throw new Error("Invalid manifest: stats.lastCheckpoint must be a string");
  return raw as Manifest;
}

export function validateSnapshot<T>(raw: unknown): Snapshot<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid snapshot: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid snapshot: version must be a positive integer");
  }
  if (typeof obj.timestamp !== "string") throw new Error("Invalid snapshot: missing timestamp");
  if (typeof obj.records !== "object" || obj.records === null || Array.isArray(obj.records)) {
    throw new Error("Invalid snapshot: records must be an object");
  }
  return raw as Snapshot<T>;
}

export function validateArchiveSegment<T>(raw: unknown): ArchiveSegment<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid archive segment: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid archive segment: version must be a positive integer");
  }
  if (typeof obj.period !== "string") throw new Error("Invalid archive segment: missing period");
  if (typeof obj.timestamp !== "string") throw new Error("Invalid archive segment: missing timestamp");
  if (typeof obj.records !== "object" || obj.records === null || Array.isArray(obj.records)) {
    throw new Error("Invalid archive segment: records must be an object");
  }
  return raw as ArchiveSegment<T>;
}
