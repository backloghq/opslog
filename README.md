# opslog

Embedded event-sourced document store for Node.js. Zero native dependencies.

Every mutation is recorded as an operation in an append-only log. Current state is derived by replaying operations from the latest snapshot. You get crash safety, undo, audit trails, and sync-readiness without a database server.

## Install

```bash
npm install opslog
```

## Usage

```typescript
import { Store } from "opslog";

const store = new Store<{ name: string; status: string }>();
await store.open("./data");

// Create
await store.set("task-1", { name: "Build API", status: "active" });

// Read
const task = store.get("task-1");

// Update
await store.set("task-1", { ...task, status: "done" });

// Delete
await store.delete("task-1");

// Undo the delete
await store.undo();

// Query
const active = store.filter((r) => r.status === "active");
const count = store.count((r) => r.status === "done");

// Batch (single disk write for multiple operations)
await store.batch(() => {
  store.set("a", { name: "A", status: "active" });
  store.set("b", { name: "B", status: "active" });
  store.set("c", { name: "C", status: "active" });
});

// Close (checkpoints automatically)
await store.close();
```

State survives restarts — reopen the same directory and everything is there.

## How It Works

```
data/
  manifest.json              # Points to current snapshot + ops file
  snapshots/
    snap-<timestamp>.json    # Immutable full-state capture
  ops/
    ops-<timestamp>.jsonl    # Append-only operation log
  archive/
    archive-<period>.json    # Old records, lazy-loaded
```

**Writes** append an operation (one JSON line) to the ops file. **Reads** come from an in-memory map built from the latest snapshot + ops replay. **Checkpoints** materialize current state as a new immutable snapshot.

Every operation records the previous value, so **undo** pops the last operation and restores the old state. The operations log doubles as an **audit trail** and a natural unit for **sync** between nodes.

## API

### Lifecycle

```typescript
await store.open(dir, options?)   // Load state from directory
await store.close()               // Checkpoint and close
```

### CRUD

```typescript
store.get(id)                     // Get record by ID
await store.set(id, value)        // Create or update
await store.delete(id)            // Remove (throws if not found)
store.has(id)                     // Check existence
```

### Query

```typescript
store.all()                       // All records
store.entries()                   // All [id, record] pairs
store.filter(predicate)           // Records matching predicate
store.count(predicate?)           // Count (all or matching)
```

### Batch

```typescript
await store.batch(() => {         // Multiple ops, single disk write
  store.set("a", valueA);        // Rolls back all on error
  store.set("b", valueB);
});
```

### History

```typescript
await store.undo()                // Undo last operation
store.getHistory(id)              // All operations for a record
store.getOps(since?)              // Operations since timestamp
```

### Maintenance

```typescript
await store.compact()             // Create new snapshot, clear ops
await store.archive(predicate)    // Move matching records to archive
await store.loadArchive(segment)  // Lazy-load archived records
store.listArchiveSegments()       // List available archive files
store.stats()                     // { activeRecords, opsCount, archiveSegments }
```

## Options

```typescript
await store.open(dir, {
  checkpointThreshold: 100,       // Auto-checkpoint after N ops (default: 100)
  checkpointOnClose: true,        // Checkpoint when close() is called (default: true)
  version: 1,                     // Schema version
  migrate: (record, fromVersion) => record, // Migration function
});
```

## Crash Safety

- **Ops file**: append-only writes. A crash mid-append loses at most the last operation. Malformed lines are skipped on recovery.
- **Snapshots**: immutable. Written to a temp file, then atomically renamed.
- **Manifest**: atomically replaced via temp-file-rename. Always points to a valid snapshot.

No data corruption on crash. At most one in-flight operation is lost.

## Schema Migration

```typescript
const store = new Store();
await store.open(dir, {
  version: 2,
  migrate: (record, fromVersion) => {
    if (fromVersion < 2) return { ...record, newField: "default" };
    return record;
  },
});
```

Records are migrated in memory on open. Next checkpoint persists the migrated state.

## Development

```bash
npm run build          # Compile TypeScript
npm run lint           # ESLint
npm test               # Run tests
npm run test:coverage  # Tests with coverage
```

## License

MIT
