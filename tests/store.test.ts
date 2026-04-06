import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

    it("throws on deleting non-existent record", () => {
      expect(() => store.delete("nonexistent")).toThrow("not found");
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
      expect(history[1].prev?.name).toBe("V1"); // update
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
      // Open, write, don't close (simulate crash — no checkpoint)
      await store.open(tmpDir, { checkpointOnClose: false, checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      // Don't close — simulates crash

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
});
