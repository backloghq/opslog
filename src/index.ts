export { Store } from "./store.js";
export { FsBackend } from "./backend.js";
export { LamportClock } from "./clock.js";
export { createDelta, applyDelta, isDeltaSmaller } from "./delta.js";
export type { DeltaPatch } from "./delta.js";
export { acquireLock, releaseLock } from "./lock.js";
export {
  validateOp,
  validateManifest,
  validateSnapshot,
  validateArchiveSegment,
} from "./validate.js";
export type {
  Operation,
  Snapshot,
  Manifest,
  ManifestStats,
  ArchiveSegment,
  StoreOptions,
  StoreStats,
  StorageBackend,
  LockHandle,
} from "./types.js";
