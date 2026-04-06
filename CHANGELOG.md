# Changelog

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
