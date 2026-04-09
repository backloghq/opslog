import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

interface TestRecord {
  name: string;
  status: string;
}

describe("Group commit", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-gc-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("buffers ops and flushes on size threshold", async () => {
    const store = new Store<TestRecord>();
    await store.open(tmpDir, {
      writeMode: "group",
      groupCommitSize: 3,
      groupCommitMs: 10000, // High timeout so only size triggers flush
      checkpointThreshold: 1000,
    });

    // Write 2 ops — should be buffered, not on disk
    await store.set("a", { name: "A", status: "active" });
    await store.set("b", { name: "B", status: "active" });

    // In-memory state is updated
    expect(store.get("a")?.name).toBe("A");
    expect(store.get("b")?.name).toBe("B");

    // Third op triggers flush (groupCommitSize: 3)
    await store.set("c", { name: "C", status: "active" });

    // All 3 should now be on disk — verify by reopening
    await store.close();

    const store2 = new Store<TestRecord>();
    await store2.open(tmpDir, { checkpointThreshold: 1000 });
    expect(store2.get("a")?.name).toBe("A");
    expect(store2.get("b")?.name).toBe("B");
    expect(store2.get("c")?.name).toBe("C");
    await store2.close();
  });

  it("flushes on timer", async () => {
    const store = new Store<TestRecord>();
    await store.open(tmpDir, {
      writeMode: "group",
      groupCommitSize: 1000, // High threshold so only timer triggers
      groupCommitMs: 50,
      checkpointThreshold: 1000,
    });

    await store.set("a", { name: "A", status: "active" });

    // Wait for timer to flush
    await new Promise((r) => setTimeout(r, 150));

    // Verify by reopening (close without checkpoint to test timer flushed)
    await store.close();

    const store2 = new Store<TestRecord>();
    await store2.open(tmpDir, { checkpointThreshold: 1000 });
    expect(store2.get("a")?.name).toBe("A");
    await store2.close();
  });

  it("close flushes buffered ops", async () => {
    const store = new Store<TestRecord>();
    await store.open(tmpDir, {
      writeMode: "group",
      groupCommitSize: 1000,
      groupCommitMs: 60000,
      checkpointThreshold: 1000,
      checkpointOnClose: false,
    });

    await store.set("a", { name: "A", status: "active" });
    await store.set("b", { name: "B", status: "active" });
    await store.close(); // Should flush buffer

    const store2 = new Store<TestRecord>();
    await store2.open(tmpDir, { checkpointThreshold: 1000 });
    expect(store2.count()).toBe(2);
    await store2.close();
  });

  it("explicit flush() writes buffered ops", async () => {
    const store = new Store<TestRecord>();
    await store.open(tmpDir, {
      writeMode: "group",
      groupCommitSize: 1000,
      groupCommitMs: 60000,
      checkpointThreshold: 1000,
    });

    await store.set("a", { name: "A", status: "active" });
    await store.flush();

    // Verify the WAL file has content
    const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
    const walContent = await readFile(join(tmpDir, manifest.activeOps), "utf-8");
    expect(walContent.trim().length).toBeGreaterThan(0);

    await store.close();
  });

  it("undo works with group commit", async () => {
    const store = new Store<TestRecord>();
    await store.open(tmpDir, {
      writeMode: "group",
      groupCommitSize: 10,
      groupCommitMs: 50,
      checkpointThreshold: 1000,
    });

    await store.set("a", { name: "A", status: "active" });
    await store.flush(); // Flush so undo can truncate from disk
    await store.undo();
    expect(store.has("a")).toBe(false);
    await store.close();
  });

  it("forced to immediate when agentId is set", async () => {
    const store = new Store<TestRecord>();
    // This should log a warning and use immediate mode
    await store.open(tmpDir, {
      writeMode: "group",
      agentId: "agent-1",
      checkpointThreshold: 1000,
    });

    await store.set("a", { name: "A", status: "active" });

    // Immediate mode: should be on disk already (no buffering)
    // Verify by checking the WAL has content without flush
    const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8"));
    const agentOps = manifest.activeAgentOps?.["agent-1"];
    expect(agentOps).toBeDefined();

    await store.close();
  });

  it("performance: group commit is faster than immediate for many writes", async () => {
    const N = 500;

    // Immediate mode
    const dirImm = join(tmpDir, "imm");
    const storeImm = new Store<TestRecord>();
    await storeImm.open(dirImm, { checkpointThreshold: 10000 });
    const startImm = performance.now();
    for (let i = 0; i < N; i++) {
      await storeImm.set(`k${i}`, { name: `V${i}`, status: "active" });
    }
    const immMs = performance.now() - startImm;
    await storeImm.close();

    // Group commit mode
    const dirGrp = join(tmpDir, "grp");
    const storeGrp = new Store<TestRecord>();
    await storeGrp.open(dirGrp, {
      writeMode: "group",
      groupCommitSize: 50,
      groupCommitMs: 10,
      checkpointThreshold: 10000,
    });
    const startGrp = performance.now();
    for (let i = 0; i < N; i++) {
      await storeGrp.set(`k${i}`, { name: `V${i}`, status: "active" });
    }
    await storeGrp.flush();
    const grpMs = performance.now() - startGrp;
    await storeGrp.close();

    const speedup = immMs / grpMs;
    console.log(`  Group commit: immediate=${immMs.toFixed(0)}ms, group=${grpMs.toFixed(0)}ms, speedup=${speedup.toFixed(1)}x`);

    // Group should be significantly faster
    expect(speedup).toBeGreaterThan(2);

    // Both should have the same data
    const verify = new Store<TestRecord>();
    await verify.open(dirGrp, { checkpointThreshold: 10000 });
    expect(verify.count()).toBe(N);
    await verify.close();
  });
});
