# opslog

Embedded event-sourced document store for Node.js. Append-only operation log with immutable snapshots, zero native dependencies. Supports pluggable storage backends and multi-writer concurrency.

## What It Is

A lightweight storage engine that records every mutation as an operation in an append-only log. Current state is derived by replaying operations from the latest snapshot. Designed for applications that need crash safety, undo, audit trails, and sync-readiness without a database server.

## Architecture

```
<data-dir>/
  manifest.json                       # Points to current snapshot + active ops file(s)
  snapshots/
    snap-<timestamp>.jsonl            # Immutable full-state captures (JSONL: header + one record per line)
  ops/
    ops-<timestamp>.jsonl             # Single-writer operation log (one JSON per line)
    agent-<id>-<timestamp>.jsonl      # Per-agent operation log (multi-writer mode)
  archive/
    <period>.json                     # Archived records (lazy-loaded)
```

- **Writes**: append operation to the active JSONL file (per-agent in multi-writer mode)
- **Reads**: load latest snapshot into memory, replay ops on top
- **Checkpoint**: materialize current state as new immutable snapshot, start new ops file
- **Undo**: single-writer: O(1) ftruncate. Multi-writer: undo agent's own last op, re-derive state
- **Archive**: move old/inactive records out of the active set

### Storage Backend

All I/O goes through the `StorageBackend` interface. `FsBackend` (filesystem) is the default. Custom backends can be passed via `StoreOptions.backend`.

### Group Commit

`writeMode: "group"` buffers ops in memory and flushes as a single disk write (~12x faster). `writeMode: "async"` goes further — `set()`/`delete()` resolve immediately on buffer, background flush handles persistence (~50x faster, data lost on crash). Configurable via `groupCommitSize` (default 50) and `groupCommitMs` (default 100). Forced to `"immediate"` when `agentId` is set (multi-writer safety). `store.flush()` / `store.sync()` for explicit flush. Buffer flushed on `close()` and `compact()`.

### Blob Storage

`StorageBackend` supports blob storage for files outside the WAL: `writeBlob(path, content)`, `readBlob(path)`, `listBlobs(prefix)`, `deleteBlob(path)`, `deleteBlobDir(prefix)`. Paths are relative to the store directory. FsBackend stores as files, S3Backend stores as S3 objects.

### Multi-Writer Concurrency

When `StoreOptions.agentId` is set, the store operates in multi-writer mode:
- Each agent writes to its own WAL file (no write contention)
- Operations carry Lamport clock timestamps for global ordering
- On open/refresh, all agent WALs are merge-sorted by `(clock, agentId)`
- Conflicts resolved via last-writer-wins (higher clock wins, ties by agentId)
- Compaction uses a separate lock; other agents detect manifest changes

## Core Properties

- **Crash-safe**: append-only writes can't corrupt existing data. Snapshots are immutable. Manifest is atomically replaced via temp-file-rename.
- **Concurrency-safe**: async mutation serializer prevents interleaving of concurrent writes. Single-writer: advisory directory lock. Multi-writer: per-agent WALs with Lamport clocks.
- **Zero native dependencies**: pure TypeScript, only Node.js fs
- **Undo built-in**: operations record before/after state
- **Sync-ready**: operations are the natural unit for cross-node synchronization
- **Schema versioned**: operations and snapshots carry version numbers for forward migration
- **Pluggable storage**: `StorageBackend` interface for filesystem, S3, or custom backends

## Project Structure

```
src/
  types.ts            # Interfaces: Operation, Snapshot, Manifest, StorageBackend, StoreOptions
  backend.ts          # FsBackend: filesystem StorageBackend implementation
  clock.ts            # LamportClock: logical clock for multi-writer ordering
  wal.ts              # Append-only operation log: append, read, truncate (ftruncate-based)
  snapshot.ts         # Immutable snapshot: write, load
  manifest.ts         # Manifest management: read, update (atomic)
  archive.ts          # Active/archive split: archive old records, lazy-load
  lock.ts             # Advisory directory write lock: acquire, release, stale recovery
  store.ts            # Public API: open, get, set, delete, query, undo, compact, refresh
  validate.ts         # Runtime validators for all parsed JSON
  index.ts            # Exports
tests/
  store.test.ts       # All store operations, batch, undo, archive, corruption recovery
  wal.test.ts         # WAL append/read/truncate tests
  lock.test.ts        # Advisory lock tests
  backend.test.ts     # FsBackend unit tests
  clock.test.ts       # LamportClock tests
  multi-writer.test.ts # Multi-writer: concurrent agents, LWW, undo, compaction, refresh
  disk-primitives.test.ts # skipLoad, getManifest, streamSnapshot, getWalOps
```

## Public API

```typescript
interface Store<T> {
  open(dir: string, options?: StoreOptions): Promise<void>;
  close(): Promise<void>;

  // CRUD
  get(id: string): T | undefined;
  set(id: string, value: T): Promise<void> | void;  // sync inside batch()
  delete(id: string): Promise<void> | void;          // sync inside batch()
  has(id: string): boolean;

  // Query
  all(): T[];
  entries(): [string, T][];
  filter(predicate: (value: T, id: string) => boolean): T[];
  count(predicate?: (value: T, id: string) => boolean): number;

  // Batch — empty batches are no-ops (no I/O)
  batch(fn: () => void): Promise<void>;

  // History
  undo(): Promise<boolean>;
  getHistory(id: string): Operation<T>[];
  getOps(since?: string): Operation<T>[];

  // Maintenance
  compact(): Promise<void>;
  archive(predicate: (value: T, id: string) => boolean, segment?: string): Promise<number>;
  loadArchive(segment: string): Promise<Map<string, T>>;
  listArchiveSegments(): string[];
  stats(): StoreStats;

  // Multi-writer
  refresh(): Promise<void>;  // Reload from all agent WALs (multi-writer only)

  // Disk-backed primitives (v0.7+)
  getManifest(): ManifestInfo | null;
  streamSnapshot(): AsyncGenerator<[string, T]>;
  getWalOps(sinceTimestamp?: string): AsyncGenerator<Operation<T>>;
}

// StorageBackend blob methods (v0.6+, readBlobRange v0.8+)
interface StorageBackend {
  writeBlob(path: string, content: Buffer): Promise<void>;
  readBlob(path: string): Promise<Buffer>;
  readBlobRange(path: string, offset: number, length: number): Promise<Buffer>;  // v0.8+
  listBlobs(prefix: string): Promise<string[]>;
  deleteBlob(path: string): Promise<void>;
  deleteBlobDir(prefix: string): Promise<void>;
}
```

## Coding Conventions

- Zero external dependencies — only Node.js built-in modules (fs, path, crypto)
- All file writes use temp-file-then-rename for atomicity
- JSONL format for operation logs (one JSON object per line)
- JSON format for snapshots and manifest
- All async operations return Promises
- Comprehensive error handling — never corrupt data on error
- All I/O routed through StorageBackend interface (Store has no direct fs imports)
- Tests use temp directories, cleaned up after each test

## Release Process

When making changes:
1. Update `CHANGELOG.md` with a new version entry (Fixed/Added/Changed sections, [Keep a Changelog](https://keepachangelog.com) format)
2. Bump version in `package.json`
3. Run `npm run build && npm run lint && npm test`
4. Commit, push, create PR
5. After merge: `npm publish --access public`
