import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "./types.js";

export async function writeSnapshot<T>(
  dir: string,
  records: Map<string, T>,
  version: number,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const filename = `snap-${Date.now()}.json`;
  const path = join(dir, "snapshots", filename);
  const snapshot: Snapshot<T> = {
    version,
    timestamp,
    records: Object.fromEntries(records),
  };
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
  await rename(tmpPath, path);
  return `snapshots/${filename}`;
}

export async function loadSnapshot<T>(
  dir: string,
  relativePath: string,
): Promise<{ records: Map<string, T>; version: number }> {
  const path = join(dir, relativePath);
  const content = await readFile(path, "utf-8");
  const snapshot = JSON.parse(content) as Snapshot<T>;
  const records = new Map(Object.entries(snapshot.records));
  return { records, version: snapshot.version };
}
