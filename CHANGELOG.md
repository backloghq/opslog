# Changelog

## 0.2.0 (2026-04-09)

### Added
- **Async mutation serializer** — promise-chain mutex serializes all state-mutating operations (`set`, `delete`, `batch`, `undo`, `compact`, `archive`). Prevents interleaving of concurrent async mutations that could corrupt the WAL or in-memory state. Read operations remain synchronous and lock-free.
- **Advisory directory write lock** — `store.open()` acquires a lockfile (`.lock` with PID). Prevents two processes from opening the same store directory. Stale locks from crashed processes are automatically recovered.
- **Delta encoding format field** — `Operation` type now accepts an optional `encoding` field (`"full"` | `"delta"`). Currently only `"full"` is used. Prepares the format for future delta-encoded `prev` fields without requiring a migration.

### Changed
- **`truncateLastOp` rewritten with `ftruncate()`** — O(1) instead of O(n). Reads max 4KB from the end of the file to find the truncation point, then truncates via atomic POSIX syscall. Handles operations larger than 4KB by reading in chunks.

## 0.1.4 (2026-04-07)

### Fixed
- **Infinity/NaN in numeric validators** — all numeric fields now require `Number.isFinite()`; `Infinity` and `NaN` are rejected
- **Operation validation** — `validateOp()` now requires `prev` field (object or null), `data` field on set ops (non-null), enforces delete semantics (non-null prev, no data), and type-checks `op` as string before comparison
- **Empty string rejection** — all timestamp, period, path, and ID fields now reject empty strings
- **Record count stats** — `activeRecords`, `archivedRecords`, `opsCount` now require non-negative integers
- **Archive segment lookup** — `loadArchive()` prefers exact match before substring fallback, preventing ambiguous matches
- **Manifest archiveSegments** — array entries validated as non-empty strings

## 0.1.3 (2026-04-07)

### Fixed
- **Snapshot validation** — `validateSnapshot()` now checks `timestamp` field, consistent with archive segment validation
- **Missing snapshot recovery** — `store.open()` now catches missing snapshot files and throws a descriptive error instead of a raw ENOENT
- **Version range validation** — all validators now require version to be a positive integer; rejects 0, negative, fractional, NaN

### Changed
- CLAUDE.md API signatures updated to match implementation (`set`/`delete` return types, `filter`/`count`/`archive` predicate signatures, `loadArchive` return type, added missing methods)
- README batch section documents empty batch no-op behavior

## 0.1.2 (2026-04-07)

### Fixed
- **Manifest validation** — `validateManifest()` now checks `archiveSegments` is an array and `stats` contains all required fields (`activeRecords`, `archivedRecords`, `opsCount`, `created`, `lastCheckpoint`). Malformed manifests throw descriptive errors instead of being treated as fresh stores.
- **Archive segment validation** — `validateArchiveSegment()` now checks `timestamp` field
- **Archive merge error handling** — distinguishes file-not-found (first write) from corrupted archive files; corruption now throws instead of silently overwriting
- **readManifest** — file-not-found returns null (fresh store), but validation errors now propagate

### Changed
- CLAUDE.md updated: fixed test file references, corrected `filter()` signature, added release process docs

## 0.1.1 (2026-04-07)

### Fixed
- **Archive segment overwrite** — archiving to the same period now merges records instead of silently overwriting
- **Batch rollback** — failed batch operations now defensively roll back each op individually, preventing cascading failures
- **Manifest stats** — `archivedRecords` count is now tracked and persisted across reopens (was hardcoded to 0)

### Added
- Runtime validation for all parsed JSON (operations, manifests, snapshots, archive segments) — malformed data is now caught with descriptive errors instead of silent `as T` casts
- Malformed WAL lines are counted and logged to stderr during recovery
- Tests for corruption recovery, batch I/O failure rollback, and archive merge behavior

### Changed
- Pinned devDependency versions (replaced `*` wildcards with specific ranges)

## 0.1.0 (2026-04-06)

Initial release.

- Append-only operation log with in-memory materialized state
- Snapshot checkpointing with configurable threshold
- Batch operations with atomic rollback
- Undo via log truncation
- Schema migration on version bump
- Archive segments for cold storage
- Crash recovery via WAL replay
