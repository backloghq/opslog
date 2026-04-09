/**
 * Delta encoding for operations.
 * Instead of storing the full previous record, store only the diff.
 *
 * Uses a simplified JSON Patch-like format:
 * - Only tracks changed/added/removed top-level keys
 * - prev becomes a patch object: { $set: {...}, $unset: [...] }
 */

export interface DeltaPatch {
  /** Fields that were changed or added (old values). */
  $set?: Record<string, unknown>;
  /** Fields that were removed. */
  $unset?: string[];
}

/**
 * Create a delta patch from an old record to a new record.
 * The patch, when applied to the new record, produces the old record.
 * This is the "reverse patch" — stored as `prev` so undo can apply it.
 */
export function createDelta(
  oldRecord: Record<string, unknown> | null,
  newRecord: Record<string, unknown>,
): DeltaPatch | null {
  if (oldRecord === null) return null; // Create operation — no previous

  const patch: DeltaPatch = {};
  const $set: Record<string, unknown> = {};
  const $unset: string[] = [];

  // Fields in old that differ from new (changed or removed in new)
  for (const [key, oldVal] of Object.entries(oldRecord)) {
    if (!(key in newRecord)) {
      // Field was removed in new → to restore old, we need to $set it
      $set[key] = oldVal;
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newRecord[key])) {
      // Field changed → store old value
      $set[key] = oldVal;
    }
  }

  // Fields in new that weren't in old (added in new)
  for (const key of Object.keys(newRecord)) {
    if (!(key in oldRecord)) {
      // Field was added in new → to restore old, we need to $unset it
      $unset.push(key);
    }
  }

  if (Object.keys($set).length > 0) patch.$set = $set;
  if ($unset.length > 0) patch.$unset = $unset;

  // If no changes, return empty patch
  if (!patch.$set && !patch.$unset) return null;
  return patch;
}

/**
 * Apply a delta patch to a record to produce the previous version.
 * Used during undo: apply the reverse patch to current record → get old record.
 */
export function applyDelta(
  record: Record<string, unknown>,
  patch: DeltaPatch,
): Record<string, unknown> {
  const result = { ...record };

  if (patch.$set) {
    for (const [key, val] of Object.entries(patch.$set)) {
      result[key] = val;
    }
  }
  if (patch.$unset) {
    for (const key of patch.$unset) {
      delete result[key];
    }
  }

  return result;
}

/**
 * Check if a delta patch is smaller than the full record.
 * Used to decide whether to use delta or full encoding.
 */
export function isDeltaSmaller(
  patch: DeltaPatch | null,
  fullRecord: Record<string, unknown> | null,
): boolean {
  if (patch === null || fullRecord === null) return false;
  const patchSize = JSON.stringify(patch).length;
  const fullSize = JSON.stringify(fullRecord).length;
  return patchSize < fullSize;
}
