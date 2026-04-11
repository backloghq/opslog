# opslog

Embedded event-sourced document store for Node.js. Zero native dependencies.

Every mutation is recorded as an operation in an append-only log. Current state is derived by replaying operations from the latest snapshot. You get crash safety, undo, audit trails, and sync-readiness without a database server.

## Install

```bash
npm install @backloghq/opslog
```

## Usage

```typescript
import { Store } from "@backloghq/opslog";

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
  manifest.json                    # Points to current snapshot + ops file(s)
  snapshots/
    snap-<timestamp>.jsonl          # Immutable full-state capture (JSONL: header + one line per record)
  ops/
    ops-<timestamp>.jsonl          # Append-only operation log (single-writer)
    agent-<id>-<timestamp>.jsonl   # Per-agent operation log (multi-writer)
  archive/
    archive-<period>.json          # Old records, lazy-loaded
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
store.getManifest()               // Read-only ManifestInfo (snapshot/WAL paths, stats)
```

### Streaming (for external consumers)

```typescript
// Stream snapshot records without loading all into memory
for await (const [id, record] of store.streamSnapshot()) {
  process(id, record);
}

// Read WAL operations (optionally since a timestamp)
for await (const op of store.getWalOps(sinceTimestamp?)) {
  // op: { ts, op: "set"|"delete", id, data?, prev }
}
```

### Batch

```typescript
await store.batch(() => {         // Multiple ops, single disk write
  store.set("a", valueA);        // Rolls back all on error
  store.set("b", valueB);
});
```

Empty batches (no `set`/`delete` calls) are no-ops — no I/O is performed.

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
await store.refresh()             // Reload from all agent WALs (multi-writer only)
```

## Options

```typescript
await store.open(dir, {
  checkpointThreshold: 100,       // Auto-checkpoint after N ops (default: 100)
  checkpointOnClose: true,        // Checkpoint when close() is called (default: true)
  version: 1,                     // Schema version
  migrate: (record, fromVersion) => record, // Migration function
  readOnly: false,                // Open in read-only mode (default: false)
  skipLoad: false,                // Skip loading snapshot/WAL into memory (default: false)
  writeMode: "immediate",         // "immediate" (default), "group" (~12x faster), or "async" (~50x faster, lossy on crash)
  groupCommitSize: 50,            // Group: flush after N ops (default: 50)
  groupCommitMs: 100,             // Group: flush after N ms (default: 100)
  agentId: "agent-A",             // Enable multi-writer mode (optional)
  backend: new FsBackend(),       // Custom storage backend (optional, default: FsBackend)
});
```

## Group Commit

Buffer writes in memory and flush as a single disk write. ~12x faster for sustained writes.

```typescript
const store = new Store();
await store.open("./data", {
  writeMode: "group",     // Buffer ops, flush periodically
  groupCommitSize: 50,    // Flush when buffer has 50 ops
  groupCommitMs: 100,     // Or after 100ms idle
});

// Writes are buffered — no fsync per op
await store.set("a", valueA);
await store.set("b", valueB);  // Both flushed together

// Explicit flush if needed
await store.flush();

// close() always flushes before shutting down
await store.close();
```

### Async Mode

For maximum write throughput, use `writeMode: "async"`. Writes resolve immediately after buffering in memory — no disk I/O on the hot path. ~50x faster than immediate mode.

```typescript
const store = new Store();
await store.open("./data", {
  writeMode: "async",
  groupCommitSize: 50,
  groupCommitMs: 100,
});

await store.set("a", valueA);  // Returns instantly — buffered in memory
await store.set("b", valueB);  // Same

// Ensure durability before exit
await store.sync();
await store.close();
```

**Crash semantics:** Data buffered since the last flush is **lost** on unclean shutdown. Call `sync()` before process exit for durability. `close()` always flushes.

**Safety:** Forced to `"immediate"` when `agentId` is set (multi-writer mode). Other agents can't see buffered ops, so group/async commit is single-writer only.

**When to use which mode:**
- `"immediate"` (default) — every write is durable. Use when data loss is unacceptable.
- `"group"` — writes are batched but caller still waits for flush. ~12x faster. Crash loses up to `groupCommitMs` ms of data.
- `"async"` — writes return instantly. ~50x faster. Crash loses all unflushed data. Best for high-throughput, latency-sensitive, crash-tolerant workloads.

## Multi-Writer Mode

Multiple agents can write to the same store concurrently. Each agent gets its own WAL file — no write contention.

```typescript
// Agent A (process 1 / machine 1)
const storeA = new Store<Task>();
await storeA.open("./data", { agentId: "agent-A" });
await storeA.set("task-1", { title: "Build API", status: "active" });
await storeA.close();

