import type { Operation, Manifest, Snapshot, ArchiveSegment } from "./types.js";

export function validateOp<T>(raw: unknown): Operation<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid operation: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ts !== "string" || obj.ts.length === 0) throw new Error("Invalid operation: ts must be a non-empty string");
  if (typeof obj.op !== "string" || (obj.op !== "set" && obj.op !== "delete")) {
    throw new Error(`Invalid operation: op must be "set" or "delete", got "${obj.op}"`);
  }
  if (typeof obj.id !== "string" || obj.id.length === 0) throw new Error("Invalid operation: id must be a non-empty string");
  if (!("prev" in obj)) throw new Error("Invalid operation: missing prev");
  if (obj.prev !== null && (typeof obj.prev !== "object" || Array.isArray(obj.prev))) {
    throw new Error("Invalid operation: prev must be an object or null");
  }
  if (obj.op === "set" && (!("data" in obj) || obj.data === null)) throw new Error("Invalid operation: set op must have non-null data");
  if (obj.op === "delete" && obj.prev === null) throw new Error("Invalid operation: delete op must have non-null prev");
  if (obj.op === "delete" && "data" in obj) throw new Error("Invalid operation: delete op must not have data field");
  if ("encoding" in obj && obj.encoding !== "full" && obj.encoding !== "delta") {
    throw new Error(`Invalid operation: encoding must be "full" or "delta", got "${obj.encoding}"`);
  }
  return raw as Operation<T>;
}

export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid manifest: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isFinite(obj.version) || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid manifest: version must be a positive finite integer");
  }
  if (typeof obj.currentSnapshot !== "string" || obj.currentSnapshot.length === 0) throw new Error("Invalid manifest: missing currentSnapshot");
  if (typeof obj.activeOps !== "string" || obj.activeOps.length === 0) throw new Error("Invalid manifest: missing activeOps");
  if (!Array.isArray(obj.archiveSegments)) throw new Error("Invalid manifest: archiveSegments must be an array");
  for (const seg of obj.archiveSegments) {
    if (typeof seg !== "string" || seg.length === 0) throw new Error("Invalid manifest: archiveSegments entries must be non-empty strings");
  }
  if (typeof obj.stats !== "object" || obj.stats === null || Array.isArray(obj.stats)) {
    throw new Error("Invalid manifest: missing stats");
  }
  const stats = obj.stats as Record<string, unknown>;
  if (typeof stats.activeRecords !== "number" || !Number.isFinite(stats.activeRecords) || !Number.isInteger(stats.activeRecords) || stats.activeRecords < 0) throw new Error("Invalid manifest: stats.activeRecords must be a non-negative integer");
  if (typeof stats.archivedRecords !== "number" || !Number.isFinite(stats.archivedRecords) || !Number.isInteger(stats.archivedRecords) || stats.archivedRecords < 0) throw new Error("Invalid manifest: stats.archivedRecords must be a non-negative integer");
  if (typeof stats.opsCount !== "number" || !Number.isFinite(stats.opsCount) || !Number.isInteger(stats.opsCount) || stats.opsCount < 0) throw new Error("Invalid manifest: stats.opsCount must be a non-negative integer");
  if (typeof stats.created !== "string" || stats.created.length === 0) throw new Error("Invalid manifest: stats.created must be a non-empty string");
  if (typeof stats.lastCheckpoint !== "string" || stats.lastCheckpoint.length === 0) throw new Error("Invalid manifest: stats.lastCheckpoint must be a non-empty string");
  return raw as Manifest;
}

export function validateSnapshot<T>(raw: unknown): Snapshot<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid snapshot: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isFinite(obj.version) || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid snapshot: version must be a positive finite integer");
  }
  if (typeof obj.timestamp !== "string" || obj.timestamp.length === 0) throw new Error("Invalid snapshot: timestamp must be a non-empty string");
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
  if (typeof obj.version !== "number" || !Number.isFinite(obj.version) || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error("Invalid archive segment: version must be a positive finite integer");
  }
  if (typeof obj.period !== "string" || obj.period.length === 0) throw new Error("Invalid archive segment: period must be a non-empty string");
  if (typeof obj.timestamp !== "string" || obj.timestamp.length === 0) throw new Error("Invalid archive segment: timestamp must be a non-empty string");
  if (typeof obj.records !== "object" || obj.records === null || Array.isArray(obj.records)) {
    throw new Error("Invalid archive segment: records must be an object");
  }
  return raw as ArchiveSegment<T>;
}
