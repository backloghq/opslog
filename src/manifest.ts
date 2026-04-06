import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "./types.js";

const MANIFEST_FILE = "manifest.json";

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const content = await readFile(join(dir, MANIFEST_FILE), "utf-8");
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const path = join(dir, MANIFEST_FILE);
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
  await rename(tmpPath, path);
}

export function createDefaultManifest(snapshotPath: string, opsPath: string): Manifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    currentSnapshot: snapshotPath,
    activeOps: opsPath,
    archiveSegments: [],
    stats: {
      activeRecords: 0,
      archivedRecords: 0,
      opsCount: 0,
      created: now,
      lastCheckpoint: now,
    },
  };
}
