# opslog

Embedded event-sourced document store for Node.js. Append-only operation log with immutable snapshots, zero native dependencies.

## What It Is

A lightweight storage engine that records every mutation as an operation in an append-only log. Current state is derived by replaying operations from the latest snapshot. Designed for applications that need crash safety, undo, audit trails, and sync-readiness without a database server.

## Architecture

```
<data-dir>/
  manifest.json                 # Points to current snapshot + active ops file
  snapshots/
    snap-<timestamp>.json       # Immutable full-state captures
  ops/
    ops-<timestamp>.jsonl       # Append-only operation log (one JSON per line)
  archive/
    <period>.json               # Archived records (lazy-loaded)
```

- **Writes**: append operation to the active JSONL file
- **Reads**: load latest snapshot into memory, replay ops on top
- **Checkpoint**: materialize current state as new immutable snapshot, start new ops file
- **Undo**: pop last operation(s), apply previous values
- **Archive**: move old/inactive records out of the active set

## Core Properties

- **Crash-safe**: append-only writes can't corrupt existing data. Snapshots are immutable. Manifest is atomically replaced via temp-file-rename.
- **Concurrency-safe**: async mutation serializer prevents interleaving of concurrent writes. Advisory directory lock prevents multi-process corruption.
- **Zero native dependencies**: pure TypeScript, only Node.js fs
- **Undo built-in**: operations record before/after state. O(1) ftruncate-based undo.
- **Sync-ready**: operations are the natural unit for cross-node synchronization
- **Schema versioned**: operations and snapshots carry version numbers for forward migration

## Project Structure

```
src/
  types.ts            # Interfaces: Operation, Snapshot, Manifest, StoreOptions
  wal.ts              # Append-only operation log: append, read, truncate (ftruncate-based)
  snapshot.ts          # Immutable snapshot: write, load
  manifest.ts          # Manifest management: read, update (atomic)
  archive.ts           # Active/archive split: archive old records, lazy-load
  lock.ts              # Advisory directory write lock: acquire, release, stale recovery
  store.ts             # Public API: open, get, set, delete, query, undo, compact (with async mutex)
  index.ts             # Exports
tests/
  wal.test.ts           # WAL append/read/truncate tests
  store.test.ts         # All store operations, batch, undo, archive, corruption recovery
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
}
```

## Coding Conventions

- Zero external dependencies — only Node.js built-in modules (fs, path, crypto)
- All file writes use temp-file-then-rename for atomicity
- JSONL format for operation logs (one JSON object per line)
- JSON format for snapshots and manifest
- All async operations return Promises
- Comprehensive error handling — never corrupt data on error
- Tests use temp directories, cleaned up after each test

## Release Process

When making changes:
1. Update `CHANGELOG.md` with a new version entry (Fixed/Added/Changed sections, [Keep a Changelog](https://keepachangelog.com) format)
2. Bump version in `package.json`
3. Run `npm run build && npm run lint && npm test`
4. Commit, push, create PR
5. After merge: `npm publish --access public`
