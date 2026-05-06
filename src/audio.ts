import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { runProc } from "./run.js";

export async function extractAudio(projectPath: string): Promise<string> {
  const root = await resolveProject(projectPath);
  const src = await sourceVideoPath(projectPath);
  const out = path.join(root, "audio.wav");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await runProc(ffmpeg, [
    "-y", "-i", src,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    out,
  ]);
  return out;
}
