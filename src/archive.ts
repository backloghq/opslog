import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveSegment } from "./types.js";

export async function writeArchiveSegment<T>(
  dir: string,
  period: string,
  records: Map<string, T>,
): Promise<string> {
  const filename = `archive-${period}.json`;
  const path = join(dir, "archive", filename);
  const segment: ArchiveSegment<T> = {
    version: 1,
    period,
    timestamp: new Date().toISOString(),
    records: Object.fromEntries(records),
  };
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(segment, null, 2), "utf-8");
  await rename(tmpPath, path);
  return `archive/${filename}`;
}

export async function loadArchiveSegment<T>(
  dir: string,
  relativePath: string,
): Promise<Map<string, T>> {
  const path = join(dir, relativePath);
  const content = await readFile(path, "utf-8");
  const segment = JSON.parse(content) as ArchiveSegment<T>;
  return new Map(Object.entries(segment.records));
}

export async function listArchiveSegments(dir: string): Promise<string[]> {
  const archiveDir = join(dir, "archive");
  try {
    const files = await readdir(archiveDir);
    return files
      .filter((f) => f.startsWith("archive-") && f.endsWith(".json"))
      .map((f) => `archive/${f}`);
  } catch {
    return [];
  }
}
