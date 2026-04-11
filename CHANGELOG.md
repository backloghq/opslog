# Changelog

## 0.7.1 (2026-04-11)

### Fixed
- **Streaming snapshot write** — `writeSnapshot()` now writes line-by-line via `createWriteStream` instead of accumulating all lines into a single string with `lines.join()`. Fixes V8 string limit crash at ~1M records (~500MB string). Read path was already streaming (v0.7.0); write path now matches.

## 0.7.0 (2026-04-11)

### Added
- **`skipLoad` option** — `store.open(dir, { skipLoad: true })` opens the store (acquires lock, reads manifest) without loading the snapshot or replaying WAL into memory. For consumers that manage their own read path (e.g. Parquet-backed storage). Writes still work normally.
- **`store.getManifest()`** — public accessor for the current manifest. Returns snapshot/WAL file paths, archive segments, and stats. Returns `null` before open.
- **`store.streamSnapshot()`** — async generator that yields `[id, record]` pairs from the current snapshot without loading all records into memory at once. For streaming compaction to external formats.
- **`store.getWalOps(sinceTimestamp?)`** — async generator that yields WAL operations, optionally filtered to those after a given timestamp. Multi-writer ops are merge-sorted by Lamport clock. For incremental replay without full snapshot reload.
- **`ManifestInfo` type** — read-only manifest facade returned by `getManifest()`. Exposes `currentSnapshot`, `activeOps`, `archiveSegments`, `stats` without internal fields like `activeAgentOps`.

### Changed
- **JSONL snapshot format** — snapshots now written as JSONL (header line + one line per record) instead of monolithic JSON. Enables true streaming reads via `readline`. Old JSON snapshots are auto-detected and read correctly (backward compatible reads).
- **`store.streamSnapshot()` true streaming** — uses `readline` to yield records one at a time from JSONL snapshots. Only one record in memory at a time. Falls back to parse-then-yield for legacy JSON snapshots.
- **`getManifest()` returns `ManifestInfo`** — read-only type instead of raw `Manifest`. Prevents consumers from depending on internal manifest structure.
- **`getWalOps()` single-writer optimization** — yields directly from ops array without intermediate accumulation buffer.
- **`compact()` guarded in skipLoad mode** — throws instead of writing empty snapshot that would destroy data.

### Breaking
- **Snapshot file extension changed** from `.json` to `.jsonl`. Existing `.json` snapshots are still readable (auto-detected). New snapshots are always `.jsonl`. Custom StorageBackend implementations that pattern-match on snapshot file extensions may need updating.

## 0.6.0 (2026-04-10)

### Added
- **Blob storage** — `StorageBackend` interface extended with 5 new methods: `writeBlob`, `readBlob`, `listBlobs`, `deleteBlob`, `deleteBlobDir`. For storing files outside the WAL (images, PDFs, code, etc.).
- **FsBackend blob implementation** — stores blobs as files at relative paths under the data directory.

### Breaking
- `StorageBackend` interface has 5 new required methods. Custom backends must implement them.

## 0.5.1 (2026-04-09)

### Added
- **Async write mode** — `writeMode: "async"` buffers operations and resolves `set()`/`delete()` immediately without waiting for disk I/O. Background timer and buffer-full triggers handle flushing. ~50x faster than immediate mode for individual writes.
- **`store.sync()`** — alias for `flush()`. Named shutdown hook for ensuring durability before process exit when using async mode.
- **Crash semantics**: ops acknowledged but not yet flushed are lost on unclean shutdown. This is opt-in and clearly documented.
- **Safety**: forced to `"immediate"` mode when `agentId` is set (multi-writer), same as group mode.

## 0.5.0 (2026-04-09)

### Added
- **Group commit mode** — `writeMode: "group"` buffers operations in memory and flushes periodically (single disk write per batch). ~12x faster than immediate mode for sustained writes. Configurable via `groupCommitSize` (default 50) and `groupCommitMs` (default 100ms).
- **`store.flush()`** — explicitly flush the group commit buffer to disk.
- Automatic flush on `close()`, `compact()`, and when buffer reaches size threshold.
- Timer-based flush: even with few ops, buffer is written within `groupCommitMs` milliseconds.
- **Safety**: forced to `"immediate"` mode when `agentId` is set (multi-writer). Logs a warning if user tries `"group"` with multi-writer.

