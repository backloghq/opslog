import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { Operation } from "./types.js";

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
  for (const line of lines) {
    try {
      ops.push(JSON.parse(line) as Operation<T>);
    } catch {
      // Skip malformed lines (crash recovery)
    }
  }
  return ops;
}

export async function truncateLastOp(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return false;
  }
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return false;
  lines.pop();
  const newContent = lines.length > 0 ? lines.join("\n") + "\n" : "";
  await writeFile(path, newContent, "utf-8");
  return true;
}
