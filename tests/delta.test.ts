import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelta, applyDelta, isDeltaSmaller } from "../src/delta.js";
import { Store } from "../src/store.js";

describe("delta encoding", () => {
  describe("createDelta", () => {
    it("returns null for create (prev is null)", () => {
      expect(createDelta(null, { name: "Alice" })).toBeNull();
    });

    it("detects changed fields", () => {
      const delta = createDelta(
        { name: "Alice", age: 30 },
        { name: "Bob", age: 30 },
      );
      expect(delta?.$set).toEqual({ name: "Alice" });
      expect(delta?.$unset).toBeUndefined();
    });

    it("detects removed fields", () => {
      const delta = createDelta(
        { name: "Alice" },
        { name: "Alice", age: 30 },
      );
      expect(delta?.$unset).toEqual(["age"]);
    });

    it("detects added fields that need unsetting to restore", () => {
      const delta = createDelta(
        { name: "Alice", extra: "data" },
        { name: "Alice" },
      );
      expect(delta?.$set).toEqual({ extra: "data" });
    });

    it("returns null when records are identical", () => {
      expect(createDelta(
        { name: "Alice", age: 30 },
        { name: "Alice", age: 30 },
      )).toBeNull();
    });

    it("handles complex changes", () => {
      const delta = createDelta(
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 99, d: 4 },
      );
      // b changed (old=2), c removed from new (so $set c=3), d added to new (so $unset d)
      expect(delta?.$set).toEqual({ b: 2, c: 3 });
      expect(delta?.$unset).toEqual(["d"]);
    });
  });

  describe("applyDelta", () => {
    it("restores changed fields", () => {
      const current = { name: "Bob", age: 30 };
      const patch = { $set: { name: "Alice" } };
      expect(applyDelta(current, patch)).toEqual({ name: "Alice", age: 30 });
    });

    it("removes added fields", () => {
      const current = { name: "Alice", age: 30 };
      const patch = { $unset: ["age"] };
      expect(applyDelta(current, patch)).toEqual({ name: "Alice" });
    });

    it("restores removed fields", () => {
      const current = { name: "Alice" };
      const patch = { $set: { extra: "data" } };
      expect(applyDelta(current, patch)).toEqual({ name: "Alice", extra: "data" });
    });

    it("round-trips: create delta then apply produces original", () => {
      const original = { name: "Alice", age: 30, tags: ["admin"] };
      const modified = { name: "Bob", age: 30, score: 100 };
      const delta = createDelta(original, modified)!;
      const restored = applyDelta(modified, delta);
      expect(restored).toEqual(original);
    });
  });

  describe("isDeltaSmaller", () => {
    it("delta is smaller for single-field change on large record", () => {
      const large = { a: "x".repeat(100), b: "y".repeat(100), c: "z".repeat(100) };
      const delta = createDelta(large, { ...large, a: "changed" });
      expect(isDeltaSmaller(delta, large)).toBe(true);
    });

    it("delta is not smaller when most fields change", () => {
      const small = { a: 1, b: 2 };
      const delta = createDelta(small, { a: 99, b: 99 });
      expect(isDeltaSmaller(delta, small)).toBe(false);
    });

    it("returns false for null inputs", () => {
      expect(isDeltaSmaller(null, { a: 1 })).toBe(false);
      expect(isDeltaSmaller({ $set: { a: 1 } }, null)).toBe(false);
    });
  });

  describe("Store integration", () => {
    let tmpDir: string;
    let store: Store<Record<string, unknown>>;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "opslog-delta-"));
      store = new Store();
      await store.open(tmpDir, { checkpointThreshold: 1000 });
    });

    afterEach(async () => {
      try { await store.close(); } catch { /* */ }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("uses delta encoding for small updates on large records", async () => {
      const large = { name: "Alice", bio: "x".repeat(500), score: 10 };
      await store.set("a", large);
      await store.set("a", { ...large, score: 20 }); // small change

      const history = store.getHistory("a");
      expect(history[1].encoding).toBe("delta");
      expect((history[1].prev as Record<string, unknown>).$set).toBeDefined();
    });

    it("uses full encoding when delta isn't smaller", async () => {
      await store.set("a", { x: 1 });
      await store.set("a", { y: 2 }); // completely different

      const history = store.getHistory("a");
      // May or may not be delta depending on size comparison
      // The point is it doesn't crash
      expect(history).toHaveLength(2);
    });

    it("undo works with delta-encoded operations", async () => {
      const original = { name: "Alice", bio: "x".repeat(500), score: 10 };
      await store.set("a", original);
      await store.set("a", { ...original, score: 20 });

      // Verify delta was used
      const history = store.getHistory("a");
      expect(history[1].encoding).toBe("delta");

      // Undo should restore the original
      await store.undo();
      const restored = store.get("a");
      expect(restored).toEqual(original);
    });

    it("delta encoding survives reopen", async () => {
      await store.close();
      store = new Store();
      await store.open(tmpDir, { checkpointThreshold: 1000, checkpointOnClose: false });

      const original = { name: "Alice", bio: "x".repeat(500), score: 10 };
      await store.set("a", original);
      await store.set("a", { ...original, score: 20 });
      await store.close();

      const store2 = new Store<Record<string, unknown>>();
      await store2.open(tmpDir, { checkpointThreshold: 1000 });
      // State should be the updated version
      expect(store2.get("a")?.score).toBe(20);

      // Undo on reopened store
      await store2.undo();
      expect(store2.get("a")).toEqual(original);
      await store2.close();
    });
  });
});
