#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const faceModule = await import(path.join(repoRoot, "dist", "face-emojis.js"));
const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes("--verbose") || truthy(process.env.DEBUG_MODE) || truthy(process.env.AICW_VIDEO_DEBUG);
const force = rawArgs.includes("--force");
const outDirs = rawArgs.filter((arg) => arg !== "--verbose" && arg !== "--force");
const dirs = outDirs.length > 0
  ? outDirs
  : [path.join("dist", "assets", "face-emojis")];

for (const dir of dirs) {
  await mkdir(dir, { recursive: true });
}

let written = 0;
let skipped = 0;
let sharp;

for (const opt of faceModule.FACE_EMOJI_OPTIONS) {
  const missingPaths = dirs
    .map((dir) => path.join(dir, opt.file))
    .filter((outPath) => force || !existsSync(outPath));
  skipped += dirs.length - missingPaths.length;
  if (missingPaths.length === 0) {
    if (verbose) console.log(`face emoji ${opt.emoji} exists; skipped`);
    continue;
  }

  const svg = faceModule.faceEmojiPresetSvg(opt.emoji);
  sharp ??= (await import("sharp")).default;
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
  for (const outPath of missingPaths) {
    await writeFile(outPath, png);
    written++;
    if (verbose) console.log(`face emoji ${opt.emoji} -> ${outPath}`);
  }
}

for (const kind of ["speaking"]) {
  const file = faceModule.faceMouthAssetFile(kind);
  const missingPaths = dirs
    .map((dir) => path.join(dir, file))
    .filter((outPath) => force || !existsSync(outPath));
  skipped += dirs.length - missingPaths.length;
  if (missingPaths.length === 0) {
    if (verbose) console.log(`face mouth ${kind} exists; skipped`);
    continue;
  }
  const svg = faceModule.faceMouthPresetSvg(kind);
  sharp ??= (await import("sharp")).default;
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
  for (const outPath of missingPaths) {
    await writeFile(outPath, png);
    written++;
    if (verbose) console.log(`face mouth ${kind} -> ${outPath}`);
  }
}

if (written > 0 && !verbose) {
  console.log(`face emoji assets generated: ${written} written, ${skipped} up to date`);
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
