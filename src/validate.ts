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
  if (typeof obj.version !== "number") throw new Error("Invalid manifest: missing version");
  if (typeof obj.currentSnapshot !== "string") throw new Error("Invalid manifest: missing currentSnapshot");
  if (typeof obj.activeOps !== "string") throw new Error("Invalid manifest: missing activeOps");
  return raw as Manifest;
}

export function validateSnapshot<T>(raw: unknown): Snapshot<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid snapshot: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number") throw new Error("Invalid snapshot: missing version");
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
  if (typeof obj.version !== "number") throw new Error("Invalid archive segment: missing version");
  if (typeof obj.period !== "string") throw new Error("Invalid archive segment: missing period");
  if (typeof obj.records !== "object" || obj.records === null || Array.isArray(obj.records)) {
    throw new Error("Invalid archive segment: records must be an object");
  }
  return raw as ArchiveSegment<T>;
}
