import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveSegment } from "./types.js";
import { validateArchiveSegment } from "./validate.js";

export async function writeArchiveSegment<T>(
  dir: string,
  period: string,
  records: Map<string, T>,
): Promise<string> {
  const filename = `archive-${period}.json`;
  const path = join(dir, "archive", filename);
  // Merge with existing archive if present
  let existing: Record<string, T> = {};
  try {
    const content = await readFile(path, "utf-8");
    const parsed = validateArchiveSegment<T>(JSON.parse(content));
    existing = parsed.records;
  } catch {
    // First write to this period
  }
  const merged = { ...existing, ...Object.fromEntries(records) };
  const segment: ArchiveSegment<T> = {
    version: 1,
    period,
    timestamp: new Date().toISOString(),
    records: merged,
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
  const segment = validateArchiveSegment<T>(JSON.parse(content));
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
