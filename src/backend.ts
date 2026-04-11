import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockHandle, Manifest, Operation, StorageBackend } from "./types.js";
import { appendOp, appendOps, readOps, truncateLastOp } from "./wal.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";
import { readManifest, writeManifest } from "./manifest.js";
import {
  loadArchiveSegment,
  writeArchiveSegment,
  listArchiveSegments as fsListArchiveSegments,
} from "./archive.js";
import {
  acquireLock as fsAcquireLock,
  releaseLock as fsReleaseLock,
} from "./lock.js";

class FsLockHandle implements LockHandle {
  constructor(
    readonly fh: FileHandle,
    readonly dir: string,
  ) {}
}

/** Filesystem-backed storage backend. Default backend for opslog. */
export class FsBackend implements StorageBackend {
  private dir = "";

  async initialize(dir: string, opts: { readOnly: boolean }): Promise<void> {
    this.dir = dir;
    if (!opts.readOnly) {
      await mkdir(join(dir, "snapshots"), { recursive: true });
      await mkdir(join(dir, "ops"), { recursive: true });
      await mkdir(join(dir, "archive"), { recursive: true });
    }
  }

  async shutdown(): Promise<void> {
    // No-op for filesystem backend
  }

  // -- Manifest --

  async readManifest(): Promise<Manifest | null> {
    return readManifest(this.dir);
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    return writeManifest(this.dir, manifest);
  }

  // -- Snapshots --

  async writeSnapshot(
    records: Map<string, unknown>,
    version: number,
  ): Promise<string> {
    return writeSnapshot(this.dir, records, version);
  }

  async loadSnapshot(
    relativePath: string,
  ): Promise<{ records: Map<string, unknown>; version: number }> {
    return loadSnapshot(this.dir, relativePath);
  }

  // -- WAL --

  async appendOps(relativePath: string, ops: Operation[]): Promise<void> {
    const fullPath = join(this.dir, relativePath);
    if (ops.length === 1) {
      return appendOp(fullPath, ops[0]);
    }
    return appendOps(fullPath, ops);
  }

  async readOps(relativePath: string): Promise<Operation[]> {
    return readOps(join(this.dir, relativePath));
  }

  async truncateLastOp(relativePath: string): Promise<boolean> {
    return truncateLastOp(join(this.dir, relativePath));
  }

  async createOpsFile(): Promise<string> {
    const filename = `ops-${Date.now()}.jsonl`;
    const relativePath = `ops/${filename}`;
    await writeFile(join(this.dir, relativePath), "", "utf-8");
    return relativePath;
  }

  // -- Archive --

  async writeArchiveSegment(
    period: string,
    records: Map<string, unknown>,
  ): Promise<string> {
    return writeArchiveSegment(this.dir, period, records);
  }

  async loadArchiveSegment(
    relativePath: string,
  ): Promise<Map<string, unknown>> {
    return loadArchiveSegment(this.dir, relativePath);
  }

  async listArchiveSegments(): Promise<string[]> {
    return fsListArchiveSegments(this.dir);
  }

  // -- Locking (single-writer) --

  async acquireLock(): Promise<LockHandle> {
    const fh = await fsAcquireLock(this.dir);
    return new FsLockHandle(fh, this.dir);
  }

  async releaseLock(handle: LockHandle): Promise<void> {
    const fsHandle = handle as FsLockHandle;
    return fsReleaseLock(fsHandle.dir, fsHandle.fh);
  }

  // -- Multi-writer extensions --

  async createAgentOpsFile(agentId: string): Promise<string> {
    const filename = `agent-${agentId}-${Date.now()}.jsonl`;
    const relativePath = `ops/${filename}`;
    await writeFile(join(this.dir, relativePath), "", "utf-8");
    return relativePath;
  }

  async listOpsFiles(): Promise<string[]> {
    const opsDir = join(this.dir, "ops");
    try {
      const files = await readdir(opsDir);
      return files.filter((f) => f.endsWith(".jsonl")).map((f) => `ops/${f}`);
    } catch {
      return [];
    }
  }

  async acquireCompactionLock(): Promise<LockHandle> {
    const lockPath = join(this.dir, ".compact-lock");
    let fh: FileHandle;
    try {
      fh = await open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Compaction lock held by another agent", { cause: err });
      }
      throw err;
    }
    await fh.writeFile(String(process.pid), "utf-8");
    return new FsLockHandle(fh, this.dir);
  }

  async releaseCompactionLock(handle: LockHandle): Promise<void> {
    const fsHandle = handle as FsLockHandle;
    await fsHandle.fh.close();
    try {
      await unlink(join(fsHandle.dir, ".compact-lock"));
    } catch {
      // Already cleaned up
    }
  }

  async getManifestVersion(): Promise<string | null> {
    try {
      const s = await stat(join(this.dir, "manifest.json"));
      return s.mtimeMs.toString();
    } catch {
      return null;
    }
  }

  // -- Blob storage --

  async writeBlob(relativePath: string, content: Buffer): Promise<void> {
    const fullPath = join(this.dir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async readBlob(relativePath: string): Promise<Buffer> {
    return readFile(join(this.dir, relativePath));
  }

  async readBlobRange(relativePath: string, offset: number, length: number): Promise<Buffer> {
    const fd = await open(join(this.dir, relativePath), "r");
    try {
      const buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, offset);
      return buf;
    } finally {
      await fd.close();
    }
  }

  async listBlobs(prefix: string): Promise<string[]> {
    try {
      return await readdir(join(this.dir, prefix));
    } catch {
      return [];
    }
  }

  async deleteBlob(relativePath: string): Promise<void> {
    try {
      await unlink(join(this.dir, relativePath));
    } catch { /* ignore if not found */ }
  }

  async deleteBlobDir(prefix: string): Promise<void> {
    await rm(join(this.dir, prefix), { recursive: true, force: true });
  }
}