## 0.4.1 (2026-04-09)

### Fixed
- **`tail()` now works in multi-writer mode** — reads ALL agent WAL files via `_refresh()` instead of just the local agent's ops file. Agents can now see each other's writes via `tail()` and `watch()`.
- **`refresh()` works in any mode** — no longer throws in single-writer mode. Delegates to `tail()` for single-writer, full refresh for multi-writer. Enables readOnly stores to pick up new writes from the writer process.

## 0.4.0 (2026-04-09)

### Added
- **WAL tailing** — `store.tail()` reads new operations from the WAL since the last known position. Returns newly applied operations. Works in any mode (readOnly, multi-writer). Enables cross-process live updates without reopening.
- **Watch mode** — `store.watch(callback, intervalMs)` polls for new ops on an interval and calls the callback. `store.unwatch()` stops polling. `close()` auto-unwatches.
- **Delta encoding** — update operations automatically use delta encoding when the patch is smaller than the full `prev` record. Stores `{$set: {...}, $unset: [...]}` instead of the full previous record. `encoding: "delta"` field on the operation. Undo correctly applies reverse patches. Massive space savings for single-field updates on large records.
- **Delta utilities** — exported `createDelta()`, `applyDelta()`, `isDeltaSmaller()` functions and `DeltaPatch` type.

## 0.3.0 (2026-04-09)

### Added
- **Pluggable storage backend** — new `StorageBackend` interface decouples all I/O from the Store class. `FsBackend` (filesystem, default) ships built-in. Custom backends (S3, etc.) can be passed via `StoreOptions.backend`. The public API is fully backward compatible — `new Store().open(dir)` works exactly as before.
- **Multi-writer concurrency** — multiple agents can write to the same store from different processes/machines. Enable with `StoreOptions.agentId`. Each agent gets its own WAL file (`ops/agent-{id}-{ts}.jsonl`), eliminating write contention.
  - **Lamport clock** — operations carry a logical clock for deterministic ordering across agents. Exported as `LamportClock` class.
  - **Last-writer-wins conflict resolution** — when agents write to the same key, the operation with the higher clock wins. Ties broken by agent ID (lexicographic).
  - **Merge-sort replay** — on `open()`, all agent WAL files are read and merge-sorted by `(clock, agentId)` for a deterministic total order.
  - **Per-agent undo** — `undo()` removes only the calling agent's last operation. Other agents' ops are unaffected.
  - **Cooperative compaction** — agents acquire a compaction lock before checkpointing. After compaction, other agents detect the manifest change and start fresh WAL files.
  - **`store.refresh()`** — manually reload state from all agent WAL files (multi-writer mode only).
- **New exports** — `FsBackend`, `LamportClock`, `StorageBackend` (type), `LockHandle` (type).
- **Operation type extended** — optional `agent` (string) and `clock` (number) fields for multi-writer mode. Single-writer operations omit these fields for backward compatibility.
- **Manifest type extended** — optional `activeAgentOps` (Record<string, string>) maps agent IDs to their ops file paths.

### Changed
- **Store internals refactored** — all filesystem I/O routed through `StorageBackend` interface. Store no longer imports `node:fs` directly.
- **`StoreOptions` extended** — new optional fields: `backend` (StorageBackend), `agentId` (string).

## 0.2.0 (2026-04-09)

### Added
- **Async mutation serializer** — promise-chain mutex serializes all state-mutating operations (`set`, `delete`, `batch`, `undo`, `compact`, `archive`). Prevents interleaving of concurrent async mutations that could corrupt the WAL or in-memory state. Read operations remain synchronous and lock-free.
- **Advisory directory write lock** — `store.open()` acquires a lockfile (`.lock` with PID). Prevents two processes from opening the same store directory. Stale locks from crashed processes are automatically recovered.
- **Read-only mode** — `store.open(dir, { readOnly: true })` opens the store without acquiring the directory lock. All reads work (get, all, filter, count, has, entries, getHistory, getOps). All mutations are rejected with a descriptive error. Enables single-writer/multi-reader across processes.
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
