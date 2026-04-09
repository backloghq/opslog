import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "../src/backend.js";
import type { Manifest, Operation } from "../src/types.js";

describe("FsBackend", () => {
  let tmpDir: string;
  let backend: FsBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-backend-"));
    backend = new FsBackend();
    await backend.initialize(tmpDir, { readOnly: false });
  });

  afterEach(async () => {
    await backend.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("creates subdirectories", async () => {
      const { access } = await import("node:fs/promises");
      await expect(access(join(tmpDir, "snapshots"))).resolves.toBeUndefined();
      await expect(access(join(tmpDir, "ops"))).resolves.toBeUndefined();
      await expect(access(join(tmpDir, "archive"))).resolves.toBeUndefined();
    });

    it("skips directory creation in readOnly mode", async () => {
      const dir2 = await mkdtemp(join(tmpdir(), "opslog-backend-ro-"));
      const ro = new FsBackend();
      await ro.initialize(dir2, { readOnly: true });
      const { access } = await import("node:fs/promises");
      await expect(access(join(dir2, "snapshots"))).rejects.toThrow();
      await rm(dir2, { recursive: true, force: true });
    });
  });

  describe("manifest", () => {
    it("returns null for missing manifest", async () => {
      expect(await backend.readManifest()).toBeNull();
    });

    it("writes and reads a manifest", async () => {
      const manifest: Manifest = {
        version: 1,
        currentSnapshot: "snapshots/snap-1.json",
        activeOps: "ops/ops-1.jsonl",
        archiveSegments: [],
        stats: {
          activeRecords: 0,
          archivedRecords: 0,
          opsCount: 0,
          created: "2026-01-01T00:00:00Z",
          lastCheckpoint: "2026-01-01T00:00:00Z",
        },
      };
      await backend.writeManifest(manifest);
      const loaded = await backend.readManifest();
      expect(loaded).toEqual(manifest);
    });

    it("getManifestVersion returns non-null after write", async () => {
      const manifest: Manifest = {
        version: 1,
        currentSnapshot: "snapshots/snap-1.json",
        activeOps: "ops/ops-1.jsonl",
        archiveSegments: [],
        stats: {
          activeRecords: 0,
          archivedRecords: 0,
          opsCount: 0,
          created: "2026-01-01T00:00:00Z",
          lastCheckpoint: "2026-01-01T00:00:00Z",
        },
      };
      await backend.writeManifest(manifest);
      const ver = await backend.getManifestVersion();
      expect(ver).not.toBeNull();
    });

    it("getManifestVersion returns null when no manifest", async () => {
      expect(await backend.getManifestVersion()).toBeNull();
    });
  });

  describe("snapshots", () => {
    it("writes and loads a snapshot", async () => {
      const records = new Map<string, unknown>([
        ["a", { x: 1 }],
        ["b", { x: 2 }],
      ]);
      const path = await backend.writeSnapshot(records, 1);
      expect(path).toMatch(/^snapshots\/snap-\d+\.json$/);

      const loaded = await backend.loadSnapshot(path);
      expect(loaded.version).toBe(1);
      expect(loaded.records.get("a")).toEqual({ x: 1 });
      expect(loaded.records.get("b")).toEqual({ x: 2 });
    });
  });

  describe("WAL", () => {
    it("creates an empty ops file", async () => {
      const path = await backend.createOpsFile();
      expect(path).toMatch(/^ops\/ops-\d+\.jsonl$/);
      const content = await readFile(join(tmpDir, path), "utf-8");
      expect(content).toBe("");
    });

    it("appends and reads ops", async () => {
      const path = await backend.createOpsFile();
      const ops: Operation[] = [
        { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null },
        { ts: "2", op: "set", id: "b", data: { x: 2 }, prev: null },
      ];
      await backend.appendOps(path, ops);

      const loaded = await backend.readOps(path);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe("a");
      expect(loaded[1].id).toBe("b");
    });

    it("appends a single op", async () => {
      const path = await backend.createOpsFile();
      await backend.appendOps(path, [
        { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null },
      ]);
      const loaded = await backend.readOps(path);
      expect(loaded).toHaveLength(1);
    });

    it("truncates the last op", async () => {
      const path = await backend.createOpsFile();
      await backend.appendOps(path, [
        { ts: "1", op: "set", id: "a", data: { x: 1 }, prev: null },
        { ts: "2", op: "set", id: "b", data: { x: 2 }, prev: null },
      ]);
      const truncated = await backend.truncateLastOp(path);
      expect(truncated).toBe(true);

      const loaded = await backend.readOps(path);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("a");
    });

    it("readOps returns empty array for missing file", async () => {
      const ops = await backend.readOps("ops/nonexistent.jsonl");
      expect(ops).toEqual([]);
    });
  });

  describe("archive", () => {
    it("writes and loads an archive segment", async () => {
      const records = new Map<string, unknown>([["a", { x: 1 }]]);
      const path = await backend.writeArchiveSegment("2026-Q1", records);
      expect(path).toMatch(/^archive\/archive-2026-Q1\.json$/);

      const loaded = await backend.loadArchiveSegment(path);
      expect(loaded.get("a")).toEqual({ x: 1 });
    });

    it("lists archive segments", async () => {
      await backend.writeArchiveSegment(
        "2026-Q1",
        new Map([["a", { x: 1 }]]),
      );
      await backend.writeArchiveSegment(
        "2026-Q2",
        new Map([["b", { x: 2 }]]),
      );
      const segments = await backend.listArchiveSegments();
      expect(segments).toHaveLength(2);
      expect(segments).toContain("archive/archive-2026-Q1.json");
      expect(segments).toContain("archive/archive-2026-Q2.json");
    });

    it("returns empty list when no archives", async () => {
      const segments = await backend.listArchiveSegments();
      expect(segments).toEqual([]);
    });
  });

  describe("locking", () => {
    it("acquires and releases a write lock", async () => {
      const handle = await backend.acquireLock();
      const content = await readFile(join(tmpDir, ".lock"), "utf-8");
      expect(content).toBe(String(process.pid));
      await backend.releaseLock(handle);
    });

    it("prevents double lock acquisition", async () => {
      const handle = await backend.acquireLock();
      await expect(backend.acquireLock()).rejects.toThrow("locked");
      await backend.releaseLock(handle);
    });
  });

  describe("multi-writer extensions", () => {
    it("creates an agent-specific ops file", async () => {
      const path = await backend.createAgentOpsFile("agent-A");
      expect(path).toMatch(/^ops\/agent-agent-A-\d+\.jsonl$/);
      const content = await readFile(join(tmpDir, path), "utf-8");
      expect(content).toBe("");
    });

    it("lists all ops files", async () => {
      await backend.createOpsFile();
      await backend.createAgentOpsFile("A");
      await backend.createAgentOpsFile("B");
      const files = await backend.listOpsFiles();
      expect(files).toHaveLength(3);
    });

    it("acquires and releases a compaction lock", async () => {
      const handle = await backend.acquireCompactionLock();
      const content = await readFile(join(tmpDir, ".compact-lock"), "utf-8");
      expect(content).toBe(String(process.pid));
      await backend.releaseCompactionLock(handle);
    });

    it("prevents double compaction lock", async () => {
      const handle = await backend.acquireCompactionLock();
      await expect(backend.acquireCompactionLock()).rejects.toThrow(
        "Compaction lock",
      );
      await backend.releaseCompactionLock(handle);
    });
  });
});
