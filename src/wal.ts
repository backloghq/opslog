import { appendFile, readFile, open } from "node:fs/promises";
import type { Operation } from "./types.js";
import { validateOp } from "./validate.js";

export async function appendOp<T>(path: string, op: Operation<T>): Promise<void> {
  await appendFile(path, JSON.stringify(op) + "\n", "utf-8");
}

export async function appendOps<T>(path: string, ops: Operation<T>[]): Promise<void> {
  const lines = ops.map((op) => JSON.stringify(op)).join("\n") + "\n";
  await appendFile(path, lines, "utf-8");
}

export async function readOps<T>(path: string): Promise<Operation<T>[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = content.trim().split("\n").filter(Boolean);
  const ops: Operation<T>[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      ops.push(validateOp<T>(JSON.parse(line)));
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(`opslog: skipped ${skipped} malformed line(s) in ${path}`);
  }
  return ops;
}

export async function truncateLastOp(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r+");
  } catch {
    return false;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;

    // Read the tail of the file to find the second-to-last newline.
    // 4KB handles operations up to ~4KB. For larger ops, read in chunks.
    let readSize = Math.min(4096, size);
    let readPos = size - readSize;
    let lastNl = -1;

    while (true) {
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, readPos);
      const text = buf.toString("utf-8", 0, readSize);

      // Find the second-to-last newline (skip trailing newline)
      lastNl = text.lastIndexOf("\n", text.length - 2);
      if (lastNl !== -1) {
        await fh.truncate(readPos + lastNl + 1);
        return true;
      }

      // No newline found in this chunk — need to read further back
      if (readPos === 0) {
        // Only one line in the entire file — truncate to empty
        await fh.truncate(0);
        return true;
      }

      // Read the next chunk further back
      const nextSize = Math.min(4096, readPos);
      readPos -= nextSize;
      readSize = nextSize;
    }
  } finally {
    await fh.close();
  }
}
