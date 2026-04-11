import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { validateSnapshot } from "./validate.js";

/**
 * JSONL snapshot format:
 *   Line 1: {"version":1,"timestamp":"..."}
 *   Line 2+: {"id":"abc","data":{...}}
 *
 * Previous format (monolithic JSON) is still readable for backward compat.
 */

interface SnapshotHeader {
  version: number;
  timestamp: string;
}

export async function writeSnapshot<T>(
  dir: string,
  records: Map<string, T>,
  version: number,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const filename = `snap-${Date.now()}.jsonl`;
  const path = join(dir, "snapshots", filename);

  const lines: string[] = [];
  lines.push(JSON.stringify({ version, timestamp }));
  for (const [id, data] of records) {
    lines.push(JSON.stringify({ id, data }));
  }

  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, lines.join("\n") + "\n", "utf-8");
  await rename(tmpPath, path);
  return `snapshots/${filename}`;
}

export async function loadSnapshot<T>(
  dir: string,
  relativePath: string,
): Promise<{ records: Map<string, T>; version: number }> {
  const path = join(dir, relativePath);
  const content = await readFile(path, "utf-8");

  // Detect format: JSONL (first line is header without "records" key) vs legacy JSON
  const firstNewline = content.indexOf("\n");
  const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
  const parsed = JSON.parse(firstLine);

  if ("records" in parsed) {
    // Legacy monolithic JSON format
    const snapshot = validateSnapshot<T>(parsed);
    const records = new Map(Object.entries(snapshot.records));
    return { records, version: snapshot.version };
  }

  // JSONL format: first line is header, remaining lines are records
  const header = parsed as SnapshotHeader;
  const records = new Map<string, T>();
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = JSON.parse(line) as { id: string; data: T };
    records.set(entry.id, entry.data);
  }
  return { records, version: header.version };
}

/**
 * Stream snapshot records line by line using readline.
 * True streaming — only one record in memory at a time.
 * Supports both JSONL and legacy JSON formats.
 */
export async function* streamSnapshotFile<T>(
  dir: string,
  relativePath: string,
): AsyncGenerator<[string, T], { version: number }> {
  const path = join(dir, relativePath);

  // Peek at first line to detect format
  const content = await readFile(path, "utf-8");
  const firstNewline = content.indexOf("\n");
  const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
  const parsed = JSON.parse(firstLine);

  if ("records" in parsed) {
    // Legacy JSON: must load all, then yield
    const snapshot = validateSnapshot<T>(parsed);
    for (const [id, record] of Object.entries(snapshot.records)) {
      yield [id, record as T];
    }
    return { version: snapshot.version };
  }

  // JSONL: stream line by line via readline
  const header = parsed as SnapshotHeader;
  const rl = createInterface({
    input: createReadStream(path, "utf-8"),
    crlfDelay: Infinity,
  });

  let isFirst = true;
  for await (const line of rl) {
    if (isFirst) { isFirst = false; continue; } // skip header
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as { id: string; data: T };
    yield [entry.id, entry.data];
  }
  return { version: header.version };
}
