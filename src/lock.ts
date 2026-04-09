import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

const LOCK_FILE = ".lock";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an advisory write lock on a directory.
 * Returns a FileHandle that must be passed to releaseLock() on close.
 * Throws if another live process holds the lock.
 * Automatically recovers stale locks from crashed processes.
 */
export async function acquireLock(dir: string): Promise<FileHandle> {
  const lockPath = join(dir, LOCK_FILE);

  // Try exclusive create
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(String(process.pid), "utf-8");
    return fh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Lock file exists — check if the holder is still alive
  let content: string;
  try {
    content = await readFile(lockPath, "utf-8");
  } catch {
    // File disappeared between our open and read — retry
    return acquireLock(dir);
  }

  const pid = parseInt(content, 10);
  if (!isNaN(pid) && isProcessAlive(pid)) {
    throw new Error(
      `Store is locked by process ${pid}. If this is stale, delete ${lockPath}`,
    );
  }

  // Stale lock — remove and retry
  try {
    await unlink(lockPath);
  } catch {
    // Another process may have already cleaned it up
  }
  return acquireLock(dir);
}

/**
 * Release the advisory write lock.
 */
export async function releaseLock(dir: string, fh: FileHandle): Promise<void> {
  await fh.close();
  try {
    await unlink(join(dir, LOCK_FILE));
  } catch {
    // Already cleaned up
  }
}