// Agent B (process 2 / machine 2)
const storeB = new Store<Task>();
await storeB.open("./data", { agentId: "agent-B" });
// B sees A's writes on open
storeB.get("task-1"); // { title: "Build API", status: "active" }
await storeB.set("task-2", { title: "Write tests", status: "active" });
await storeB.close();
```

### How it works

- Each agent writes to `ops/agent-{id}-{timestamp}.jsonl` — separate files, no locking needed for writes
- Operations carry a [Lamport clock](https://en.wikipedia.org/wiki/Lamport_timestamp) for ordering
- On `open()`, all agent WAL files are merge-sorted by `(clock, agentId)` for a deterministic total order
- Conflicts (two agents write the same key) are resolved with **last-writer-wins** by clock value
- `undo()` only undoes the calling agent's last operation
- `compact()` acquires a compaction lock, snapshots the merged state, and resets all WAL files
- `refresh()` re-reads all agent WALs to pick up other agents' writes

### Conflict resolution

When two agents modify the same key, the operation with the higher Lamport clock wins. If clocks are equal, the lexicographically higher agent ID wins. This is deterministic — all agents arrive at the same state regardless of replay order.

```typescript
// Agent A sets "shared" (clock=1)
await storeA.set("shared", { value: "from-A" });

// Agent B opens (sees clock=1), sets "shared" (clock=2)
await storeB.set("shared", { value: "from-B" });

// B wins — higher clock
store.get("shared"); // { value: "from-B" }
```

## Custom Storage Backend

opslog uses a pluggable `StorageBackend` interface for all I/O. The default is `FsBackend` (local filesystem). You can implement your own backend for S3, databases, or other storage systems.

```typescript
import { Store, FsBackend } from "@backloghq/opslog";
import type { StorageBackend } from "@backloghq/opslog";

// Use the default filesystem backend (implicit)
const store = new Store();
await store.open("./data");

// Or pass a custom backend explicitly
const store = new Store();
await store.open("./data", { backend: new FsBackend() });

// Or implement your own
class S3Backend implements StorageBackend {
  // ... implement all methods
}
const store = new Store();
await store.open("s3://bucket/prefix", { backend: new S3Backend() });
```

## Read-Only Mode

Open a store for reading without acquiring the write lock. Useful for dashboards, backup processes, or multiple readers alongside a single writer.

```typescript
const reader = new Store();
await reader.open("./data", { readOnly: true });

// All reads work
const tasks = reader.all();
const active = reader.filter((t) => t.status === "active");

// All mutations throw
await reader.set("x", value); // Error: Store is read-only
```

Read-only stores load the latest snapshot and replay ops on open. They do not checkpoint on close. Multiple read-only stores can open the same directory concurrently alongside one writer.

## Concurrency

All state-mutating operations (`set`, `delete`, `batch`, `undo`, `compact`, `archive`) are serialized through an internal async mutex. This prevents interleaving of concurrent mutations — e.g., `compact()` swapping the ops file while `set()` is appending, or `undo()` truncating while `set()` is writing.

Read operations (`get`, `all`, `filter`, `count`, `has`, `entries`) are synchronous and lock-free.

An advisory directory write lock (`.lock` file with PID) prevents two processes from opening the same store. Stale locks from crashed processes are automatically recovered.

## Crash Safety

- **Ops file**: append-only writes. A crash mid-append loses at most the last operation. Malformed lines are skipped on recovery.
- **Snapshots**: immutable. Written to a temp file, then atomically renamed.
- **Manifest**: atomically replaced via temp-file-rename. Always points to a valid snapshot.
- **Undo**: uses `ftruncate()` — a single atomic POSIX syscall. O(1) regardless of file size.

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
