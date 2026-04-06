import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOp, appendOps, readOps, truncateLastOp } from "../src/wal.js";
import type { Operation } from "../src/types.js";

describe("WAL", () => {
  let tmpDir: string;
  let opsFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-wal-"));
    opsFile = join(tmpDir, "ops.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("appendOp", () => {
    it("appends a single operation as JSONL", async () => {
      const op: Operation = { ts: "2026-01-01T00:00:00Z", op: "set", id: "a", data: { x: 1 }, prev: null };
      await appendOp(opsFile, op);

      const content = await readFile(opsFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(op);
    });

    it("appends multiple operations sequentially", async () => {
      await appendOp(opsFile, { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null });
      await appendOp(opsFile, { ts: "2", op: "set", id: "b", data: { x: 2 }, prev: null });

      const content = await readFile(opsFile, "utf-8");
      expect(content.trim().split("\n")).toHaveLength(2);
    });
  });

  describe("appendOps", () => {
    it("appends multiple operations in one write", async () => {
      const ops: Operation[] = [
        { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null },
        { ts: "2", op: "set", id: "b", data: { x: 2 }, prev: null },
        { ts: "3", op: "delete", id: "a", prev: { x: 1 } },
      ];
      await appendOps(opsFile, ops);

      const read = await readOps(opsFile);
      expect(read).toHaveLength(3);
      expect(read[2].op).toBe("delete");
    });
  });

  describe("readOps", () => {
    it("returns empty array for non-existent file", async () => {
      const ops = await readOps(join(tmpDir, "nonexistent.jsonl"));
      expect(ops).toEqual([]);
    });

    it("skips malformed lines (crash recovery)", async () => {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(opsFile, '{"ts":"1","op":"set","id":"a","data":{"x":1},"prev":null}\nbroken json\n{"ts":"2","op":"set","id":"b","data":{"x":2},"prev":null}\n', "utf-8");

      const ops = await readOps(opsFile);
      expect(ops).toHaveLength(2);
      expect(ops[0].id).toBe("a");
      expect(ops[1].id).toBe("b");
    });
  });

  describe("truncateLastOp", () => {
    it("removes the last operation", async () => {
      await appendOp(opsFile, { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null });
      await appendOp(opsFile, { ts: "2", op: "set", id: "b", data: { x: 2 }, prev: null });

      const removed = await truncateLastOp(opsFile);
      expect(removed).toBe(true);

      const ops = await readOps(opsFile);
      expect(ops).toHaveLength(1);
      expect(ops[0].id).toBe("a");
    });

    it("returns false for non-existent file", async () => {
      const removed = await truncateLastOp(join(tmpDir, "nonexistent.jsonl"));
      expect(removed).toBe(false);
    });

    it("handles removing the only operation", async () => {
      await appendOp(opsFile, { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null });

      await truncateLastOp(opsFile);
      const ops = await readOps(opsFile);
      expect(ops).toHaveLength(0);
    });
  });
});
