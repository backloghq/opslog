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
- **Zero native dependencies**: pure TypeScript, only Node.js fs
- **Undo built-in**: operations record before/after state
- **Sync-ready**: operations are the natural unit for cross-node synchronization
- **Schema versioned**: operations and snapshots carry version numbers for forward migration

## Project Structure

```
src/
  types.ts            # Interfaces: Operation, Snapshot, Manifest, StoreOptions
  wal.ts              # Append-only operation log: append, read, truncate
  snapshot.ts          # Immutable snapshot: write, load
  manifest.ts          # Manifest management: read, update (atomic)
  archive.ts           # Active/archive split: archive old records, lazy-load
  store.ts             # Public API: open, get, set, delete, query, undo, compact
  index.ts             # Exports
tests/
  wal.test.ts
  snapshot.test.ts
  store.test.ts
  archive.test.ts
  crash.test.ts        # Crash safety scenarios
```

## Public API

```typescript
interface Store<T> {
  open(dir: string, options?: StoreOptions): Promise<void>;
  close(): Promise<void>;

  // CRUD
  get(id: string): T | undefined;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): boolean;

  // Query
  all(): T[];
  filter(predicate: (item: T) => boolean): T[];
  count(predicate?: (item: T) => boolean): number;

  // Batch
  batch(fn: () => void): Promise<void>;

  // History
  undo(): Promise<boolean>;
  getHistory(id: string): Operation<T>[];

  // Maintenance
  compact(): Promise<void>;
  archive(predicate: (item: T) => boolean): Promise<number>;
  loadArchive(segment?: string): Promise<T[]>;
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
