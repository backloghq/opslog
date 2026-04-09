import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

interface TestRecord {
  name: string;
  status: string;
}

describe("WAL tailing", () => {
  let tmpDir: string;
  let writer: Store<TestRecord>;
  let reader: Store<TestRecord>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-tail-"));
    writer = new Store<TestRecord>();
    await writer.open(tmpDir, { checkpointThreshold: 1000 });
  });

  afterEach(async () => {
    try { await reader?.close(); } catch { /* */ }
    try { await writer?.close(); } catch { /* */ }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("tail() returns empty when no new ops", async () => {
    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });
    const ops = await reader.tail();
    expect(ops).toHaveLength(0);
  });

  it("tail() picks up new ops from writer", async () => {
    // Writer writes data
    await writer.set("a", { name: "Alice", status: "active" });
    await writer.set("b", { name: "Bob", status: "active" });

    // Reader opens after writes
    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });
    expect(reader.count()).toBe(2); // Sees initial data

    // Writer adds more
    await writer.set("c", { name: "Charlie", status: "active" });

    // Reader tails to pick up the new op
    const newOps = await reader.tail();
    expect(newOps).toHaveLength(1);
    expect(newOps[0].id).toBe("c");
    expect(reader.count()).toBe(3);
    expect(reader.get("c")?.name).toBe("Charlie");
  });

  it("tail() is incremental — doesn't re-apply old ops", async () => {
    await writer.set("a", { name: "Alice", status: "active" });

    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });

    await writer.set("b", { name: "Bob", status: "active" });
    const first = await reader.tail();
    expect(first).toHaveLength(1);

    await writer.set("c", { name: "Charlie", status: "active" });
    const second = await reader.tail();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("c");

    expect(reader.count()).toBe(3);
  });

  it("tail() returns empty when no new writes", async () => {
    await writer.set("a", { name: "Alice", status: "active" });

    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });

    const ops = await reader.tail();
    expect(ops).toHaveLength(0); // Already saw everything on open
  });

  it("watch() calls callback on new ops", async () => {
    await writer.set("a", { name: "Alice", status: "active" });

    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });

    const received: string[] = [];
    reader.watch((ops) => {
      for (const op of ops) received.push(op.id);
    }, 50); // 50ms interval

    // Writer adds data
    await writer.set("b", { name: "Bob", status: "active" });

    // Wait for watch to pick it up
    await new Promise((r) => setTimeout(r, 200));

    reader.unwatch();
    expect(received).toContain("b");
  });

  it("unwatch() stops polling", async () => {
    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });

    let callCount = 0;
    reader.watch(() => { callCount++; }, 50);
    reader.unwatch();

    await writer.set("a", { name: "Alice", status: "active" });
    await new Promise((r) => setTimeout(r, 200));

    expect(callCount).toBe(0);
  });

  it("close() stops watch automatically", async () => {
    reader = new Store<TestRecord>();
    await reader.open(tmpDir, { readOnly: true });

    let callCount = 0;
    reader.watch(() => { callCount++; }, 50);
    await reader.close();

    await writer.set("a", { name: "Alice", status: "active" });
    await new Promise((r) => setTimeout(r, 200));

    expect(callCount).toBe(0);
  });
});
