import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, mkdir, rename, rm, stat, readlink } from "node:fs/promises";
import { existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";
import crypto from "node:crypto";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import {
  PlanSchema,
  renderAllShorts,
  renderShort,
  renderClipVariants,
  RENDER_VARIANTS,
  type RenderStreamEvent,
  type RenderVariant,
} from "./shorts.js";
import { replaceAudio } from "./replace-audio.js";
import { backupIfExists } from "./backup.js";
import { generateVoiceoverTrack } from "./voiceover.js";
import { runProc } from "./run.js";
import { buildClipTutorial, type ClipTutorialPoint } from "./tutorial-aicw.js";
import { describeAllSources } from "./describe-sources.js";
import { PROJECT_META_FILE, loadProjectV2, type ProjectMeta, type SourceDescription, type VisualMomentMetadata } from "./project-v2.js";
import { materialiseVideoSubproject } from "./auto-match.js";
import { prepareV2VideoForPlanning } from "./v2-plan-prep.js";
import { buildPlanUi } from "./plan-builder.js";

export interface PlanServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const RENDER_TMP_TTL_MS = 24 * 60 * 60 * 1000;
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

// Tiny HTTP server that backs the plan-builder UI.
// - Serves files from the plan dir (the generated plan.html and source.mp4).
// - POST /api/save writes the user's plan back to <project>/shorts/plan.json.
// - GET  /api/renders lists every shorts/render-*/ folder so the UI can show
//   download links for previous render iterations.
// - GET  /renders/<folder>/<file> streams a rendered mp4 for in-browser preview.
export async function startPlanServer(
  planDir: string,
  projectPath: string,
  opts: { port?: number } = {},
): Promise<PlanServerHandle> {
  const root = await resolveProject(projectPath);
  await cleanupExpiredRenderSessions(root);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      const pathname = decodeURIComponent(u.pathname);
      const handled = await handlePlanRequest(req, res, pathname, planDir, projectPath, root);
      if (handled) return;
      text(res, 404, "not found");
    } catch (e) {
      text(res, 500, `error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const port = await listen(server, opts.port ?? 8765);
  const url = `http://127.0.0.1:${port}/plan.html`;
  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Handle one plan-UI request. `pathname` is the route-relative path (the
// caller has already stripped any mount prefix like "/p/<slug>"). Returns
// true if the request was handled, false if the caller should fall
// through to its own 404 / other routes. Used both by the standalone
// plan-server (above) and by the hub when it mounts the plan UI under
// /p/<slug>/ so navigation stays in one window.
export async function handlePlanRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  planDir: string,
  projectPath: string,
  root: string,
  basePath = "",
): Promise<boolean> {
  try {
      // ── API: save plan
      if (req.method === "POST" && pathname === "/api/save") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        const validated = PlanSchema.parse(data);
        const planPath = path.join(root, "shorts", "plan.json");
        await mkdir(path.dirname(planPath), { recursive: true });
        await writeFile(planPath, JSON.stringify(validated, null, 2));
        json(res, 200, { saved: planPath, clip_count: validated.clips.length });
        return true;
      }

      // ── API: list available render size variants for the dialog.
      if (req.method === "GET" && pathname === "/api/render-variants") {
        json(res, 200, { variants: RENDER_VARIANTS });
        return true;
      }

      // ── API: open the current video subproject folder in Finder.
      if (req.method === "POST" && pathname === "/api/open-video-folder") {
        const command = `open ${shellQuote(root)}`;
        if (process.platform !== "darwin") {
          json(res, 200, { ok: false, path: root, command, error: "opening folders is only wired for macOS" });
          return true;
        }
        const child = spawn("open", [root], { detached: true, stdio: "ignore" });
        child.unref();
        json(res, 200, { ok: true, path: root, command });
        return true;
      }

      // ── API: re-describe just this v2 source video and refresh the current
      // plan with any new visual metadata (faces/crops/privacy). Existing clip
      // ranges, titles, captions, and settings remain in shorts/plan.json.
      if (req.method === "POST" && pathname === "/api/reanalyze-video") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          let parsed: { aiSceneAnalysis?: boolean } = {};
          try { parsed = JSON.parse(body || "{}"); } catch { parsed = {}; }
          const projectRoot = path.dirname(root);
          const videoSlug = path.basename(root);
          const aiSceneAnalysis = parsed.aiSceneAnalysis === true;
          await updateProjectAiSceneAnalysis(projectRoot, aiSceneAnalysis);
          let project = await loadProjectV2(projectRoot);
          if (!project) { json(res, 400, { error: "re-analyze is only available for v2 projects" }); return true; }
          const source = project.sourceVideos.find((v) => v.slug === videoSlug);
          if (!source) { json(res, 404, { error: "source video not found for this page" }); return true; }

          const describeEvents: unknown[] = [];
          for await (const ev of describeAllSources(projectRoot, { force: true, onlySourceSlug: videoSlug, aiSceneAnalysis })) {
            describeEvents.push(ev);
          }

          project = await loadProjectV2(projectRoot);
          const refreshedSource = project?.sourceVideos.find((v) => v.slug === videoSlug) ?? source;
          await materialiseVideoSubproject(projectRoot, refreshedSource, undefined, { refreshDescription: true });
          await prepareV2VideoForPlanning(root, { force: true });
          const metadata = await syncVisualMetadataFromVideoJson(root);

          const rebuiltPlanHtml = await buildPlanUi(root);
          try { await copyFile(rebuiltPlanHtml, path.join(planDir, "plan.html")); } catch { /* mounted server may be on an older cache dir */ }

          json(res, 200, {
            ok: true,
            describeEvents,
            ...metadata,
            planHtml: rebuiltPlanHtml,
          });
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      // ── API: export the selected clip range as a tutorial.
      // Body: {clip_id, plan, open_folder?}. The posted plan is saved
      // first so edited captions/ranges are exactly what the export uses.
      if (req.method === "POST" && pathname === "/api/export-tutorial") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { clip_id?: string; plan?: unknown; open_folder?: boolean };
        try { parsed = JSON.parse(body || "{}"); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }

        const clipId = (parsed.clip_id || "").trim();
        if (!clipId) { json(res, 400, { error: "clip_id required" }); return true; }

        try {
          const plan = parsed.plan
            ? PlanSchema.parse(parsed.plan)
            : PlanSchema.parse(JSON.parse(await readFile(path.join(root, "shorts", "plan.json"), "utf8")));
          const clip = plan.clips.find((c) => c.id === clipId);
          if (!clip) { json(res, 404, { error: "clip not found in current plan" }); return true; }

          const planPath = path.join(root, "shorts", "plan.json");
          await mkdir(path.dirname(planPath), { recursive: true });
          await writeFile(planPath, JSON.stringify(plan, null, 2));

          const points: ClipTutorialPoint[] = (plan.points ?? []).map((p) => ({
            index: p.index,
            ts_ms: p.ts_ms,
            caption: p.caption,
            original_text: p.original_text,
          }));
          const result = await buildClipTutorial(projectPath, {
            clipId: clip.id,
            title: clip.title || "Tutorial",
            startMs: clip.start_ms,
            endMs: clip.end_ms,
            points,
            format: "both",
          });

          let opened = false;
          if (parsed.open_folder && process.platform === "darwin") {
            const child = spawn("open", [result.outputDir], { detached: true, stdio: "ignore" });
            child.unref();
            opened = true;
          }

          json(res, 200, {
            ok: true,
            tutorialName: result.tutorialName,
            outputDir: result.outputDir,
            files: result.files,
            stepCount: result.stepCount,
            opened,
          });
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      if (req.method === "GET" && pathname.startsWith("/assets/face-emojis/")) {
        const file = pathname.slice("/assets/face-emojis/".length);
        if (!/^[A-Za-z0-9._-]+\.png$/.test(file)) { text(res, 400, "bad asset"); return true; }
        const assetPath = path.join(RUNTIME_DIR, "assets", "face-emojis", file);
        if (!existsSync(assetPath)) { text(res, 404, "not found"); return true; }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(statSync(assetPath).size),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        createReadStream(assetPath).pipe(res);
        return true;
      }

      // ── API: generate/cache a source-length voice-over media variant.
      // The audio track is built from caption/moment entries at their
      // source-timeline start times, then muxed onto the source video so
      // the existing preview player can keep using source-relative time.
      if (req.method === "POST" && pathname === "/api/voiceover-preview") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: {
          clip_id?: string;
          voice?: string;
          duration_ms?: number;
          entries?: Array<{ start_ms?: number; end_ms?: number; text?: string }>;
        };
        try { parsed = JSON.parse(body); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const clipId = (parsed.clip_id || "").trim();
        if (!/^[A-Za-z0-9._-]+$/.test(clipId)) {
          json(res, 400, { error: "valid clip_id required" }); return true;
        }
        const voice = (parsed.voice || "").trim();
        const entries = (parsed.entries || [])
          .map((e) => {
            const startMs = Math.max(0, Math.round(Number(e.start_ms || 0)));
            const rawEndMs = e.end_ms == null ? undefined : Math.round(Number(e.end_ms));
            return {
              startMs,
              endMs: rawEndMs != null && Number.isFinite(rawEndMs) ? rawEndMs : undefined,
              text: String(e.text || "").trim(),
            };
          })
          .filter((e) => e.text);
        if (entries.length === 0) { json(res, 400, { error: "entries required" }); return true; }
        const durationMs = Math.max(1, Math.round(Number(parsed.duration_ms || 0)));
        if (!Number.isFinite(durationMs) || durationMs <= 1) {
          json(res, 400, { error: "duration_ms required" }); return true;
        }
        const src = await sourceVideoPath(root);
        const srcSig = fileSignatureForCache(src);
        const previewDir = path.join(root, "cache", "voiceover-preview");
        await mkdir(previewDir, { recursive: true });
        const cacheKey = crypto
          .createHash("sha256")
          .update(JSON.stringify({ v: 3, clipId, voice, durationMs, entries, srcSig }))
          .digest("hex")
          .slice(0, 20);
        const wavPath = path.join(previewDir, `${clipId}-${cacheKey}.wav`);
        const mp4Path = path.join(previewDir, `${clipId}-${cacheKey}.mp4`);
        try {
          const cacheHit = existsSync(wavPath) && existsSync(mp4Path);
          if (!cacheHit) {
            await generateVoiceoverTrack({ entries, durationMs, voice, outPath: wavPath, workDir: previewDir });
            await muxSourceVideoWithAudio(src, wavPath, mp4Path);
          }
          json(res, 200, {
            ok: true,
            cache: cacheHit ? "hit" : "miss",
            audio_url: `${basePath}/voiceover-preview/${encodeURIComponent(path.basename(wavPath))}`,
            video_url: `${basePath}/voiceover-preview/${encodeURIComponent(path.basename(mp4Path))}`,
          });
        } catch (e) {
          await rm(wavPath, { force: true }).catch(() => undefined);
          await rm(mp4Path, { force: true }).catch(() => undefined);
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      // ── API: serve cached voice-over preview media variants.
      if (req.method === "GET" && pathname.startsWith("/voiceover-preview/")) {
        const file = pathname.replace("/voiceover-preview/", "");
        if (!/^[A-Za-z0-9._-]+\.(wav|mp4)$/.test(file)) { text(res, 400, "bad request"); return true; }
        const previewDir = path.join(root, "cache", "voiceover-preview");
        const filePath = path.join(previewDir, file);
        if (!withinRoot(filePath, previewDir)) { text(res, 403, "forbidden"); return true; }
        if (!existsSync(filePath)) { text(res, 404, "not found"); return true; }
        const ct = file.endsWith(".mp4") ? "video/mp4" : "audio/wav";
        streamFileWithRange(req, res, filePath, ct);
        return true;
      }

      // ── API: stream-render a clip into a per-call tmp session dir.
      // Body: {clip_id, aspects:[…]}. Returns NDJSON of RenderStreamEvent
      // PLUS a leading {type:"session", session_id, url_base} event and
      // per variant-done events get a `url` field so the dialog can play
      // each rendered file inline. Files do NOT land in shorts/render-*
      // until /api/promote-renders moves them.
      if (req.method === "POST" && pathname === "/api/render-stream") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { clip_id?: string; aspects?: string[]; render_title?: string };
        try { parsed = JSON.parse(body); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const clipId = parsed.clip_id;
        const allowedAspects = new Set(RENDER_VARIANTS.map((v) => v.aspect_ratio));
        const aspects = (parsed.aspects ?? []).filter((a): a is RenderVariant["aspect_ratio"] =>
          allowedAspects.has(a as RenderVariant["aspect_ratio"]));
        if (!clipId || aspects.length === 0) {
          json(res, 400, { error: "clip_id + aspects[] required" });
          return true;
        }
        await cleanupExpiredRenderSessions(root);
        const sessionId = crypto.randomBytes(8).toString("hex");
        const sessionDir = path.join(root, "cache", "render-tmp", sessionId);
        const urlBase = `${basePath}/render-tmp/${sessionId}`;
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        res.write(JSON.stringify({ type: "session", session_id: sessionId, url_base: urlBase }) + "\n");
        try {
          for await (const ev of renderClipVariants(
            projectPath, clipId, aspects, {
              targetDir: sessionDir,
              updateLatest: false,
              outputTitle: parsed.render_title?.trim() || undefined,
            },
          )) {
            // Decorate variant-done with a streamable URL pointing at
            // the tmp session dir; the dialog plays it inline.
            if (ev.type === "variant-done") {
              const filename = path.basename(ev.file);
              (ev as RenderStreamEvent & { url: string; filename: string }).url = `${urlBase}/${encodeURIComponent(filename)}`;
              (ev as RenderStreamEvent & { url: string; filename: string }).filename = filename;
            }
            res.write(JSON.stringify(ev) + "\n");
          }
        } catch (e) {
          res.write(JSON.stringify({ type: "variant-error", clip_id: clipId, aspect_ratio: "?", message: e instanceof Error ? e.message : String(e) }) + "\n");
        }
        res.end();
        return true;
      }

      // ── API: serve files out of a tmp render session for inline preview.
      if (req.method === "GET" && pathname.startsWith("/render-tmp/")) {
        const parts = pathname.replace("/render-tmp/", "").split("/");
        if (parts.length !== 2) { text(res, 400, "bad request"); return true; }
        const [sessionId, file] = parts as [string, string];
        if (!/^[a-f0-9]{16}$/.test(sessionId)) { text(res, 400, "bad session"); return true; }
        const sessionDir = path.join(root, "cache", "render-tmp", sessionId);
        const filePath = path.join(sessionDir, file);
        if (!withinRoot(filePath, sessionDir)) { text(res, 403, "forbidden"); return true; }
        if (!existsSync(filePath)) { text(res, 404, "not found"); return true; }
        const sz = statSync(filePath).size;
        const ct = file.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
        const range = req.headers.range;
        if (range) {
          const m = range.match(/bytes=(\d*)-(\d*)/);
          if (m) {
            const start = m[1] ? parseInt(m[1], 10) : 0;
            const end = m[2] ? parseInt(m[2], 10) : sz - 1;
            res.writeHead(206, {
              "Content-Type": ct,
              "Content-Range": `bytes ${start}-${end}/${sz}`,
              "Content-Length": String(end - start + 1),
              "Accept-Ranges": "bytes",
            });
            createReadStream(filePath, { start, end }).pipe(res);
            return true;
          }
        }
        res.writeHead(200, { "Content-Type": ct, "Content-Length": String(sz), "Accept-Ranges": "bytes" });
        createReadStream(filePath).pipe(res);
        return true;
      }

      // ── API: promote selected files from a tmp render session into
      // a fresh shorts/render-<stamp>/ folder. Body:
      //   { session_id, files: ["foo.mp4", ...], keep_session?: boolean }
      // Files (and their .json sidecars) get renamed in. By default the
      // rest of the tmp session is wiped; keep_session=true is used by
      // per-row "Keep" buttons so the user can save one render while
      // reviewing the others.
      if (req.method === "POST" && pathname === "/api/promote-renders") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { session_id?: string; files?: string[]; keep_session?: boolean };
        try { parsed = JSON.parse(body); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const sessionId = parsed.session_id || "";
        if (!/^[a-f0-9]{16}$/.test(sessionId)) {
          json(res, 400, { error: "bad session_id" }); return true;
        }
        const sessionDir = path.join(root, "cache", "render-tmp", sessionId);
        if (!existsSync(sessionDir)) {
          json(res, 404, { error: "no such session" }); return true;
        }
        const requested = parsed.files ?? [];
        if (!Array.isArray(requested)) {
          json(res, 400, { error: "files must be an array" }); return true;
        }
        const wanted: string[] = [];
        for (const n of requested) {
          if (typeof n !== "string" || !/^[A-Za-z0-9._\-\[\]]+\.mp4$/.test(n)) {
            json(res, 400, { error: `invalid render filename: ${String(n)}` }); return true;
          }
          const src = path.join(sessionDir, n);
          if (!withinRoot(src, sessionDir) || !existsSync(src)) {
            json(res, 404, { error: `render not found: ${n}` }); return true;
          }
          wanted.push(n);
        }
        let promoted = 0;
        let outDir = "";
        if (wanted.length > 0) {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
          outDir = path.join(root, "shorts", `render-${stamp}`);
          await mkdir(outDir, { recursive: true });
          for (const f of wanted) {
            const src = path.join(sessionDir, f);
            await rename(src, path.join(outDir, f));
            const sidecar = f.replace(/\.mp4$/, ".json");
            const sidecarSrc = path.join(sessionDir, sidecar);
            if (existsSync(sidecarSrc)) {
              try { await rename(sidecarSrc, path.join(outDir, sidecar)); } catch { /* best-effort */ }
            }
            promoted++;
          }
          // shorts/latest → newly-promoted dir.
          const latest = path.join(root, "shorts", "latest");
          try { await rm(latest, { force: true }); } catch { /* */ }
          try { await (await import("node:fs/promises")).symlink(path.basename(outDir), latest, "dir"); } catch { /* */ }
        }
        // Wipe the rest of the session dir unless the caller is saving
        // incrementally from an open dialog.
        if (!parsed.keep_session) {
          try { await rm(sessionDir, { recursive: true, force: true }); } catch { /* */ }
        }
        json(res, 200, { ok: true, promoted, render_dir: outDir ? path.basename(outDir) : "" });
        return true;
      }

      // ── API: discard a tmp render session without promoting.
      if (req.method === "POST" && pathname === "/api/discard-renders") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { session_id?: string };
        try { parsed = JSON.parse(body); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const sessionId = parsed.session_id || "";
        if (!/^[a-f0-9]{16}$/.test(sessionId)) {
          json(res, 400, { error: "bad session_id" }); return true;
        }
        const sessionDir = path.join(root, "cache", "render-tmp", sessionId);
        try { await rm(sessionDir, { recursive: true, force: true }); } catch { /* */ }
        json(res, 200, { ok: true });
        return true;
      }

      // ── API: re-run replace-audio against a chosen audio source.
      // Body: {audio_filename} — looked up under <project>/_sources/.
      // Backs up the current video.<ext>, runs the existing
      // replaceAudio() pipeline, then overwrites video.<ext> with the
      // result and writes .match-meta.json so the page reload reflects
      // the new matched audio.
      if (req.method === "POST" && pathname === "/api/replace-audio-v2") {
        let body = "";
        try { for await (const chunk of req) body += chunk; }
        catch { json(res, 400, { error: "read failed" }); return true; }
        let parsed: { audio_filename?: string };
        try { parsed = JSON.parse(body); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const audioName = (parsed.audio_filename || "").trim();
        if (!audioName) { json(res, 400, { error: "audio_filename required" }); return true; }
        // Resolve the audio source under the parent project's _sources/.
        const projectRoot = path.dirname(root);
        const audioSrc = path.join(projectRoot, "_sources", audioName);
        if (!existsSync(audioSrc)) { json(res, 404, { error: "audio not found in _sources/" }); return true; }
        try {
          const result = await replaceAudio(projectPath, audioSrc);
          // Find the working video.<ext> and overwrite with the
          // replaced output (mirrors auto-match's flow).
          const workingExts = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];
          let videoFile: string | null = null;
          for (const ext of workingExts) {
            const p = path.join(root, `video${ext}`);
            if (existsSync(p)) { videoFile = p; break; }
          }
          if (videoFile) {
            await backupIfExists(videoFile);
            await copyFile(result.outPath, videoFile);
          }
          // Write the match marker so the next page load shows
          // "[x] use audio from <name>".
          await writeFile(
            path.join(root, ".match-meta.json"),
            JSON.stringify({
              audioOriginalName: audioName,
              audioSourcePath: audioSrc,
              offsetMs: result.offsetMs,
              matchedPhrase: result.matchedPhrase,
              appliedAt: new Date().toISOString(),
            }, null, 2),
          );
          json(res, 200, {
            ok: true,
            audioOriginalName: audioName,
            offsetMs: result.offsetMs,
            matchedPhrase: result.matchedPhrase,
          });
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      // ── API: trigger a render run from the UI. Body {clip_id} → single
      // clip; empty body → render every clip in plan.json.
      if (req.method === "POST" && pathname === "/api/render") {
        let clipId: string | undefined;
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          if (body.trim()) {
            const parsed = JSON.parse(body) as { clip_id?: string };
            clipId = parsed.clip_id;
          }
        } catch { /* ignore body parse errors — fall through to render-all */ }
        try {
          if (clipId) {
            const out = await renderShort(projectPath, clipId);
            json(res, 200, { rendered: 1, files: [out] });
          } else {
            const outs = await renderAllShorts(projectPath);
            json(res, 200, { rendered: outs.length, files: outs });
          }
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      // ── API: list past renders
      if (req.method === "GET" && pathname === "/api/renders") {
        const shorts = path.join(root, "shorts");
        const dirs = await safeReaddir(shorts, true);
        const renders: Array<{
          dir: string;
          stamp: string;
          file: string;
          slug: string;
          url: string;
          posterUrl: string;
          rendered_at: string;
          created_ms: number;
          format_label: string;
          format_name: string;
          aspect_ratio: string;
          w: number;
          h: number;
        }> = [];
        // basePath is "/p/<projectSlug>/<videoSlug>" when mounted by
        // the home-server. We use those slugs to build poster URLs
        // that hit the /v2-render-poster/ route on the parent server.
        const baseParts = basePath.startsWith("/p/") ? basePath.slice(3).split("/") : [];
        const pSlug = baseParts[0] ?? "";
        const vSlug = baseParts[1] ?? "";
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          if (!d.name.startsWith("render-")) continue;
          const stamp = d.name.replace("render-", "");
          const innerDir = path.join(shorts, d.name);
          const inner = await safeReaddir(innerDir);
          for (const f of inner) {
            if (!f.endsWith(".mp4")) continue;
            // Prefer the sidecar JSON written by renderClipVariants —
            // its title_slug matches the per-clip card's data-slug
            // exactly. Falls back to the legacy filename regex for old
            // <NN>-<title>.mp4 renders that have no sidecar.
            let slug = f.replace(/^\d+-/, "").replace(/\.mp4$/, "");
            // format_label is what the size filter dropdown matches
            // (e.g. "instagram[1080x1350]"). For older renders without
            // a sidecar, derive a fallback from the filename's "WxH"
            // suffix or set it to "" so the filter ignores them.
            let formatLabel = "";
            let formatName = "";
            let aspectRatio = "";
            let w = 0;
            let h = 0;
            let renderedAt = "";
            const sidecarPath = path.join(innerDir, f.replace(/\.mp4$/, ".json"));
            if (existsSync(sidecarPath)) {
              try {
                const meta = JSON.parse(await readFile(sidecarPath, "utf-8")) as {
                  title_slug?: string;
                  format_label?: string;
                  format_name?: string;
                  aspect_ratio?: string;
                  w?: number;
                  h?: number;
                  rendered_at?: string;
                };
                if (meta.title_slug) slug = meta.title_slug;
                formatLabel = meta.format_label ?? "";
                formatName = meta.format_name ?? "";
                aspectRatio = meta.aspect_ratio ?? "";
                w = meta.w ?? 0;
                h = meta.h ?? 0;
                renderedAt = meta.rendered_at ?? "";
              } catch { /* malformed sidecar — keep regex slug */ }
            }
            // Legacy fallback: pre-rename renders had `<W>x<H>` as the
            // bare suffix; keep that as the label so old files still
            // group under a sensible filter entry.
            if (!formatLabel) {
              const m = f.match(/-(\d{2,4})x(\d{2,4})\.mp4$/);
              if (m) {
                w = w || parseInt(m[1]!, 10);
                h = h || parseInt(m[2]!, 10);
                formatLabel = `${m[1]}x${m[2]}`;
              }
            }
            const posterUrl = pSlug && vSlug
              ? `/v2-render-poster/${encodeURIComponent(pSlug)}/${encodeURIComponent(vSlug)}/shorts/${encodeURIComponent(d.name)}/${encodeURIComponent(f)}`
              : "";
            const filePath = path.join(innerDir, f);
            const createdMs = renderedAt ? Date.parse(renderedAt) : statSync(filePath).mtimeMs;
            renders.push({
              dir: d.name,
              stamp,
              file: f,
              slug,
              url: `${basePath}/renders/${encodeURIComponent(d.name)}/${encodeURIComponent(f)}`,
              posterUrl,
              rendered_at: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : "",
              created_ms: Number.isFinite(createdMs) ? Math.round(createdMs) : 0,
              format_label: formatLabel,
              format_name: formatName,
              aspect_ratio: aspectRatio,
              w,
              h,
            });
          }
        }
        renders.sort((a, b) => b.stamp.localeCompare(a.stamp));
        json(res, 200, { renders });
        return true;
      }

      // ── Delete a previously-rendered mp4 and its JSON sidecar.
      if (req.method === "POST" && pathname === "/api/delete-render") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { dir?: string; file?: string };
        try { parsed = JSON.parse(body || "{}"); }
        catch { json(res, 400, { error: "bad JSON" }); return true; }
        const dir = parsed.dir || "";
        const file = parsed.file || "";
        try {
          await deleteRenderedFile(root, dir, file);
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }

      // ── Serve analysis keyframe images (one per point)
      if (req.method === "GET" && pathname.startsWith("/keyframes/")) {
        const file = pathname.replace("/keyframes/", "");
        const filePath = path.join(root, "analysis", "keyframes", file);
        if (!withinRoot(filePath, path.join(root, "analysis", "keyframes"))) {
          text(res, 403, "forbidden");
          return true;
        }
        if (!existsSync(filePath)) {
          text(res, 404, "not found");
          return true;
        }
        const buf = await readFile(filePath);
        res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": String(buf.length), "Cache-Control": "public, max-age=3600" });
        res.end(buf);
        return true;
      }

      // ── Stream a previously-rendered mp4
      if (req.method === "GET" && pathname.startsWith("/renders/")) {
        const parts = pathname.replace("/renders/", "").split("/");
        if (parts.length !== 2) {
          text(res, 400, "bad request");
          return true;
        }
        const filePath = path.join(root, "shorts", parts[0]!, parts[1]!);
        if (!withinRoot(filePath, path.join(root, "shorts"))) {
          text(res, 403, "forbidden");
          return true;
        }
        if (!existsSync(filePath)) {
          text(res, 404, "not found");
          return true;
        }
        const sz = statSync(filePath).size;
        // Honour Range so the browser can stream / scrub
        const range = req.headers.range;
        if (range) {
          const m = range.match(/bytes=(\d*)-(\d*)/);
          if (m) {
            const start = m[1] ? parseInt(m[1], 10) : 0;
            const end = m[2] ? parseInt(m[2], 10) : sz - 1;
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${sz}`,
              "Accept-Ranges": "bytes",
              "Content-Length": String(end - start + 1),
              "Content-Type": "video/mp4",
            });
            createReadStream(filePath, { start, end }).pipe(res);
            return true;
          }
        }
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(sz),
          "Accept-Ranges": "bytes",
        });
        createReadStream(filePath).pipe(res);
        return true;
      }

      // ── Static files in the plan dir
      const fileRel = pathname === "/" || pathname === "" ? "/plan.html" : pathname;
      const fullPath = path.join(planDir, fileRel);
      if (!withinRoot(fullPath, planDir)) {
        text(res, 403, "forbidden");
        return true;
      }
      if (!existsSync(fullPath)) return false;  // let caller handle 404
      const sz = statSync(fullPath).size;
      const range = req.headers.range;
      const ct = contentTypeFor(fileRel);
      // When mounted under a base path (e.g. /p/<slug>/), the served HTML
      // needs a <base> tag so the relative URLs in plan.html resolve to
      // /p/<slug>/source.mp4, /p/<slug>/api/save, etc. — not the hub
      // root.
      if (basePath && fileRel === "/plan.html") {
        const html = (await readFile(fullPath, "utf-8")).replace(
          /<head>/i,
          `<head><base href="${basePath.endsWith("/") ? basePath : basePath + "/"}">`,
        );
        const body = Buffer.from(html, "utf-8");
        res.writeHead(200, { "Content-Type": ct, "Content-Length": String(body.length) });
        res.end(body);
        return true;
      }
      if (range && (ct === "video/mp4" || ct === "video/webm")) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : sz - 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${sz}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Content-Type": ct,
          });
          createReadStream(fullPath, { start, end }).pipe(res);
          return true;
        }
      }
      res.writeHead(200, { "Content-Type": ct, "Content-Length": String(sz) });
      createReadStream(fullPath).pipe(res);
      return true;
  } catch (e) {
    text(res, 500, `error: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

type Res = ServerResponse<IncomingMessage>;

function json(res: Res, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function text(res: Res, code: number, body: string): void {
  res.writeHead(code, { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function streamFileWithRange(req: IncomingMessage, res: Res, filePath: string, contentType: string): void {
  const sz = statSync(filePath).size;
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : sz - 1;
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${sz}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(sz),
    "Accept-Ranges": "bytes",
  });
  createReadStream(filePath).pipe(res);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".json": "application/json",
  };
  return map[ext] || "application/octet-stream";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function syncVisualMetadataFromVideoJson(root: string): Promise<{
  sourceMomentsWithMetadata: number;
  facePoints: number;
  planPointsPatched: number;
  analysisMomentsPatched: number;
}> {
  const videoJsonPath = path.join(root, "video.json");
  if (!existsSync(videoJsonPath)) {
    return { sourceMomentsWithMetadata: 0, facePoints: 0, planPointsPatched: 0, analysisMomentsPatched: 0 };
  }
  const desc = JSON.parse(await readFile(videoJsonPath, "utf-8")) as SourceDescription;
  const sourceMoments = (desc.moments ?? [])
    .filter((m) => m.visual_metadata && hasVisualMetadata(m.visual_metadata))
    .map((m) => ({ ts_ms: m.ts_ms, visual_metadata: m.visual_metadata! }));
  if (sourceMoments.length === 0) {
    return { sourceMomentsWithMetadata: 0, facePoints: 0, planPointsPatched: 0, analysisMomentsPatched: 0 };
  }

  let planPointsPatched = 0;
  const planPath = path.join(root, "shorts", "plan.json");
  if (existsSync(planPath)) {
    try {
      const plan = PlanSchema.parse(JSON.parse(await readFile(planPath, "utf-8")));
      let dirty = false;
      for (const p of plan.points ?? []) {
        const metadata = nearestVisualMetadata(sourceMoments, p.ts_ms, 10_000);
        if (!metadata) continue;
        p.visual_metadata = metadata;
        planPointsPatched++;
        dirty = true;
      }
      if (dirty) await writeFile(planPath, JSON.stringify(plan, null, 2));
    } catch { /* keep an invalid/user-edited plan untouched */ }
  }

  let analysisMomentsPatched = 0;
  const analysisPath = path.join(root, "analysis", "moments.json");
  if (existsSync(analysisPath)) {
    try {
      const analysis = JSON.parse(await readFile(analysisPath, "utf-8")) as { moments?: Array<{ ts_ms?: number; visual_metadata?: VisualMomentMetadata }> };
      let dirty = false;
      for (const m of analysis.moments ?? []) {
        if (typeof m.ts_ms !== "number") continue;
        const metadata = nearestVisualMetadata(sourceMoments, m.ts_ms, 10_000);
        if (!metadata) continue;
        m.visual_metadata = metadata;
        analysisMomentsPatched++;
        dirty = true;
      }
      if (dirty) await writeFile(analysisPath, JSON.stringify(analysis, null, 2));
    } catch { /* malformed analysis is non-fatal */ }
  }

  const facePoints = sourceMoments.filter((m) => (m.visual_metadata.faces?.length ?? 0) > 0).length;
  return {
    sourceMomentsWithMetadata: sourceMoments.length,
    facePoints,
    planPointsPatched,
    analysisMomentsPatched,
  };
}

function nearestVisualMetadata(
  moments: Array<{ ts_ms: number; visual_metadata: VisualMomentMetadata }>,
  tsMs: number,
  maxDistanceMs: number,
): VisualMomentMetadata | undefined {
  let best: { ts_ms: number; visual_metadata: VisualMomentMetadata } | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of moments) {
    const dist = Math.abs(m.ts_ms - tsMs);
    if (dist < bestDist) {
      best = m;
      bestDist = dist;
    }
  }
  return best && bestDist <= maxDistanceMs ? best.visual_metadata : undefined;
}

function hasVisualMetadata(metadata: VisualMomentMetadata): boolean {
  return Boolean(
    metadata.main_focus ||
    (metadata.faces?.length ?? 0) > 0 ||
    (metadata.text_regions?.length ?? 0) > 0 ||
    (metadata.crop_regions?.length ?? 0) > 0 ||
    (metadata.privacy_risks?.length ?? 0) > 0 ||
    (metadata.safe_caption_zones?.length ?? 0) > 0
  );
}

async function deleteRenderedFile(root: string, dir: string, file: string): Promise<void> {
  if (!/^render-\d{8}-\d{6}$/.test(dir)) throw new Error("bad render dir");
  if (!/^[A-Za-z0-9._\-\[\]]+\.mp4$/.test(file)) throw new Error("bad render file");
  const renderDir = path.join(root, "shorts", dir);
  const filePath = path.join(renderDir, file);
  if (!withinRoot(filePath, path.join(root, "shorts"))) throw new Error("forbidden");
  if (!existsSync(filePath)) throw new Error("render not found");
  await rm(filePath, { force: true });
  await rm(filePath.replace(/\.mp4$/i, ".json"), { force: true });
  await rm(path.join(renderDir, "_posters", file.replace(/\.mp4$/i, ".jpg")), { force: true });
  try {
    const postersLeft = await safeReaddir(path.join(renderDir, "_posters"));
    if (postersLeft.length === 0) await rm(path.join(renderDir, "_posters"), { recursive: true, force: true });
  } catch { /* no poster cache */ }
  const remaining = await safeReaddir(renderDir);
  if (remaining.length === 0) {
    await rm(renderDir, { recursive: true, force: true });
    const latest = path.join(root, "shorts", "latest");
    try {
      const target = await readlink(latest);
      if (path.basename(target) === dir) await rm(latest, { force: true });
    } catch { /* best effort */ }
  }
}

function withinRoot(filePath: string, root: string): boolean {
  const a = path.resolve(filePath);
  const b = path.resolve(root);
  return a === b || a.startsWith(b + path.sep);
}

function fileSignatureForCache(filePath: string): { size: number; mtimeMs: number } {
  const s = statSync(filePath);
  return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
}

async function muxSourceVideoWithAudio(src: string, audioPath: string, outPath: string): Promise<void> {
  await runProc(process.env.FFMPEG_PATH || "ffmpeg", [
    "-y",
    "-i", src,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    outPath,
  ]);
}

async function safeReaddir(dir: string, withTypes = false): Promise<any[]> {
  try {
    return withTypes ? await readdir(dir, { withFileTypes: true }) : await readdir(dir);
  } catch {
    return [];
  }
}

async function updateProjectAiSceneAnalysis(projectRoot: string, enabled: boolean): Promise<void> {
  const metaPath = path.join(projectRoot, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return;
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as ProjectMeta;
    if (meta.version !== 2) return;
    meta.aiSceneAnalysis = enabled;
    meta.updatedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    // Re-analysis can still run even if the project metadata flag is stale.
  }
}

export async function cleanupExpiredRenderSessions(root: string): Promise<void> {
  const tmpRoot = path.join(root, "cache", "render-tmp");
  if (!existsSync(tmpRoot)) return;
  const now = Date.now();
  const entries = await safeReaddir(tmpRoot, true);
  for (const e of entries) {
    if (!e.isDirectory?.()) continue;
    if (!/^[a-f0-9]{16}$/.test(e.name)) continue;
    const sessionDir = path.join(tmpRoot, e.name);
    try {
      const s = await stat(sessionDir);
      if (now - s.mtimeMs >= RENDER_TMP_TTL_MS) {
        await rm(sessionDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup; stale tmp renders should never block the UI.
    }
  }
}

// Try the requested port; if busy, scan up to 10 nearby ports.
async function listen(server: Server, preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 20; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener("error", onErr);
          resolve();
        };
        server.once("error", onErr);
        server.once("listening", onListening);
        server.listen(p, "127.0.0.1");
      });
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`no free port near ${preferred}`);
}
