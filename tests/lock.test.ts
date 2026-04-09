import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "../src/lock.js";

describe("lock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opslog-lock-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires a lock and writes PID", async () => {
    const fh = await acquireLock(tmpDir);
    const content = await readFile(join(tmpDir, ".lock"), "utf-8");
    expect(content).toBe(String(process.pid));
    await releaseLock(tmpDir, fh);
  });

  it("prevents second lock acquisition from same process", async () => {
    const fh = await acquireLock(tmpDir);
    await expect(acquireLock(tmpDir)).rejects.toThrow("Store is locked by process");
    await releaseLock(tmpDir, fh);
  });

  it("releases lock and cleans up file", async () => {
    const fh = await acquireLock(tmpDir);
    await releaseLock(tmpDir, fh);

    // Lock file should be gone
    const { access } = await import("node:fs/promises");
    await expect(access(join(tmpDir, ".lock"))).rejects.toThrow();
  });

  it("allows re-acquisition after release", async () => {
    const fh1 = await acquireLock(tmpDir);
    await releaseLock(tmpDir, fh1);

    const fh2 = await acquireLock(tmpDir);
    const content = await readFile(join(tmpDir, ".lock"), "utf-8");
    expect(content).toBe(String(process.pid));
    await releaseLock(tmpDir, fh2);
  });

  it("recovers stale lock from dead process", async () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is almost certainly not running
    await writeFile(join(tmpDir, ".lock"), "99999999", "utf-8");

    // Should recover the stale lock
    const fh = await acquireLock(tmpDir);
    const content = await readFile(join(tmpDir, ".lock"), "utf-8");
    expect(content).toBe(String(process.pid));
    await releaseLock(tmpDir, fh);
  });

  it("recovers lock with invalid PID content", async () => {
    // Lock file with non-numeric content
    await writeFile(join(tmpDir, ".lock"), "not-a-pid", "utf-8");

    // NaN PID should be treated as stale
    const fh = await acquireLock(tmpDir);
    expect(fh).toBeDefined();
    await releaseLock(tmpDir, fh);
  });

  it("releaseLock tolerates already-deleted lock file", async () => {
    const fh = await acquireLock(tmpDir);
    // Manually delete the lock file before release
    const { unlink } = await import("node:fs/promises");
    await unlink(join(tmpDir, ".lock"));

    // releaseLock should not throw
    await expect(releaseLock(tmpDir, fh)).resolves.toBeUndefined();
  });
});
