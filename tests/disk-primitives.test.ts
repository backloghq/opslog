import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

interface TestRecord {
  name: string;
  status: string;
  value?: number;
}

describe("Disk-backed primitives", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-disk-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("skipLoad", () => {
    it("opens without loading records into memory", async () => {
      // Seed data
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.set("b", { name: "Bob", status: "done" });
      await store1.close();

      // Reopen with skipLoad
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      // Records Map is empty
      expect(store2.get("a")).toBeUndefined();
      expect(store2.get("b")).toBeUndefined();
      expect(store2.entries()).toEqual([]);
      expect(store2.all()).toEqual([]);
      expect(store2.count()).toBe(0);

      await store2.close();
    });

    it("writes still work after skipLoad", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.close();

      // Reopen with skipLoad, write new record
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });
      await store2.set("c", { name: "Charlie", status: "new" });
      await store2.close();

      // Reopen normally — should see both old and new records
      const store3 = new Store<TestRecord>();
      await store3.open(tmpDir);
      expect(store3.get("a")?.name).toBe("Alice");
      expect(store3.get("c")?.name).toBe("Charlie");
      await store3.close();
    });

    it("lock is still acquired with skipLoad", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir, { skipLoad: true });

      // Second open should fail (lock held)
      const store2 = new Store<TestRecord>();
      await expect(store2.open(tmpDir, { skipLoad: true })).rejects.toThrow();

      await store1.close();
    });
  });

  describe("getManifest", () => {
    it("returns null before open", () => {
      const store = new Store<TestRecord>();
      expect(store.getManifest()).toBeNull();
    });

    it("returns manifest after open", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir);

      const manifest = store.getManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.currentSnapshot).toBeTruthy();
      expect(manifest!.activeOps).toBeTruthy();
      expect(manifest!.stats).toBeTruthy();

      await store.close();
    });

    it("returns manifest with skipLoad", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const manifest = store2.getManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.currentSnapshot).toBeTruthy();

      await store2.close();
    });
  });

  describe("streamSnapshot", () => {
    it("yields all records from snapshot", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.set("b", { name: "Bob", status: "done" });
      await store1.set("c", { name: "Charlie", status: "active" });
      await store1.close(); // checkpoint writes snapshot

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const records: [string, TestRecord][] = [];
      for await (const entry of store2.streamSnapshot()) {
        records.push(entry);
      }

      expect(records).toHaveLength(3);
      const ids = records.map(([id]) => id).sort();
      expect(ids).toEqual(["a", "b", "c"]);

      const alice = records.find(([id]) => id === "a");
      expect(alice![1].name).toBe("Alice");

      await store2.close();
    });

    it("yields nothing for empty snapshot", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const records: [string, TestRecord][] = [];
      for await (const entry of store2.streamSnapshot()) {
        records.push(entry);
      }
      expect(records).toHaveLength(0);

      await store2.close();
    });

    it("works with normal open (not skipLoad)", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir);
      await store.set("a", { name: "Alice", status: "active" });
      await store.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);

      const records: [string, TestRecord][] = [];
      for await (const entry of store2.streamSnapshot()) {
        records.push(entry);
      }
      expect(records).toHaveLength(1);
      expect(records[0][1].name).toBe("Alice");

      await store2.close();
    });
  });

  describe("getWalOps", () => {
    it("yields all WAL ops", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir, { checkpointOnClose: false });
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.set("b", { name: "Bob", status: "done" });
      await store1.delete("a");
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const ops = [];
      for await (const op of store2.getWalOps()) {
        ops.push(op);
      }

      expect(ops).toHaveLength(3);
      expect(ops[0].op).toBe("set");
      expect(ops[0].id).toBe("a");
      expect(ops[1].op).toBe("set");
      expect(ops[1].id).toBe("b");
      expect(ops[2].op).toBe("delete");
      expect(ops[2].id).toBe("a");

      await store2.close();
    });

    it("filters ops by sinceTimestamp", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir, { checkpointOnClose: false });
      await store1.set("a", { name: "Alice", status: "active" });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      await store1.set("b", { name: "Bob", status: "done" });
      await store1.set("c", { name: "Charlie", status: "new" });
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const ops = [];
      for await (const op of store2.getWalOps(cutoff)) {
        ops.push(op);
      }

      // Only ops after cutoff
      expect(ops.length).toBeGreaterThanOrEqual(2);
      expect(ops.every((op) => op.ts > cutoff)).toBe(true);

      await store2.close();
    });

    it("returns empty for no WAL ops", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.close(); // checkpoint compacts, WAL is empty

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const ops = [];
      for await (const op of store2.getWalOps()) {
        ops.push(op);
      }
      expect(ops).toHaveLength(0);

      await store2.close();
    });
  });
});
