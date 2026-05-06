import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Bump when plan-builder's HTML/JS output changes in a way that
// pre-existing cached plan.html files would not reflect (e.g. new tab,
// new filter, new bake-time data shape). Style + frame caches use the
// same constant in their per-file keys so they invalidate too.
export const CACHE_SCHEMA_VERSION = 4;

export type CacheKind = "plan-ui" | "style-thumb" | "clip-frame" | "probe";

// Cache lives in a folder named "cache" (no leading dot) so it survives
// Finder copies and tools that skip dotfiles. Everything in here is
// rebuildable but the rebuild is expensive, so a copy of the project
// folder must carry the cache with it.
export function cacheRoot(videoSubproject: string): string {
  return path.join(videoSubproject, "cache");
}

export function cachePath(
  videoSubproject: string,
  kind: CacheKind,
  key: string,
  ext: string,
): string {
  const name = ext ? `${key}.${ext}` : key;
  return path.join(cacheRoot(videoSubproject), kind, name);
}

export function cacheKey(parts: Record<string, unknown>): string {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

// Lightweight file signature for cache invalidation.
// This intentionally avoids full-file hashing: source videos can be multi-GB,
// and plan UI builds happen on the interactive path. It also avoids writing
// sidecar files next to user media. Copies may invalidate more often than a
// content hash would, but rebuilding derived cache is preferable to blocking
// the UI or cluttering source folders.
export type FileSig = { key: string; size: number; mtimeMs: number } | null;

export function fileSig(filePath: string): FileSig {
  if (!existsSync(filePath)) return null;
  return statSignature(filePath);
}

export function srcSignature(srcPath: string): { key: string; size: number; mtimeMs: number } {
  return statSignature(srcPath);
}

function statSignature(filePath: string): { key: string; size: number; mtimeMs: number } {
  const stat = statSync(filePath);
  const mtimeMs = Math.floor(stat.mtimeMs);
  const ino = typeof stat.ino === "number" ? stat.ino : 0;
  const dev = typeof stat.dev === "number" ? stat.dev : 0;
  return {
    key: `${dev}:${ino}:${stat.size}:${mtimeMs}`,
    size: stat.size,
    mtimeMs,
  };
}

export async function getOrCompute(
  outPath: string,
  produce: (outPath: string) => Promise<void>,
): Promise<string> {
  if (!existsSync(outPath)) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await produce(outPath);
  }
  return outPath;
}

// Marker file written into cache/. Future tooling can detect the cache
// schema and migrate or invalidate. Plain JSON, UTF-8.
export async function ensureCacheMarker(videoSubproject: string): Promise<void> {
  const root = cacheRoot(videoSubproject);
  const marker = path.join(root, ".aicw-cache-version.json");
  if (existsSync(marker)) return;
  await mkdir(root, { recursive: true });
  try {
    await writeFile(
      marker,
      JSON.stringify({ schema: CACHE_SCHEMA_VERSION, createdAt: new Date().toISOString() }, null, 2),
    );
  } catch { /* best-effort */ }
}
