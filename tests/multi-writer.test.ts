import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

interface TestRecord {
  name: string;
  status: string;
  value?: number;
}

describe("Multi-writer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-mw-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("basic operations", () => {
    it("opens a fresh store with agentId", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, { agentId: "agent-A" });
      expect(store.stats().activeRecords).toBe(0);
      await store.close();
    });

    it("writes include agent and clock fields", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });

      const ops = store.getOps();
      expect(ops).toHaveLength(2);
      expect(ops[0].agent).toBe("agent-A");
      expect(ops[0].clock).toBe(1);
      expect(ops[1].agent).toBe("agent-A");
      expect(ops[1].clock).toBe(2);
      await store.close();
    });

    it("persists and recovers agent ops across reopen", async () => {
      const store1 = new Store<TestRecord>();
      await store1.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await store1.set("a", { name: "A", status: "active" });
      await store1.close();

      const store2 = new Store<TestRecord>();
      await store2.open(tmpDir, { agentId: "agent-A" });
      expect(store2.get("a")?.name).toBe("A");
      await store2.close();
    });

    it("CRUD operations work in multi-writer mode", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 1000,
      });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      expect(store.count()).toBe(2);

      await store.set("a", { name: "A updated", status: "done" });
      expect(store.get("a")?.name).toBe("A updated");

      await store.delete("b");
      expect(store.has("b")).toBe(false);
      expect(store.count()).toBe(1);
      await store.close();
    });

    it("batch operations work in multi-writer mode", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 1000,
      });
      await store.batch(() => {
        store.set("a", { name: "A", status: "active" });
        store.set("b", { name: "B", status: "active" });
        store.set("c", { name: "C", status: "active" });
      });
      expect(store.count()).toBe(3);

      const ops = store.getOps();
      expect(ops.every((op) => op.agent === "agent-A")).toBe(true);
      expect(ops.every((op) => typeof op.clock === "number")).toBe(true);
      await store.close();
    });
  });

  describe("two agents", () => {
    it("two agents write to the same store sequentially", async () => {
      // Agent A writes
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a", { name: "from-A", status: "active" });
      await storeA.close();

      // Agent B writes
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointThreshold: 1000,
      });
      // B should see A's data
      expect(storeB.get("a")?.name).toBe("from-A");

      await storeB.set("b", { name: "from-B", status: "active" });
      await storeB.close();

      // Reopen as A — should see both
      const storeA2 = new Store<TestRecord>();
      await storeA2.open(tmpDir, { agentId: "agent-A" });
      expect(storeA2.get("a")?.name).toBe("from-A");
      expect(storeA2.get("b")?.name).toBe("from-B");
      await storeA2.close();
    });

    it("two agents write different keys concurrently", async () => {
      // Agent A opens
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a1", { name: "A-1", status: "active" });
      await storeA.set("a2", { name: "A-2", status: "active" });
      await storeA.close();

      // Agent B opens
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeB.set("b1", { name: "B-1", status: "active" });
      await storeB.set("b2", { name: "B-2", status: "active" });
      await storeB.close();

      // Verify all data via a third open
      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { agentId: "reader" });
      expect(reader.count()).toBe(4);
      expect(reader.get("a1")?.name).toBe("A-1");
      expect(reader.get("a2")?.name).toBe("A-2");
      expect(reader.get("b1")?.name).toBe("B-1");
      expect(reader.get("b2")?.name).toBe("B-2");
      await reader.close();
    });

    it("LWW conflict resolution: higher clock wins", async () => {
      // Agent A sets key "shared" with clock=1
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("shared", { name: "from-A", status: "active" });
      await storeA.close();

      // Agent B opens, sees A's write (clock=1), its clock starts at 1
      // B's write gets clock=2 → higher than A's clock=1 → B wins
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeB.set("shared", { name: "from-B", status: "done" });
      await storeB.close();

      // Verify B's write wins
      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { agentId: "reader" });
      expect(reader.get("shared")?.name).toBe("from-B");
      await reader.close();
    });

    it("LWW tie-breaking: higher agentId wins on equal clocks", async () => {
      // Create a fresh store
      const init = new Store<TestRecord>();
      await init.open(tmpDir, {
        agentId: "init",
        checkpointThreshold: 1000,
      });
      await init.close();

      // Manually write ops for two agents with the same clock value
      // to test tie-breaking
      const { FsBackend } = await import("../src/backend.js");
      const backend = new FsBackend();
      await backend.initialize(tmpDir, { readOnly: false });

      const pathA = await backend.createAgentOpsFile("agent-A");
      const pathB = await backend.createAgentOpsFile("agent-B");

      // Both write to "key" with clock=1
      await backend.appendOps(pathA, [
        {
          ts: "2026-01-01T00:00:00Z",
          op: "set",
          id: "key",
          data: { name: "from-A", status: "active" },
          prev: null,
          agent: "agent-A",
          clock: 1,
        },
      ]);
      await backend.appendOps(pathB, [
        {
          ts: "2026-01-01T00:00:01Z",
          op: "set",
          id: "key",
          data: { name: "from-B", status: "active" },
          prev: null,
          agent: "agent-B",
          clock: 1,
        },
      ]);

      // Update manifest to include both agent ops
      const manifest = await backend.readManifest();
      await backend.writeManifest({
        ...manifest!,
        activeAgentOps: {
          ...(manifest!.activeAgentOps ?? {}),
          "agent-A": pathA,
          "agent-B": pathB,
        },
      });

      // Open and verify: "agent-B" > "agent-A" lexicographically, so B wins
      const store = new Store<TestRecord>();
      await store.open(tmpDir, { agentId: "verifier" });
      expect(store.get("key")?.name).toBe("from-B");
      await store.close();
    });
  });

  describe("merge-sort replay", () => {
    it("ops are replayed in clock order across agents", async () => {
      // Agent A writes two records
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("x", { name: "X-v1", status: "active" });
      await storeA.close();

      // Agent B opens (clock starts at 1), writes to same key
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeB.set("x", { name: "X-v2", status: "done" });
      await storeB.close();

      // Verify ops order
      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { agentId: "reader" });
      const ops = reader.getOps();
      // A's op has clock=1, B's op has clock=2 (because B saw A's clock=1)
      expect(ops.length).toBeGreaterThanOrEqual(2);
      // Final state should be B's write (higher clock)
      expect(reader.get("x")?.name).toBe("X-v2");
      await reader.close();
    });
  });

  describe("per-agent undo", () => {
    it("undoes only the calling agent's last operation", async () => {
      // Agent A writes
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a", { name: "from-A", status: "active" });
      await storeA.close();

      // Agent B writes and undoes
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeB.set("b", { name: "from-B", status: "active" });
      expect(storeB.has("b")).toBe(true);

      const undone = await storeB.undo();
      expect(undone).toBe(true);
      expect(storeB.has("b")).toBe(false);
      // A's write should still be there
      expect(storeB.has("a")).toBe(true);
      await storeB.close();
    });

    it("returns false when agent has no ops to undo", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 1000,
      });
      const undone = await store.undo();
      expect(undone).toBe(false);
      await store.close();
    });
  });

  describe("compaction", () => {
    it("compacts multi-writer store into a single snapshot", async () => {
      // Agent A writes
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a", { name: "from-A", status: "active" });
      await storeA.close();

      // Agent B writes and compacts
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointThreshold: 1000,
      });
      await storeB.set("b", { name: "from-B", status: "active" });
      await storeB.compact();

      expect(storeB.stats().opsCount).toBe(0);
      expect(storeB.count()).toBe(2);
      expect(storeB.get("a")?.name).toBe("from-A");
      expect(storeB.get("b")?.name).toBe("from-B");
      await storeB.close();

      // Verify compacted state survives reopen
      const reader = new Store<TestRecord>();
      await reader.open(tmpDir, { agentId: "reader" });
      expect(reader.count()).toBe(2);
      expect(reader.get("a")?.name).toBe("from-A");
      expect(reader.get("b")?.name).toBe("from-B");
      await reader.close();
    });

    it("auto-checkpoints at threshold", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 3,
      });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });
      await store.set("c", { name: "C", status: "active" });

      // Threshold hit → auto-compacted
      expect(store.stats().opsCount).toBe(0);
      expect(store.count()).toBe(3);
      await store.close();
    });

    it("manifest tracks only compacting agent after compaction", async () => {
      // Two agents write
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a", { name: "from-A", status: "active" });
      await storeA.close();

      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointThreshold: 1000,
      });
      await storeB.set("b", { name: "from-B", status: "active" });
      await storeB.compact();
      await storeB.close();

      // Check manifest — only agent-B should be in activeAgentOps
      const manifest = JSON.parse(
        await readFile(join(tmpDir, "manifest.json"), "utf-8"),
      );
      expect(manifest.activeAgentOps).toBeDefined();
      expect(Object.keys(manifest.activeAgentOps)).toEqual(["agent-B"]);
    });
  });

  describe("refresh", () => {
    it("picks up writes from another agent", async () => {
      // Agent A opens
      const storeA = new Store<TestRecord>();
      await storeA.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeA.set("a", { name: "from-A", status: "active" });
      await storeA.close();

      // Agent B opens, writes
      const storeB = new Store<TestRecord>();
      await storeB.open(tmpDir, {
        agentId: "agent-B",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await storeB.set("b", { name: "from-B", status: "active" });
      await storeB.close();

      // Agent A reopens and refreshes
      const storeA2 = new Store<TestRecord>();
      await storeA2.open(tmpDir, {
        agentId: "agent-A",
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      // A should see both records after open (reads all agent WALs)
      expect(storeA2.get("a")?.name).toBe("from-A");
      expect(storeA2.get("b")?.name).toBe("from-B");
      await storeA2.close();
    });

    it("throws in single-writer mode", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await expect(store.refresh()).rejects.toThrow("multi-writer");
      await store.close();
    });
  });

  describe("archive in multi-writer mode", () => {
    it("archives and loads records", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 1000,
      });
      await store.set("a", { name: "A", status: "done" });
      await store.set("b", { name: "B", status: "active" });

      const count = await store.archive(
        (r) => r.status === "done",
        "2026-Q1",
      );
      expect(count).toBe(1);
      expect(store.count()).toBe(1);

      const archived = await store.loadArchive("2026-Q1");
      expect(archived.get("a")?.name).toBe("A");
      await store.close();
    });
  });

  describe("backward compatibility", () => {
    it("single-writer store works without agentId", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });

      const ops = store.getOps();
      expect(ops[0].agent).toBeUndefined();
      expect(ops[0].clock).toBeUndefined();

      await store.close();
    });

    it("multi-writer agent reads legacy single-writer store", async () => {
      // Create a single-writer store
      const sw = new Store<TestRecord>();
      await sw.open(tmpDir, {
        checkpointOnClose: false,
        checkpointThreshold: 1000,
      });
      await sw.set("legacy", { name: "Legacy", status: "active" });
      await sw.close();

      // Open with agentId — should read legacy ops
      const mw = new Store<TestRecord>();
      await mw.open(tmpDir, {
        agentId: "agent-A",
        checkpointThreshold: 1000,
      });
      expect(mw.get("legacy")?.name).toBe("Legacy");
      expect(mw.count()).toBe(1);
      await mw.close();
    });

    it("single-writer undo still works with O(1) truncate", async () => {
      const store = new Store<TestRecord>();
      await store.open(tmpDir, { checkpointThreshold: 1000 });
      await store.set("a", { name: "A", status: "active" });
      await store.set("b", { name: "B", status: "active" });

      const undone = await store.undo();
      expect(undone).toBe(true);
      expect(store.has("b")).toBe(false);
      expect(store.has("a")).toBe(true);
      await store.close();
    });
  });
});
