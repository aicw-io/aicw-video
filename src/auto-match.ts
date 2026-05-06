import { mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { harvestAnchors } from "./transcript-match.js";
import { replaceAudio } from "./replace-audio.js";
import { backupIfExists } from "./backup.js";
import {
  loadProjectV2,
  type SourceFile,
  type SourceDescription,
  type ProjectV2,
} from "./project-v2.js";

// Auto-match audio files to videos and apply replace-audio per video.
//
// Pipeline (per project, after describe-all):
//   1. Score every (video, audio) pair by harvestAnchors() on cached
//      transcripts. Best match per video wins, with the same threshold
//      as match-audio.ts (≥6 matched words AND >= runner-up + 3).
//   2. For each video: create <project>/<videoSlug>/ as a per-video
//      subproject. Copy the source video → video.<ext>. Copy the
//      matched audio → audio_1.<ext> + its sidecar JSON.
//   3. Run replaceAudio() on the subproject. Outputs go to
//      <subproject>/replace-audio/...mp4. Then copy that result over
//      video.mp4 (with backupIfExists for reversibility) and delete
//      the audio_1.* files since the cleaner audio is now baked in.
//   4. Yield progress events so the hub can stream them.
//
// `_sources/` is never modified.

export type AutoMatchEvent =
  | { type: "start"; videoCount: number; audioCount: number }
  | { type: "matching"; videoFile: string }
  | { type: "matched"; videoFile: string; audioFile: string; score: number }
  | { type: "no-match"; videoFile: string }
  | { type: "materialising"; videoFile: string }
  | { type: "replacing"; videoFile: string; audioFile: string }
  | { type: "applied"; videoFile: string; offsetMs: number; matchedPhrase: string }
  | { type: "skipped"; videoFile: string; reason: string }
  | { type: "error"; videoFile?: string; message: string }
  | { type: "done"; matched: number; replaced: number; orphans: string[] };

type Score = {
  audio: SourceFile;
  totalMatchedWords: number;
  longestAnchor: number;
};

export async function* autoMatchAndReplace(
  projectRoot: string,
  opts: { force?: boolean } = {},
): AsyncGenerator<AutoMatchEvent> {
  const project = await loadProjectV2(projectRoot);
  if (!project) {
    yield { type: "error", message: "not a v2 project" };
    return;
  }
  yield {
    type: "start",
    videoCount: project.sourceVideos.length,
    audioCount: project.sourceAudios.length,
  };

  // Audios already pinned by an existing match — never reuse them
  // unless the caller asked for a full re-match. Without this we'd
  // happily steal Achajour 2.m4a from IMG_6980 to match a newly-added
  // IMG_6984 just because it scored higher.
  const usedAudios = new Set<string>();
  if (!opts.force) {
    for (const v of project.videos) {
      if (v.matchedAudio) usedAudios.add(v.matchedAudio.sourcePath);
    }
  }
  const replacedVideos: string[] = [];

  for (const video of project.sourceVideos) {
    // In normal (non-force) mode, skip videos that already have a
    // working match marker — leave them alone.
    if (!opts.force) {
      const existing = project.videos.find((v) => v.slug === video.slug);
      if (existing?.matchedAudio) {
        yield { type: "skipped", videoFile: video.originalName, reason: "already matched (skip in non-force mode)" };
        continue;
      }
    }
    yield { type: "matching", videoFile: video.originalName };

    // Need the description sidecar to read transcripts.
    if (!video.description?.transcript?.words?.length) {
      yield { type: "skipped", videoFile: video.originalName, reason: "video has no transcript yet — run Describe all first" };
      continue;
    }

    // Score each audio.
    const scores: Score[] = [];
    for (const audio of project.sourceAudios) {
      if (usedAudios.has(audio.sourcePath)) continue;
      if (!audio.description?.transcript?.words?.length) continue;
      const anchors = harvestAnchors(
        video.description.transcript.words,
        audio.description.transcript.words,
      );
      const total = anchors.reduce((s, a) => s + a.length, 0);
      const longest = anchors.reduce((m, a) => Math.max(m, a.length), 0);
      scores.push({ audio, totalMatchedWords: total, longestAnchor: longest });
    }
    scores.sort((a, b) => b.totalMatchedWords - a.totalMatchedWords);
    const top = scores[0];
    const runnerUp = scores[1];
    const passes =
      top &&
      top.totalMatchedWords >= 6 &&
      (!runnerUp || top.totalMatchedWords >= runnerUp.totalMatchedWords + 3);

    // Create the per-video subproject (always; even without a match
    // we still want video.mp4 there so the user can plan/render it).
    yield { type: "materialising", videoFile: video.originalName };
    const subprojectRoot = await materialiseVideoSubproject(projectRoot, video, passes ? top.audio : undefined);

    if (!passes) {
      yield { type: "no-match", videoFile: video.originalName };
      continue;
    }
    usedAudios.add(top!.audio.sourcePath);
    yield {
      type: "matched",
      videoFile: video.originalName,
      audioFile: top!.audio.originalName,
      score: top!.totalMatchedWords,
    };

    // Run replace-audio inside the subproject.
    yield { type: "replacing", videoFile: video.originalName, audioFile: top!.audio.originalName };
    try {
      const audioInSubproject = path.join(subprojectRoot, `audio_1${path.extname(top!.audio.originalName)}`);
      const result = await replaceAudio(subprojectRoot, audioInSubproject);
      // Apply the replaced output over video.mp4 (with backupIfExists
      // so the original copy is preserved).
      const videoFile = pickVideoInDir(subprojectRoot);
      if (videoFile) {
        await backupIfExists(videoFile);
        await copyFile(result.outPath, videoFile);
      }
      // Clean up the now-unused audio_1.* files (we have the cleaner
      // audio baked into video.mp4; sources still in _sources/).
      try { await rm(audioInSubproject); } catch { /* fine */ }
      try { await rm(audioInSubproject + ".json"); } catch { /* fine */ }
      replacedVideos.push(video.originalName);
      // Persist which audio was matched so the project page can show it
      // and orphans = audios with no .match-meta.json reference.
      await writeFile(
        path.join(subprojectRoot, ".match-meta.json"),
        JSON.stringify(
          {
            audioOriginalName: top!.audio.originalName,
            audioSourcePath: top!.audio.sourcePath,
            totalMatchedWords: top!.totalMatchedWords,
            offsetMs: result.offsetMs,
            matchedPhrase: result.matchedPhrase,
            appliedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      yield {
        type: "applied",
        videoFile: video.originalName,
        offsetMs: result.offsetMs,
        matchedPhrase: result.matchedPhrase,
      };
    } catch (e) {
      yield {
        type: "error",
        videoFile: video.originalName,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const orphans = project.sourceAudios
    .filter((a) => !usedAudios.has(a.sourcePath))
    .map((a) => a.originalName);
  yield {
    type: "done",
    matched: usedAudios.size,
    replaced: replacedVideos.length,
    orphans,
  };
}

// Materialise <project>/<videoSlug>/ as a working folder.
//   ├── video.<ext>            — copy of the source video
//   ├── video.json             — copy of the source description
//   ├── audio_1.<ext>          — matched audio (only if matched)
//   └── audio_1.<ext>.json     — matched audio's description
export async function materialiseVideoSubproject(
  projectRoot: string,
  video: SourceFile,
  matched?: SourceFile,
  opts: { refreshDescription?: boolean } = {},
): Promise<string> {
  const subprojectRoot = path.join(projectRoot, video.slug);
  await mkdir(subprojectRoot, { recursive: true });

  const ext = path.extname(video.originalName);
  const videoTarget = path.join(subprojectRoot, `video${ext}`);
  if (!existsSync(videoTarget)) {
    await copyFile(video.sourcePath, videoTarget);
  }
  // Copy of description for convenience (so per-video tools can read it
  // without going back to _sources/).
  const descJsonTarget = path.join(subprojectRoot, "video.json");
  const descSource = `${video.sourcePath}.json`;
  if (existsSync(descSource) && (opts.refreshDescription || !existsSync(descJsonTarget))) {
    const desc = JSON.parse(await readFile(descSource, "utf-8")) as SourceDescription;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(descJsonTarget, JSON.stringify(desc, null, 2)),
    );
  }

  if (matched) {
    const audioExt = path.extname(matched.originalName);
    const audioTarget = path.join(subprojectRoot, `audio_1${audioExt}`);
    if (!existsSync(audioTarget)) {
      await copyFile(matched.sourcePath, audioTarget);
    }
    const audioJsonTarget = `${audioTarget}.json`;
    const audioJsonSource = `${matched.sourcePath}.json`;
    if (existsSync(audioJsonSource) && !existsSync(audioJsonTarget)) {
      await copyFile(audioJsonSource, audioJsonTarget);
    }
  }
  return subprojectRoot;
}

function pickVideoInDir(dir: string): string | null {
  for (const ext of [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]) {
    const p = path.join(dir, `video${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

void {} as ProjectV2 | undefined;
