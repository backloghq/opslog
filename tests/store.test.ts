import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

interface TestRecord {
  name: string;
  status: string;
  priority?: string;
  value?: number;
}

describe("Store", () => {
  let tmpDir: string;
  let store: Store<TestRecord>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-store-"));
    store = new Store<TestRecord>();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      // Already closed or not opened
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("opens a fresh store", async () => {
      await store.open(tmpDir);
      expect(store.stats().activeRecords).toBe(0);
    });

    it("throws on operations before open", () => {
      expect(() => store.get("x")).toThrow("Store is not open");
    });

    it("reopens and preserves state", async () => {
      await store.open(tmpDir, { checkpointOnClose: true });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("A");
      await store2.close();
    });
  });

  describe("CRUD", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("sets and gets a record", async () => {
      await store.set("a", { name: "A", status: "active" });
      expect(store.get("a")).toEqual({ name: "A", status: "active" });
    });

    it("updates an existing record", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.set("a", { name: "A updated", status: "done" });
      expect(store.get("a")?.name).toBe("A updated");
    });

    it("deletes a record", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.delete("a");
      expect(store.get("a")).toBeUndefined();
      expect(store.has("a")).toBe(false);
    });

    it("throws on deleting non-existent record", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow("not found");
    });

    it("has() returns correct boolean", async () => {
      await store.set("a", { name: "A", status: "active" });
      expect(store.has("a")).toBe(true);
      expect(store.has("b")).toBe(false);
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active", priority: "H" });
      await store.set("b", { name: "B", status: "done", priority: "M" });
      await store.set("c", { name: "C", status: "active", priority: "L" });
    });

    it("all() returns all records", () => {
      expect(store.all()).toHaveLength(3);
    });

    it("entries() returns id-value pairs", () => {
      const entries = store.entries();
      expect(entries).toHaveLength(3);
      expect(entries.find(([id]) => id === "a")?.[1].name).toBe("A");
    });

    it("filter() with predicate", () => {
      const active = store.filter((r) => r.status === "active");
      expect(active).toHaveLength(2);
    });

    it("count() without predicate returns total", () => {
      expect(store.count()).toBe(3);
    });

    it("count() with predicate", () => {
      expect(store.count((r) => r.status === "active")).toBe(2);
      expect(store.count((r) => r.priority === "H")).toBe(1);
    });
  });

  describe("batch", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("applies multiple operations in one write", async () => {
      await store.batch(() => {
        store.set("a", { name: "A", status: "active" });
        store.set("b", { name: "B", status: "active" });
        store.set("c", { name: "C", status: "active" });
      });
      expect(store.count()).toBe(3);
    });

    it("supports delete inside batch", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      await store.set("c", { name: "C", status: "active" });

      await store.batch(() => {
        store.delete("a");
        store.delete("b");
      });

      expect(store.count()).toBe(1);
      expect(store.has("c")).toBe(true);
      expect(store.has("a")).toBe(false);
      expect(store.has("b")).toBe(false);
    });

    it("auto-checkpoints inside batch when threshold reached", async () => {
      await store.close();
      store = new Store<TestRecord>();
      await store.open(tmpDir, { checkpointThreshold: 3 });

      await store.batch(() => {
        store.set("a", { name: "A", status: "active" });
        store.set("b", { name: "B", status: "active" });
        store.set("c", { name: "C", status: "active" });
      });

      // Threshold of 3 hit — should have auto-checkpointed
      expect(store.stats().opsCount).toBe(0);
      expect(store.count()).toBe(3);
    });

    it("rolls back on error", async () => {
      await store.set("x", { name: "X", status: "active" });
      await expect(
        store.batch(() => {
          store.set("a", { name: "A", status: "active" });
          store.delete("nonexistent"); // throws
        }),
      ).rejects.toThrow();
      // "a" should be rolled back, "x" should remain
      expect(store.has("a")).toBe(false);
      expect(store.has("x")).toBe(true);
    });
  });

  describe("batch with mixed operations", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("handles set and delete in same batch", async () => {
      await store.set("x", { name: "X", status: "active" });

      await store.batch(() => {
        store.set("a", { name: "A", status: "active" });
        store.set("b", { name: "B", status: "active" });
        store.delete("x");
      });

      expect(store.count()).toBe(2);
      expect(store.has("a")).toBe(true);
      expect(store.has("b")).toBe(true);
      expect(store.has("x")).toBe(false);
    });

    it("persists batch with deletes across reopen", async () => {
      await store.set("x", { name: "X", status: "active" });
      await store.batch(() => {
        store.set("a", { name: "A", status: "active" });
        store.delete("x");
      });
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.has("a")).toBe(true);
      expect(store2.has("x")).toBe(false);
      await store2.close();
    });
  });

  describe("undo", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("undoes a create", async () => {
      await store.set("a", { name: "A", status: "active" });
      expect(store.has("a")).toBe(true);

      const undone = await store.undo();
      expect(undone).toBe(true);
      expect(store.has("a")).toBe(false);
    });

    it("undoes an update", async () => {
      await store.set("a", { name: "Original", status: "active" });
      await store.set("a", { name: "Updated", status: "done" });

      await store.undo();
      expect(store.get("a")?.name).toBe("Original");
      expect(store.get("a")?.status).toBe("active");
    });

    it("undoes a delete", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.delete("a");
      expect(store.has("a")).toBe(false);

      await store.undo();
      expect(store.get("a")?.name).toBe("A");
    });

    it("returns false when nothing to undo", async () => {
      const undone = await store.undo();
      expect(undone).toBe(false);
    });

    it("supports multiple undos", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      await store.set("c", { name: "C", status: "active" });

      await store.undo(); // undo c
      await store.undo(); // undo b
      expect(store.count()).toBe(1);
      expect(store.has("a")).toBe(true);
    });
  });

  describe("history", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("tracks operations per record", async () => {
      await store.set("a", { name: "V1", status: "active" });
      await store.set("a", { name: "V2", status: "active" });
      await store.set("b", { name: "B", status: "active" });

      const history = store.getHistory("a");
      expect(history).toHaveLength(2);
      expect(history[0].prev).toBeNull(); // create
      // Update may use delta encoding — check either format
      if (history[1].encoding === "delta") {
        expect((history[1].prev as Record<string, unknown>).$set).toBeDefined();
      } else {
        expect(history[1].prev?.name).toBe("V1");
      }
    });

    it("getOps returns all operations", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });

      const ops = store.getOps();
      expect(ops).toHaveLength(2);
    });

    it("getOps with since filter", async () => {
      await store.set("a", { name: "A", status: "active" });
      const beforeB = new Date().toISOString();
      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.set("b", { name: "B", status: "active" });

      const ops = store.getOps(beforeB);
      expect(ops).toHaveLength(1);
      expect(ops[0].id).toBe("b");
    });
  });

  describe("compact", () => {
    it("creates a new snapshot and clears ops", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      expect(store.stats().opsCount).toBe(2);

      await store.compact();
      expect(store.stats().opsCount).toBe(0);

      // Data still accessible
      expect(store.get("a")?.name).toBe("A");
      expect(store.get("b")?.name).toBe("B");
    });

    it("auto-checkpoints at threshold", async () => {
      await store.open(tmpDir, { checkpointThreshold: 3 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      // Third op triggers checkpoint
      await store.set("c", { name: "C", status: "active" });

      expect(store.stats().opsCount).toBe(0);
      expect(store.count()).toBe(3);
    });

    it("survives compact + reopen", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.compact();
      await store.set("b", { name: "B", status: "active" });
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("A");
      expect(store2.get("b")?.name).toBe("B");
      await store2.close();
    });
  });

  describe("archive", () => {
    beforeEach(async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("archives records matching predicate", async () => {
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "done" });
      await store.set("c", { name: "C", status: "done" });

      const count = await store.archive((r) => r.status === "done", "2026-Q1");
      expect(count).toBe(2);
      expect(store.count()).toBe(1);
      expect(store.has("a")).toBe(true);
      expect(store.has("b")).toBe(false);
    });

    it("loads archived records on demand", async () => {
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");

      const archived = await store.loadArchive("2026-Q1");
      expect(archived.get("a")?.name).toBe("A");
    });

    it("lists archive segments", async () => {
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");

      const segments = store.listArchiveSegments();
      expect(segments).toHaveLength(1);
      expect(segments[0]).toContain("2026-Q1");
    });

    it("returns 0 when nothing to archive", async () => {
      const count = await store.archive(() => false);
      expect(count).toBe(0);
    });

    it("throws when loading non-existent archive segment", async () => {
      await expect(store.loadArchive("nonexistent")).rejects.toThrow("not found");
    });

    it("persists archive segments across reopen", async () => {
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.listArchiveSegments()).toHaveLength(1);
      const archived = await store2.loadArchive("2026-Q1");
      expect(archived.get("a")?.name).toBe("A");
      await store2.close();
    });
  });

  describe("manifest validation", () => {
    it("throws on manifest missing archiveSegments", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      delete manifest.archiveSegments;
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("archiveSegments must be an array");
    });

    it("throws on manifest missing stats", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      delete manifest.stats;
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("missing stats");
    });

    it("throws on manifest with incomplete stats", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      manifest.stats = { activeRecords: 1 };
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("stats.archivedRecords must be a non-negative integer");
    });

    it("throws on manifest with invalid version", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      manifest.version = -1;
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("version must be a positive finite integer");
    });

    it("throws when snapshot file is missing", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const snapshotPath = join(tmpDir, manifest.currentSnapshot);
      await rm(snapshotPath);

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("Snapshot file not found");
    });
  });

  describe("snapshot validation", () => {
    it("throws on snapshot missing timestamp", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      // Write a corrupt legacy JSON snapshot (missing timestamp)
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const snapshotPath = join(tmpDir, manifest.currentSnapshot);
      const snapshot = { version: 1, records: { a: { name: "A", status: "active" } } };
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("timestamp must be a non-empty string");
    });

    it("throws on snapshot with invalid version", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      // Write a corrupt legacy JSON snapshot (invalid version)
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const snapshotPath = join(tmpDir, manifest.currentSnapshot);
      const snapshot = { version: 0, timestamp: "2026-01-01", records: { a: { name: "A", status: "active" } } };
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf-8");

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("version must be a positive finite integer");
    });
  });

  describe("archive validation", () => {
    it("throws on loading archive segment missing timestamp", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");

      // Corrupt the archive file — remove timestamp
      const archivePath = join(tmpDir, "archive", "archive-2026-Q1.json");
      const content = JSON.parse(await readFile(archivePath, "utf-8"));
      delete content.timestamp;
      await writeFile(archivePath, JSON.stringify(content), "utf-8");

      await expect(store.loadArchive("2026-Q1")).rejects.toThrow("timestamp must be a non-empty string");
    });

    it("throws on archive merge with corrupted existing file", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");

      // Corrupt the archive file
      const archivePath = join(tmpDir, "archive", "archive-2026-Q1.json");
      await writeFile(archivePath, "not valid json{{{", "utf-8");

      // Second archive to same period should throw, not silently overwrite
      await store.set("b", { name: "B", status: "done" });
      await expect(store.archive(() => true, "2026-Q1")).rejects.toThrow();
    });
  });

  describe("corruption recovery", () => {
    it("skips malformed ops lines on open", async () => {
      // Create a valid store first
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      // Read manifest to find active ops file
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const opsPath = join(tmpDir, manifest.activeOps);

      // Append malformed lines
      await writeFile(opsPath, await readFile(opsPath, "utf-8") + "not-json\n{}\n", "utf-8");

      // Simulate crash: release lock without checkpoint
      await store.close();

      // Reopen — should recover valid ops and skip bad ones
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("A");
      expect(store2.count()).toBe(1);
      await store2.close();
    });
  });

  describe("batch I/O failure", () => {
    it("rolls back in-memory state when disk write fails", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("existing", { name: "Existing", status: "active" });

      // Make ops file read-only to force appendOps failure
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const opsPath = join(tmpDir, manifest.activeOps);
      await chmod(opsPath, 0o444);

      await expect(
        store.batch(() => {
          store.set("new1", { name: "New1", status: "active" });
          store.set("new2", { name: "New2", status: "active" });
        }),
      ).rejects.toThrow();

      // In-memory state should be rolled back
      expect(store.has("new1")).toBe(false);
      expect(store.has("new2")).toBe(false);
      // Existing data preserved
      expect(store.has("existing")).toBe(true);

      // Restore permissions
      await chmod(opsPath, 0o644);
    });

    it("store remains usable after failed batch", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const opsPath = join(tmpDir, manifest.activeOps);
      await chmod(opsPath, 0o444);

      await expect(
        store.batch(() => {
          store.set("x", { name: "X", status: "active" });
        }),
      ).rejects.toThrow();

      // Restore permissions and verify store works
      await chmod(opsPath, 0o644);
      await store.set("y", { name: "Y", status: "active" });
      expect(store.get("y")?.name).toBe("Y");
    });
  });

  describe("archive merge", () => {
    it("merges records when archiving to same period twice", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });
      await store.set("b", { name: "B", status: "done" });
      await store.set("c", { name: "C", status: "active" });

      // First archive
      await store.archive((r) => r.name === "A", "2026-Q1");
      // Second archive to same period
      await store.archive((r) => r.name === "B", "2026-Q1");

      // Both records should be in the archive
      const archived = await store.loadArchive("2026-Q1");
      expect(archived.size).toBe(2);
      expect(archived.get("a")?.name).toBe("A");
      expect(archived.get("b")?.name).toBe("B");

      // Only active record remains
      expect(store.count()).toBe(1);
      expect(store.has("c")).toBe(true);
    });

    it("tracks archivedRecords count in manifest", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });
      await store.set("b", { name: "B", status: "done" });
      await store.archive(() => true, "2026-Q1");
      await store.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      expect(manifest.stats.archivedRecords).toBe(2);
    });

    it("persists archivedRecords count across reopen", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });
      await store.archive(() => true, "2026-Q1");
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { checkpointThreshold: 1000 });
      await store2.set("b", { name: "B", status: "done" });
      await store2.archive(() => true, "2026-Q1");
      await store2.close();

      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      expect(manifest.stats.archivedRecords).toBe(2);

      const store3 = new Store<TestRecord>();
      await store3.open(tmpDir);
      const archived = await store3.loadArchive("2026-Q1");
      expect(archived.size).toBe(2);
      await store3.close();
    });
  });

  describe("schema migration", () => {
    it("migrates records on version bump", async () => {
      // Create store with version 1
      await store.open(tmpDir, { version: 1, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      // Reopen with version 2 and migration
      const store2 = new Store<TestRecord & { migrated?: boolean }>();
      await store2.open(tmpDir, {
        version: 2,
        migrate: (record) => ({ ...(record as TestRecord), migrated: true }),
      });
      const record = store2.get("a");
      expect(record?.migrated).toBe(true);
      expect(record?.name).toBe("A");
      await store2.close();
    });
  });

  describe("persistence and recovery", () => {
    it("recovers state from ops after unclean shutdown", async () => {
      // Open, write, close without checkpoint (simulate crash)
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      // Close without checkpoint to simulate crash recovery on next open
      await store.close();

      // Reopen — should recover from ops replay
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("A");
      expect(store2.get("b")?.name).toBe("B");
      await store2.close();
    });

    it("handles many operations across reopen cycles", async () => {
      await store.open(tmpDir, { checkpointThreshold: 5 });

      for (let i = 0; i < 20; i++) {
        await store.set(`item-${i}`, { name: `Item ${i}`, status: "active", value: i });
      }
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.count()).toBe(20);
      expect(store2.get("item-15")?.value).toBe(15);
      await store2.close();
    });
  });

  describe("stats", () => {
    it("reports correct stats", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "done" });

      const s = store.stats();
      expect(s.activeRecords).toBe(2);
      expect(s.opsCount).toBe(2);
      expect(s.archiveSegments).toBe(0);
    });
  });

  describe("readOnly mode", () => {
    it("opens an existing store in readOnly without acquiring lock", async () => {
      // Create a store with data
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "done" });
      // Keep the writer open — lock is held

      // Open a second store in readOnly on the same directory
      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      // Reads work
      expect(reader.get("a")?.name).toBe("A");
      expect(reader.count()).toBe(2);
      expect(reader.all()).toHaveLength(2);
      expect(reader.filter((r) => r.status === "active")).toHaveLength(1);
      expect(reader.has("a")).toBe(true);
      expect(reader.entries()).toHaveLength(2);

      await reader.close();
    });

    it("rejects set in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      expect(() => reader.set("b", { name: "B", status: "active" })).toThrow("read-only");
      await reader.close();
    });

    it("rejects delete in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      expect(() => reader.delete("a")).toThrow("read-only");
      await reader.close();
    });

    it("rejects batch in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      await expect(reader.batch(() => {})).rejects.toThrow("read-only");
      await reader.close();
    });

    it("rejects undo in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      await expect(reader.undo()).rejects.toThrow("read-only");
      await reader.close();
    });

    it("rejects compact in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      await expect(reader.compact()).rejects.toThrow("read-only");
      await reader.close();
    });

    it("rejects archive in readOnly mode", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      await expect(reader.archive(() => true)).rejects.toThrow("read-only");
      await reader.close();
    });

    it("throws when opening readOnly on non-existent store", async () => {
      const reader = new Store<TestRecord>();
      await expect(
        reader.open(join(tmpDir, "nonexistent"), { readOnly: true }),
      ).rejects.toThrow("readOnly");
    });

    it("getHistory and getOps work in readOnly", async () => {
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "V1", status: "active" });
      await store.set("a", { name: "V2", status: "active" });
      await store.close();

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });

      expect(reader.getHistory("a")).toHaveLength(2);
      expect(reader.getOps()).toHaveLength(2);
      await reader.close();
    });

    it("close does not checkpoint in readOnly", async () => {
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { readOnly: true });
      // close should not write anything — no error even though ops exist
      await reader.close();

      // Reopen writable — ops should still be there (not checkpointed by reader)
      const writer = new Store<TestRecord>();
      await writer.open(tmpDir, { checkpointThreshold: 1000 });
      expect(writer.stats().opsCount).toBe(1);
      await writer.close();
    });
  });

  describe("archive with default period", () => {
    it("uses current quarter when no segment specified", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "done" });

      const count = await store.archive((r) => r.status === "done");
      expect(count).toBe(1);

      const segments = store.listArchiveSegments();
      expect(segments).toHaveLength(1);
      // Should contain year-Q format
      expect(segments[0]).toMatch(/\d{4}-Q[1-4]/);
    });
  });

  describe("WAL replay with deletes", () => {
    it("replays delete operations from ops file on reopen", async () => {
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      await store.delete("a");
      await store.close();

      // Reopen — should replay set+set+delete
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.has("a")).toBe(false);
      expect(store2.has("b")).toBe(true);
      expect(store2.count()).toBe(1);
      await store2.close();
    });
  });

  describe("directory lock", () => {
    it("prevents two stores from opening the same directory", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir)).rejects.toThrow("Store is locked by process");
    });

    it("allows reopening after close", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("A");
      await store2.close();
    });

    it("cleans up lock file on close", async () => {
      const { access } = await import("node:fs/promises");
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      // Lock file exists while open
      await expect(access(join(tmpDir, ".lock"))).resolves.toBeUndefined();

      await store.close();

      // Lock file removed after close
      await expect(access(join(tmpDir, ".lock"))).rejects.toThrow();
    });
  });

  describe("concurrency", () => {
    it("concurrent sets do not lose operations", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      // Fire 20 concurrent sets — all should succeed without interleaving
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(store.set(`item-${i}`, { name: `Item ${i}`, status: "active" }));
      }
      await Promise.all(promises);

      expect(store.count()).toBe(20);
      expect(store.stats().opsCount).toBe(20);
    });

    it("concurrent set and compact do not lose data", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      // Set some initial data
      for (let i = 0; i < 5; i++) {
        await store.set(`pre-${i}`, { name: `Pre ${i}`, status: "active" });
      }

      // Fire sets and a compact concurrently
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(store.set(`item-${i}`, { name: `Item ${i}`, status: "active" }));
        if (i === 5) {
          promises.push(store.compact());
        }
      }
      await Promise.all(promises);

      // All records should be present
      expect(store.count()).toBe(15);
      for (let i = 0; i < 5; i++) {
        expect(store.has(`pre-${i}`)).toBe(true);
      }
      for (let i = 0; i < 10; i++) {
        expect(store.has(`item-${i}`)).toBe(true);
      }
    });

    it("concurrent set and undo are serialized correctly", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });

      // Fire undo and set concurrently — undo should complete before set
      const undoPromise = store.undo();
      const setPromise = store.set("c", { name: "C", status: "active" });
      await Promise.all([undoPromise, setPromise]);

      // "b" was undone, "c" was added
      const undone = await undoPromise;
      expect(undone).toBe(true);
      expect(store.has("a")).toBe(true);
      expect(store.has("b")).toBe(false);
      expect(store.has("c")).toBe(true);
    });

    it("data survives concurrent operations + reopen", async () => {
      await store.open(tmpDir, { checkpointThreshold: 1000 });

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(store.set(`item-${i}`, { name: `Item ${i}`, status: "active" }));
      }
      await Promise.all(promises);
      await store.close();

      // Reopen and verify all data persisted
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.count()).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(store2.has(`item-${i}`)).toBe(true);
      }
      await store2.close();
    });
  });
});
