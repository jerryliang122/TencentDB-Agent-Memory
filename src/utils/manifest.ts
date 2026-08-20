/**
 * Manifest — self-describing metadata for a memory-tdai data directory.
 *
 * Lives at `<dataDir>/.metadata/manifest.json`.
 *
 * - **store**: written once on first successful store init; never overwritten.
 *   On subsequent starts the current config is compared against the persisted
 *   store binding — mismatches are logged at debug level (informational only).
 * - **seed**: written once when a seed run completes; null for live-runtime dirs.
 *
 * This file is informational / read-only from the user's perspective.
 * The plugin reads it on startup for consistency checks.
 */

import fs from "node:fs";
import path from "node:path";

export interface ManifestStoreInfo {
  type: "sqlite";
  sqlite?: {
    path: string;
  };
}

export interface ManifestSeedInfo {
  inputFile?: string;
  sessions: number;
  rounds: number;
  messages: number;
  startedAt: string;
  completedAt: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  store: ManifestStoreInfo;
  seed: ManifestSeedInfo | null;
}

const METADATA_DIR = ".metadata";
const MANIFEST_FILE = "manifest.json";

export function manifestPath(dataDir: string): string {
  return path.join(dataDir, METADATA_DIR, MANIFEST_FILE);
}

export function readManifest(dataDir: string): Manifest | null {
  const p = manifestPath(dataDir);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

export function writeManifest(dataDir: string, manifest: Manifest): void {
  const dir = path.join(dataDir, METADATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath(dataDir),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

export interface StoreConfigSnapshot {
  type: "sqlite";
  sqlitePath?: string;
}

export function buildStoreInfo(snapshot: StoreConfigSnapshot): ManifestStoreInfo {
  return {
    type: snapshot.type,
    sqlite: { path: snapshot.sqlitePath ?? "vectors.db" },
  };
}

export function diffStoreBinding(
  persisted: ManifestStoreInfo,
  current: ManifestStoreInfo,
): string[] {
  const diffs: string[] = [];

  if (persisted.type !== current.type) {
    diffs.push(`store type changed: ${persisted.type} → ${current.type}`);
    return diffs;
  }

  if (persisted.sqlite?.path !== current.sqlite?.path) {
    diffs.push(`sqlite path changed: ${persisted.sqlite?.path} → ${current.sqlite?.path}`);
  }

  return diffs;
}
