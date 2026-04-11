import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    it("rejects compact() in skipLoad mode", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });
      await expect(store2.compact()).rejects.toThrow("skipLoad");
      await store2.close();
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

  describe("error handling", () => {
    it("streamSnapshot throws before open", async () => {
      const store = new Store<TestRecord>();
      const gen = store.streamSnapshot();
      await expect(gen.next()).rejects.toThrow("not open");
    });

    it("getWalOps throws before open", async () => {
      const store = new Store<TestRecord>();
      const gen = store.getWalOps();
      await expect(gen.next()).rejects.toThrow("not open");
    });
  });

  describe("edge cases", () => {
    it("streamSnapshot excludes deleted records", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.set("b", { name: "Bob", status: "done" });
      await store1.delete("b");
      await store1.close(); // checkpoint writes snapshot without deleted record

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      const records: [string, TestRecord][] = [];
      for await (const entry of store2.streamSnapshot()) {
        records.push(entry);
      }
      expect(records).toHaveLength(1);
      expect(records[0][0]).toBe("a");

      await store2.close();
    });

    it("getManifest returns read-only info without internal fields", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir);
      await store.set("a", { name: "Alice", status: "active" });

      const manifest = store.getManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.currentSnapshot).toBeTruthy();
      expect(manifest!.activeOps).toBeTruthy();
      expect(manifest!.archiveSegments).toBeDefined();
      expect(manifest!.stats).toBeDefined();
      // Should NOT expose activeAgentOps or other internals
      expect("activeAgentOps" in manifest!).toBe(false);

      await store.close();
    });

    it("skipLoad + archive throws on archive()", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { skipLoad: true });

      // archive needs to scan records Map — should fail or return 0
      const archived = await store2.archive(() => true);
      expect(archived).toBe(0); // no records in Map to archive

      await store2.close();
    });
  });

  describe("JSONL snapshot format", () => {
    it("writes JSONL and reads back correctly", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir);
      await store1.set("a", { name: "Alice", status: "active" });
      await store1.set("b", { name: "Bob", status: "done" });
      await store1.close();

      // Verify the snapshot file is JSONL
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      const snapshotPath = join(tmpDir, manifest.currentSnapshot);
      expect(manifest.currentSnapshot).toMatch(/\.jsonl$/);

      const content = await readFile(snapshotPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3); // header + 2 records

      // Header has version + timestamp, no "records" key
      const header = JSON.parse(lines[0]);
      expect(header.version).toBe(1);
      expect(header.timestamp).toBeTruthy();
      expect("records" in header).toBe(false);

      // Each record line has id + data
      const rec1 = JSON.parse(lines[1]);
      expect(rec1.id).toBeTruthy();
      expect(rec1.data).toBeTruthy();

      // Reopen and verify data integrity
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("a")?.name).toBe("Alice");
      expect(store2.get("b")?.name).toBe("Bob");
      await store2.close();
    });

    it("reads legacy JSON snapshots (backward compat)", async () => {
      // Create a store to get the directory structure
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir, { checkpointOnClose: false });
      await store1.close();

      // Write a legacy JSON snapshot manually
      const legacySnapshot = {
        version: 1,
        timestamp: new Date().toISOString(),
        records: {
          x: { name: "Xavier", status: "active" },
          y: { name: "Yara", status: "done" },
        },
      };
      const snapshotFile = `snapshots/snap-legacy.json`;
      await writeFile(join(tmpDir, snapshotFile), JSON.stringify(legacySnapshot), "utf-8");

      // Update manifest to point to legacy snapshot
      const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
      manifest.currentSnapshot = snapshotFile;
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      // Reopen — should read legacy format
      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir);
      expect(store2.get("x")?.name).toBe("Xavier");
      expect(store2.get("y")?.name).toBe("Yara");
      expect(store2.count()).toBe(2);

      // streamSnapshot should also work with legacy format
      const records: [string, TestRecord][] = [];
      for await (const entry of store2.streamSnapshot()) {
        records.push(entry);
      }
      expect(records).toHaveLength(2);

      await store2.close();
    });
  });
});
