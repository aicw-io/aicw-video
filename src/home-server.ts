import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, statSync, createReadStream, createWriteStream, readFileSync, type Dirent } from "node:fs";
import { copyFile, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanProjects,
  projectsRoot,
  type ProjectSummary,
} from "./projectFolder.js";
import { matchAudioFiles } from "./match-audio.js";
import { aiCliAvailable, configuredAiCliToolLabels, preflightAiCliTools } from "./llm/index.js";
import { getFfmpegPath } from "./ffmpeg.js";
import {
  initProjectV2,
  loadProjectV2,
  projectNameToSlug,
  sourceFileTarget,
  uniqueSlugIn,
  isV2Project,
  PROJECT_META_FILE,
  sourceDescriptionPath,
  type ProjectMeta,
  type SourceFile,
  type SourceDescription,
} from "./project-v2.js";
import { describeAllSources } from "./describe-sources.js";
import { autoMatchAndReplace, materialiseVideoSubproject } from "./auto-match.js";
import { buildPlanUi, resolvePlanDirIfFresh } from "./plan-builder.js";
import { prepareV2VideoForPlanning } from "./v2-plan-prep.js";
import { cleanupExpiredRenderSessions, handlePlanRequest } from "./plan-server.js";
import { probeAudioUsability } from "./media-audio.js";
import { runProc } from "./run.js";
import { buildTutorial } from "./tutorial-aicw.js";

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface HomeServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

// Hub server: shows MCP attach instructions and the project list. When the
// user clicks "Open" on a project we spin up a plan-ui server in-process for
// that project and return its URL — repeated clicks reuse the same handle.
export async function startHomeServer(opts: { port?: number } = {}): Promise<HomeServerHandle> {
  void cleanupKnownRenderSessions();
  // Hot-path memo of materialised plan-UI dirs keyed by `<projectSlug>/<videoSlug>`.
  // The plan dir itself now lives on disk under
  // <videoSubproject>/cache/plan-ui/<inputs-hash>/ so re-opens (even after a
  // server restart) resolve to a pre-built plan.html without re-running
  // ffmpeg. This Map just spares the hash computation on the hot path; on a
  // miss we fall back to plan-builder::resolvePlanDirIfFresh.
  const planDirs = new Map<string, string>();
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      const pathname = decodeURIComponent(u.pathname);

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const projects = await scanProjects();
        const html = renderHomeHtml({ projects, cliPath: cliInvocation() });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(Buffer.byteLength(html)) });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/assets/tailwind.css") {
        return streamFile(path.join(RUNTIME_DIR, "assets", "tailwind.css"), req, res);
      }

      if (req.method === "GET" && pathname.startsWith("/assets/face-emojis/")) {
        const file = pathname.slice("/assets/face-emojis/".length);
        if (!isSafePathSegment(file) || !file.endsWith(".png")) return text(res, 400, "bad asset");
        return streamFile(path.join(RUNTIME_DIR, "assets", "face-emojis", file), req, res);
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await scanProjects();
        return json(res, 200, { projects, root: projectsRoot() });
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-rename/")) {
        const slug = pathname.slice("/api/project-rename/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json(res, 404, { error: "project not found" });
        }
        let parsed: { name?: string };
        try { parsed = await readJsonBody<{ name?: string }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        const name = (parsed.name ?? "").trim();
        if (!name) return json(res, 400, { error: "missing name" });
        const root = path.resolve(projectsRoot());
        const archived = path.basename(projectPath).startsWith("_");
        const candidateSlug = `${archived ? "_" : ""}${projectNameToSlug(name)}`;
        const nextSlug = candidateSlug === slug ? slug : uniqueSlugIn(root, candidateSlug);
        const nextPath = path.join(root, nextSlug);
        try {
          if (nextSlug !== slug) await rename(projectPath, nextPath);
          await updateProjectMetaTitle(nextPath, name);
          dropPlanDirCache(planDirs, slug);
          const projects = await scanProjects();
          const project = await loadProjectV2(nextPath);
          return json(res, 200, { slug: nextSlug, title: name, projects, project });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-archive/")) {
        const slug = pathname.slice("/api/project-archive/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json(res, 404, { error: "project not found" });
        }
        const root = path.resolve(projectsRoot());
        const alreadyArchived = path.basename(projectPath).startsWith("_");
        const nextSlug = alreadyArchived ? slug : uniqueSlugIn(root, `_${slug}`);
        const nextPath = path.join(root, nextSlug);
        try {
          if (nextSlug !== slug) await rename(projectPath, nextPath);
          dropPlanDirCache(planDirs, slug);
          const projects = await scanProjects();
          const project = await loadProjectV2(nextPath);
          return json(res, 200, { ok: true, slug: nextSlug, projects, project });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-unarchive/")) {
        const slug = pathname.slice("/api/project-unarchive/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json(res, 404, { error: "project not found" });
        }
        const root = path.resolve(projectsRoot());
        const nextSlugBase = slug.replace(/^_+/, "") || "project";
        const nextSlug = slug.startsWith("_") ? uniqueSlugIn(root, nextSlugBase) : slug;
        const nextPath = path.join(root, nextSlug);
        try {
          if (nextSlug !== slug) await rename(projectPath, nextPath);
          dropPlanDirCache(planDirs, slug);
          const projects = await scanProjects();
          const project = await loadProjectV2(nextPath);
          return json(res, 200, { ok: true, slug: nextSlug, projects, project });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-new-version/")) {
        const slug = pathname.slice("/api/project-new-version/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json(res, 404, { error: "project not found" });
        }
        let parsed: { name?: string };
        try { parsed = await readJsonBody<{ name?: string }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        try {
          const result = await createProjectVersionFromSources(projectPath, parsed.name);
          const projects = await scanProjects();
          const project = await loadProjectV2(result.path);
          return json(res, 200, { ok: true, ...result, projects, project });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/project/")) {
        const slug = pathname.slice("/api/project/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json(res, 404, { error: "project not found" });
        }
        return json(res, 405, { error: "Project deletion is not available in the UI. Archive the project instead." });
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-video-rename/")) {
        const rest = pathname.slice("/api/project-video-rename/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return json(res, 400, { error: "expected projectSlug/videoSlug" });
        const projectSlug = rest.slice(0, slashIdx);
        const videoSlug = rest.slice(slashIdx + 1);
        const projectPath = projectPathForSlug(projectSlug);
        if (!projectPath || !isSafePathSegment(videoSlug)) return json(res, 400, { error: "bad slug" });
        let parsed: { title?: string };
        try { parsed = await readJsonBody<{ title?: string }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        const title = (parsed.title ?? "").trim();
        if (!title) return json(res, 400, { error: "missing title" });
        try {
          const project = await loadProjectV2(projectPath);
          if (!project) return json(res, 404, { error: "not a v2 project" });
          const source = project.sourceVideos.find((v) => v.slug === videoSlug);
          if (!source) return json(res, 404, { error: "video not found" });
          const editedAt = new Date().toISOString();
          const sourceJson = sourceDescriptionPath(source.sourcePath);
          let desc: SourceDescription = {
            kind: source.kind,
            filename: source.originalName,
          };
          if (!existsSync(sourceJson)) return json(res, 404, { error: "analyze this video before renaming it" });
          try {
            desc = JSON.parse(await readFile(sourceJson, "utf-8")) as SourceDescription;
          } catch { /* rewrite a minimal valid sidecar below */ }
          desc.title = title;
          desc.titleEditedAt = editedAt;
          await writeFile(sourceJson, JSON.stringify(desc, null, 2));

          const videoRoot = path.join(projectPath, videoSlug);
          const videoJson = path.join(videoRoot, "video.json");
          if (existsSync(videoRoot)) {
            let videoDesc = desc;
            if (existsSync(videoJson)) {
              try {
                videoDesc = JSON.parse(await readFile(videoJson, "utf-8")) as SourceDescription;
              } catch { /* replace malformed copy with source desc */ }
            }
            videoDesc.title = title;
            videoDesc.titleEditedAt = editedAt;
            await writeFile(videoJson, JSON.stringify(videoDesc, null, 2));
          }
          planDirs.delete(`${projectSlug}/${videoSlug}`);
          const updated = await loadProjectV2(projectPath);
          return json(res, 200, { ok: true, project: updated });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: create a multi-file project. Body: {name, autoMatchAudio}.
      // Sets up an empty `_sources/` directory. Files are uploaded
      // afterward via /api/upload-source-multi/<slug>.
      if (req.method === "POST" && pathname === "/api/new-project-v2") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { name?: string; autoMatchAudio?: boolean; aiSceneAnalysis?: boolean };
        try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad JSON" }); }
        const name = (parsed.name ?? "").trim();
        if (!name) return json(res, 400, { error: "missing name" });
        const slug = uniqueSlugIn(projectsRoot(), projectNameToSlug(name));
        try {
          const root = await initProjectV2(slug, {
            title: name,
            autoMatchAudio: parsed.autoMatchAudio !== false,
            aiSceneAnalysis: parsed.aiSceneAnalysis === true,
          });
          return json(res, 200, { slug, path: root });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: stream-upload one source file into <project>/_sources/.
      // X-Filename header carries the original name (preserved verbatim).
      // The client calls this once per picked file.
      if (req.method === "POST" && pathname.startsWith("/api/upload-source-multi/")) {
        const slug = decodeURIComponent(pathname.slice("/api/upload-source-multi/".length));
        const fileName = String(req.headers["x-filename"] || "");
        if (!fileName) return json(res, 400, { error: "missing X-Filename header" });
        const projectPath = path.join(projectsRoot(), slug);
        if (!isV2Project(projectPath)) return json(res, 404, { error: "no such v2 project" });
        try {
          const dst = await sourceFileTarget(projectPath, fileName);
          await streamRequestToFile(req, dst);
          return json(res, 200, { name: fileName, path: dst });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: read a project's full state (sources + descriptions +
      // video subprojects). Used by the project page.
      if (req.method === "GET" && pathname.startsWith("/api/project-v2/")) {
        const slug = decodeURIComponent(pathname.slice("/api/project-v2/".length));
        const projectPath = path.join(projectsRoot(), slug);
        try {
          const p = await loadProjectV2(projectPath);
          if (!p) return json(res, 404, { error: "not a v2 project" });
          return json(res, 200, p);
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "GET" && pathname.startsWith("/api/project-visual-context-needed/")) {
        const slug = decodeURIComponent(pathname.slice("/api/project-visual-context-needed/".length));
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        const includeDescribed = u.searchParams.get("include_described") === "1";
        try {
          const p = await loadProjectV2(projectPath);
          if (!p) return json(res, 404, { error: "not a v2 project" });
          const videos: Array<{ slug: string; filename: string; reason: string }> = [];
          for (const video of p.sourceVideos) {
            if (video.description && !includeDescribed) continue;
            const audio = await probeAudioUsability(video.sourcePath);
            if (!audio.hasUsableAudio) {
              videos.push({
                slug: video.slug,
                filename: video.originalName,
                reason: audio.reason ?? "silent_audio",
              });
            }
          }
          const contextSourceVideos = videos.length > 0
            ? p.sourceVideos.filter((video) => videos.some((v) => v.slug === video.slug))
            : p.sourceVideos;
          return json(res, 200, {
            needsContext: videos.length > 0,
            videos,
            visualContext: p.meta.visualContext?.trim() || inferPriorVisualContext(contextSourceVideos),
            audioCount: p.sourceAudios.length,
          });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (req.method === "POST" && pathname.startsWith("/api/project-visual-context/")) {
        const slug = pathname.slice("/api/project-visual-context/".length);
        const projectPath = projectPathForSlug(slug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        let parsed: { visualContext?: string };
        try { parsed = await readJsonBody<{ visualContext?: string }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        const visualContext = (parsed.visualContext ?? "").trim();
        if (!visualContext) return json(res, 400, { error: "missing visual context" });
        if (visualContext.length > 5000) return json(res, 400, { error: "visual context is too long" });
        try {
          await updateProjectVisualContext(projectPath, visualContext);
          return json(res, 200, { ok: true, visualContext });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: stream describe-all events as NDJSON. Each line is one
      // DescribeEvent JSON. The browser reads via fetch + ReadableStream
      // — a step simpler than full SSE.
      if (req.method === "GET" && pathname.startsWith("/api/describe-stream/")) {
        const slug = decodeURIComponent(pathname.slice("/api/describe-stream/".length));
        const projectPath = path.join(projectsRoot(), slug);
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        try {
          const aiSceneAnalysis = await aiSceneAnalysisForRequest(projectPath, u);
          const visualContext = aiSceneAnalysis ? await visualContextForRequest(projectPath, u) : undefined;
          if (aiSceneAnalysis) {
            const aiPreflight = await preflightAiCliTools({ timeoutMs: 10_000 });
            res.write(JSON.stringify({ type: "ai-preflight", results: aiPreflight }) + "\n");
          } else {
            res.write(JSON.stringify({ type: "local-analysis", message: "AI scene analysis disabled; using Whisper, local face detection, and face-focused crop hints." }) + "\n");
          }
          for await (const ev of describeAllSources(projectPath, { visualContext, aiSceneAnalysis })) {
            res.write(JSON.stringify(ev) + "\n");
          }
        } catch (e) {
          res.write(
            JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) }) + "\n",
          );
        }
        res.end();
        return;
      }

      // ── v2: stream auto-match-and-replace events as NDJSON.
      // ?force=1 → re-match every video (drops existing match markers
      // before scoring); default skips already-matched videos.
      if (req.method === "GET" && pathname.startsWith("/api/auto-match-stream/")) {
        const slug = decodeURIComponent(pathname.slice("/api/auto-match-stream/".length));
        const projectPath = path.join(projectsRoot(), slug);
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        const force = u.searchParams.get("force") === "1";
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        try {
          for await (const ev of autoMatchAndReplace(projectPath, { force })) {
            res.write(JSON.stringify(ev) + "\n");
          }
        } catch (e) {
          res.write(
            JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) }) + "\n",
          );
        }
        res.end();
        return;
      }

      // ── v2: one visible project workflow. Streams:
      // describe sources → optional audio matching/materialisation →
      // per-video plan UI preparation.
      if (req.method === "GET" && pathname.startsWith("/api/analyze-project-stream/")) {
        const slug = decodeURIComponent(pathname.slice("/api/analyze-project-stream/".length));
        const projectPath = path.join(projectsRoot(), slug);
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const send = (obj: unknown): void => {
          res.write(JSON.stringify(obj) + "\n");
        };
        try {
          const aiSceneAnalysis = await aiSceneAnalysisForRequest(projectPath, u);
          const visualContext = aiSceneAnalysis ? await visualContextForRequest(projectPath, u) : undefined;
          const forceDescribe = u.searchParams.get("force_describe") === "1";
          const forceMatch = u.searchParams.get("force_match") === "1";
          const forcePlans = u.searchParams.get("force_plans") === "1";
          send({ type: "phase", phase: "preflight", label: aiSceneAnalysis ? "Checking AI tools" : "Using local analysis" });
          if (aiSceneAnalysis) {
            send({ type: "ai-preflight", results: await preflightAiCliTools({ timeoutMs: 10_000 }) });
          } else {
            send({ type: "local-analysis", message: "AI scene analysis disabled; using Whisper, local face detection, and face-focused crop hints." });
          }
          send({ type: "phase", phase: "describe", label: aiSceneAnalysis ? "Analyzing sources" : "Preparing local source metadata" });
          for await (const ev of describeAllSources(projectPath, { visualContext, force: forceDescribe, aiSceneAnalysis })) {
            send({ type: "describe", event: ev });
          }

          let project = await loadProjectV2(projectPath);
          if (!project) {
            send({ type: "error", message: "project disappeared during analysis" });
            res.end();
            return;
          }

          const shouldMatch = project.meta.autoMatchAudio && project.sourceAudios.length > 0;
          if (shouldMatch) {
            send({ type: "phase", phase: "audio", label: "Matching audio" });
            for await (const ev of autoMatchAndReplace(projectPath, { force: forceMatch })) {
              send({ type: "match", event: ev });
            }
          } else {
            send({ type: "phase", phase: "materialise", label: "Preparing videos" });
            for (const video of project.sourceVideos) {
              send({ type: "materialise-start", videoFile: video.originalName });
              const root = await materialiseVideoSubproject(projectPath, video, undefined, {
                refreshDescription: forceDescribe,
              });
              send({ type: "materialise-done", videoFile: video.originalName, root });
            }
          }

          project = await loadProjectV2(projectPath);
          if (!project) {
            send({ type: "error", message: "project disappeared before plan preparation" });
            res.end();
            return;
          }

          send({ type: "phase", phase: "plans", label: "Preparing clip plans" });
          let prepared = 0;
          for (const video of project.videos) {
            send({ type: "plan-start", videoSlug: video.slug, videoFile: video.sourceFile.originalName });
            try {
              if (forceDescribe) await refreshVideoSubprojectDescription(video.root, video.sourceFile);
              if (forceDescribe || forcePlans) await resetVideoDerivedCaches(video.root, { forcePlans });
              if (forceDescribe || forcePlans) planDirs.delete(`${slug}/${video.slug}`);
              await prepareV2VideoForPlanning(video.root);
              const planHtml = await buildPlanUi(video.root);
              planDirs.set(`${slug}/${video.slug}`, path.dirname(planHtml));
              prepared++;
              send({ type: "plan-done", videoSlug: video.slug, videoFile: video.sourceFile.originalName });
            } catch (e) {
              send({
                type: "plan-error",
                videoSlug: video.slug,
                videoFile: video.sourceFile.originalName,
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
          send({ type: "done", videos: project.sourceVideos.length, prepared });
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        res.end();
        return;
      }

      // ── v2: create a tutorial folder from this video's key moments.
      // POST /api/create-tutorial-v2/<projectSlug>/<videoSlug>
      if (req.method === "POST" && pathname.startsWith("/api/create-tutorial-v2/")) {
        const rest = pathname.slice("/api/create-tutorial-v2/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return json(res, 400, { error: "expected projectSlug/videoSlug" });
        const projectSlug = rest.slice(0, slashIdx);
        const videoSlug = rest.slice(slashIdx + 1);
        const projectPath = projectPathForSlug(projectSlug);
        if (!projectPath || !isSafePathSegment(videoSlug)) return json(res, 400, { error: "bad slug" });
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        let parsed: { title?: string; steps?: number };
        try { parsed = await readJsonBody<{ title?: string; steps?: number }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        try {
          const project = await loadProjectV2(projectPath);
          if (!project) return json(res, 404, { error: "not a v2 project" });
          const video = project.videos.find((v) => v.slug === videoSlug);
          if (!video) return json(res, 404, { error: "video not found" });
          const titleBase = video.sourceFile.description?.title || video.sourceFile.originalName || videoSlug;
          const title = (parsed.title ?? "").trim() || `${titleBase.replace(/\.[^.]+$/, "")} Tutorial`;
          const steps = Number.isFinite(parsed.steps) && parsed.steps! > 0 ? Math.min(20, Math.floor(parsed.steps!)) : undefined;
          const result = await buildTutorial(video.root, {
            title,
            steps,
            format: "both",
          });
          return json(res, 200, {
            ok: true,
            tutorialName: result.tutorialName,
            outputDir: result.outputDir,
            files: result.files,
            stepCount: result.stepCount,
          });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: open a previously generated tutorial folder in Finder.
      // POST /api/open-tutorial-v2/<projectSlug>/<videoSlug>/<tutorialName>
      if (req.method === "POST" && pathname.startsWith("/api/open-tutorial-v2/")) {
        const rest = pathname.slice("/api/open-tutorial-v2/".length);
        const parts = rest.split("/");
        if (parts.length !== 3) return json(res, 400, { error: "expected projectSlug/videoSlug/tutorialName" });
        const [projectSlug, videoSlug, tutorialName] = parts;
        const projectPath = projectPathForSlug(projectSlug);
        if (!projectPath || !isSafePathSegment(videoSlug) || !isSafePathSegment(tutorialName)) {
          return json(res, 400, { error: "bad slug" });
        }
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        const videoRoot = path.join(projectPath, videoSlug);
        const tutorialsRoot = path.resolve(path.join(videoRoot, "tutorials"));
        const target = path.resolve(path.join(tutorialsRoot, tutorialName));
        const rel = path.relative(tutorialsRoot, target);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return json(res, 403, { error: "forbidden" });
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          return json(res, 404, { error: "tutorial folder not found" });
        }
        if (process.platform !== "darwin") {
          return json(res, 200, { ok: false, path: target, error: "Opening folders is only automated on macOS right now." });
        }
        const child = spawn("open", [target], { detached: true, stdio: "ignore" });
        child.unref();
        return json(res, 200, { ok: true, path: target });
      }

      // ── v2: delete one rendered clip from the project-level rendered list.
      // Body: {relative_path}, expected as
      // <videoSlug>/shorts/render-YYYYMMDD-HHMMSS/<file>.mp4.
      if (req.method === "POST" && pathname.startsWith("/api/delete-render-v2/")) {
        const projectSlug = pathname.slice("/api/delete-render-v2/".length);
        const projectPath = projectPathForSlug(projectSlug);
        if (!projectPath) return json(res, 400, { error: "bad project slug" });
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        let parsed: { relative_path?: string };
        try { parsed = await readJsonBody<{ relative_path?: string }>(req); } catch { return json(res, 400, { error: "bad JSON" }); }
        try {
          await deleteProjectRenderedClip(projectPath, parsed.relative_path || "");
          const project = await loadProjectV2(projectPath);
          return json(res, 200, { ok: true, project });
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: build (or reuse) the per-video plan UI.
      // POST /api/launch-plan-v2/<projectSlug>/<videoSlug> →
      //   { url: "/p/<projectSlug>/<videoSlug>/plan.html" }.
      if (req.method === "POST" && pathname.startsWith("/api/launch-plan-v2/")) {
        const rest = pathname.slice("/api/launch-plan-v2/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return json(res, 400, { error: "expected projectSlug/videoSlug" });
        const projectSlug = rest.slice(0, slashIdx);
        const videoSlug = rest.slice(slashIdx + 1);
        const projectPath = path.join(projectsRoot(), projectSlug);
        if (!isV2Project(projectPath)) return json(res, 404, { error: "not a v2 project" });
        const videoSubprojectRoot = path.join(projectPath, videoSlug);
        if (!existsSync(videoSubprojectRoot)) return json(res, 404, { error: "no such video subproject" });
        const cacheKey = `${projectSlug}/${videoSlug}`;
        try {
          let planDir = planDirs.get(cacheKey);
          if (!planDir || !existsSync(path.join(planDir, "plan.html"))) {
            await prepareV2VideoForPlanning(videoSubprojectRoot);
            const planHtml = await buildPlanUi(videoSubprojectRoot);
            planDir = path.dirname(planHtml);
            planDirs.set(cacheKey, planDir);
          }
          return json(res, 200, {
            url: `/p/${encodeURIComponent(projectSlug)}/${encodeURIComponent(videoSlug)}/plan.html`,
            planDir,
          });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── v2: mount the plan UI under /p/<projectSlug>/<videoSlug>/...
      // Forwards to handlePlanRequest with planDir + projectPath set to
      // the per-video subproject. <base> tag is injected so all relative
      // URLs in plan.html resolve back to this mount.
      if (pathname.startsWith("/p/")) {
        const rest = pathname.slice("/p/".length);
        const firstSlash = rest.indexOf("/");
        if (firstSlash < 0) return text(res, 404, "not found");
        const projectSlug = rest.slice(0, firstSlash);
        const afterProject = rest.slice(firstSlash + 1);
        const secondSlash = afterProject.indexOf("/");
        const videoSlug = secondSlash < 0 ? afterProject : afterProject.slice(0, secondSlash);
        const tail = secondSlash < 0 ? "/" : "/" + afterProject.slice(secondSlash + 1);
        const cacheKey = `${projectSlug}/${videoSlug}`;
        const videoSubprojectRoot = path.join(projectsRoot(), projectSlug, videoSlug);
        let planDir = planDirs.get(cacheKey);
        // Cold-start fallback: planDirs Map empty after a server restart, but
        // a previously-built plan.html may still live on disk under
        // <videoSubproject>/.cache/plan-ui/<hash>/. Try to find it.
        if (!planDir && existsSync(videoSubprojectRoot)) {
          const fresh = await resolvePlanDirIfFresh(videoSubprojectRoot);
          if (fresh) {
            planDir = fresh;
            planDirs.set(cacheKey, planDir);
          }
        }
        if (!planDir) return text(res, 404, "plan not built — open the project page and click Create Plan for Clips");
        const basePath = `/p/${projectSlug}/${videoSlug}`;
        const handled = await handlePlanRequest(
          req, res, tail, planDir, videoSubprojectRoot, videoSubprojectRoot, basePath,
        );
        if (!handled) return text(res, 404, "not found");
        return;
      }

      // ── v2: synthetic "cover image" for the project list — picks the
      // first available thumbnail under _sources/<anyVideoSlug>/thumbs/.
      // Returns 404 if no thumbnails have been generated yet (the UI
      // falls back to an initials placeholder).
      {
        const m = pathname.match(/^\/v2-source\/([^/]+)\/_first-thumb\.jpg$/);
        if (req.method === "GET" && m) {
          const slug = decodeURIComponent(m[1]!);
          const sourcesDir = path.join(projectsRoot(), slug, "_sources");
          if (!existsSync(sourcesDir)) return text(res, 404, "no thumb");
          try {
            const entries = await readdir(sourcesDir, { withFileTypes: true });
            const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
            for (const sub of subdirs) {
              const thumbDir = path.join(sourcesDir, sub, "thumbs");
              if (!existsSync(thumbDir)) continue;
              const files = (await readdir(thumbDir)).filter((n) => n.endsWith(".jpg"));
              if (files.length === 0) continue;
              files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
              return streamFile(path.join(thumbDir, files[0]!), req, res);
            }
          } catch { /* fall through */ }
          return text(res, 404, "no thumb");
        }
      }

      // ── v2: lazily-rendered first-frame poster for a rendered .mp4.
      // GET /v2-render-poster/<projectSlug>/<rest-of-mp4-path>
      // Generates a jpg next to the mp4 (in a _posters/ sibling dir)
      // via ffmpeg first-frame extraction; subsequent calls hit cache.
      if (req.method === "GET" && pathname.startsWith("/v2-render-poster/")) {
        const rest = pathname.slice("/v2-render-poster/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return text(res, 400, "bad path");
        const projectSlug = rest.slice(0, slashIdx);
        const tail = rest.slice(slashIdx + 1);
        const projectPath = path.join(projectsRoot(), projectSlug);
        if (!existsSync(projectPath)) return text(res, 404, "not found");
        const mp4 = path.resolve(path.join(projectPath, tail));
        const root = path.resolve(projectPath);
        if (!mp4.startsWith(root + path.sep)) return text(res, 403, "forbidden");
        if (!existsSync(mp4) || !mp4.toLowerCase().endsWith(".mp4")) return text(res, 404, "not a rendered mp4");
        // Cache poster at <dir>/_posters/<basename>.jpg.
        const dir = path.dirname(mp4);
        const base = path.basename(mp4, ".mp4");
        const posterDir = path.join(dir, "_posters");
        const poster = path.join(posterDir, `${base}.jpg`);
        if (!existsSync(poster)) {
          try {
            await (await import("node:fs/promises")).mkdir(posterDir, { recursive: true });
            const ffmpeg = getFfmpegPath();
            await runProc(ffmpeg, [
              "-y", "-ss", "0", "-i", mp4,
              "-frames:v", "1",
              "-vf", "scale='min(540,iw)':-2,format=yuvj420p",
              "-c:v", "mjpeg", "-pix_fmt", "yuvj420p",
              "-q:v", "4", "-threads:v", "1", "-strict", "-2", "-f", "image2",
              poster,
            ]);
          } catch (e) {
            return text(res, 500, e instanceof Error ? e.message : String(e));
          }
        }
        return streamFile(poster, req, res);
      }

      // ── v2: serve a source-side thumbnail or working video.
      // /v2-source/<projectSlug>/_sources/<file>           (originals)
      // /v2-source/<projectSlug>/_sources/<videoSlug>/thumbs/<ms>.jpg
      // /v2-source/<projectSlug>/<videoSlug>/video.<ext>   (working copy)
      if (req.method === "GET" && pathname.startsWith("/v2-source/")) {
        const rest = pathname.slice("/v2-source/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return text(res, 400, "bad path");
        const projectSlug = rest.slice(0, slashIdx);
        const tail = rest.slice(slashIdx + 1);
        const projectPath = path.join(projectsRoot(), projectSlug);
        if (!existsSync(projectPath)) return text(res, 404, "not found");
        // Resolve under the project root and prevent traversal outside it.
        const target = path.resolve(path.join(projectPath, tail));
        const root = path.resolve(projectPath);
        if (!target.startsWith(root + path.sep) && target !== root) return text(res, 403, "forbidden");
        return streamFile(target, req, res);
      }


      // Auto-pair videos with external audio in a folder.
      if (req.method === "POST" && pathname === "/api/match-audio") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { folder } = JSON.parse(body) as { folder: string };
        if (!folder) return json(res, 400, { error: "missing folder" });
        try {
          const report = await matchAudioFiles(folder);
          return json(res, 200, report);
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      text(res, 404, "not found");
    } catch (e) {
      text(res, 500, `error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const port = await listen(server, opts.port ?? 8764);
  const url = `http://127.0.0.1:${port}/`;
  return {
    port,
    url,
    close: async () => {
      // Tear down every plan-ui we spawned, then the hub itself.
      // (PR 3 will manage per-(project, video) plan-server handles here.)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Pretty-print the command users should put into their MCP config. When run
// from a globally-installed npm package this is just `aicw-video mcp`; when
// run from a clone (`node /path/to/dist/cli.js home`) we emit the full node
// invocation so copy-paste works without further fiddling.
function cliInvocation(): { full: string; isGlobal: boolean; cliPath: string } {
  const cliPath = path.resolve(process.argv[1] || "");
  const isGlobal = !cliPath.endsWith(".js") || cliPath.includes("/node_modules/.bin/");
  if (isGlobal) return { full: "aicw-video mcp", isGlobal: true, cliPath };
  return { full: `node ${cliPath} mcp`, isGlobal: false, cliPath };
}

function statusBadges(p: ProjectSummary): string {
  const b = (label: string, on: boolean): string =>
    `<span class="badge${on ? " on" : ""}">${escapeHtml(label)}</span>`;
  const renders = p.status.renderCount > 0
    ? `<span class="badge on">${p.status.renderCount} render${p.status.renderCount === 1 ? "" : "s"}</span>`
    : `<span class="badge">no renders</span>`;
  const clips = p.status.clipCount > 0
    ? `<span class="badge on">${p.status.clipCount} clip${p.status.clipCount === 1 ? "" : "s"}</span>`
    : "";
  return [
    b("source", p.status.hasSource),
    b("transcript", p.status.hasTranscript),
    b("analysis", p.status.hasAnalysis),
    b("plan", p.status.hasPlan),
    clips,
    renders,
  ].filter(Boolean).join("");
}

function fmtAge(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shellQuoteForDisplay(p: string): string {
  return "'" + String(p || "").replace(/'/g, "'\\''") + "'";
}

const FALLBACK_SKILL_BODY = `---
name: aicw-video
description: Use AICW Video to turn local video/audio files into short clips, captions, rendered social videos, or step-by-step tutorials through the aicw-video MCP tools and local review hub.
---

# AICW Video

Use the aicw-video MCP tools to create projects, analyze local video/audio, open the review hub, edit clip plans, render clips, and export tutorials. Prefer the review hub over manual ffmpeg commands.
`;

function loadBundledSkillBody(): string {
  const bundledSkillPath = path.resolve(RUNTIME_DIR, "..", "skills", "aicw-video", "SKILL.md");
  try {
    return readFileSync(bundledSkillPath, "utf8");
  } catch {
    return FALLBACK_SKILL_BODY;
  }
}

function renderHomeHtml(args: {
  projects: ProjectSummary[];
  cliPath: { full: string; isGlobal: boolean; cliPath: string };
}): string {
  const cmdInvocation = args.cliPath.isGlobal
    ? { command: "aicw-video", args: ["mcp"] }
    : { command: "node", args: [args.cliPath.cliPath, "mcp"] };
  const claudeCodeCmd = args.cliPath.isGlobal
    ? `claude mcp add aicw-video -- aicw-video mcp`
    : `claude mcp add aicw-video -- node ${args.cliPath.cliPath} mcp`;
  const claudeDesktopJson = JSON.stringify(
    { mcpServers: { "aicw-video": cmdInvocation } },
    null,
    2,
  );
  const projectsOpenCommand = `open ${shellQuoteForDisplay(projectsRoot())}`;
  // OpenClaw (https://docs.openclaw.ai) is a self-hosted MCP-capable local
  // agent. Servers are registered under mcp.servers.<name> with a familiar
  // {command,args,env?,cwd?} shape — same fields the agent runs as a child
  // process. The friendliest path is the one-liner CLI: `openclaw mcp set`.
  const openclawCmd = `openclaw mcp set aicw-video '${JSON.stringify({
    command: cmdInvocation.command,
    args: cmdInvocation.args,
  })}'`;
  const openclawJson = JSON.stringify(
    {
      mcp: {
        servers: {
          "aicw-video": {
            command: cmdInvocation.command,
            args: cmdInvocation.args,
          },
        },
      },
    },
    null,
    2,
  );
  // Claude Skill scaffold — a SKILL.md the user drops into
  // ~/.claude/skills/aicw-video/ so any Claude Code session can invoke it
  // via /aicw-video. Pairs with (does not replace) the MCP registration.
  const skillPath = `${process.env.HOME ?? "~"}/.claude/skills/aicw-video/SKILL.md`;
  const skillBody = loadBundledSkillBody();

  // Each project is a YouTube-style tile: thumbnail (or initials placeholder),
  // title, subtitle (modified time + status hint).
  const activeProjects = args.projects.filter((p) => !p.archived);
  const archivedProjects = args.projects.filter((p) => p.archived);
  const renderProjectTile = (p: ProjectSummary): string => {
    const initials = (p.title || p.slug).split(/[\s-_]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "AV";
    const statusHint = p.status.clipCount > 0
      ? `${p.status.clipCount} clip${p.status.clipCount === 1 ? "" : "s"}`
      : p.status.hasPlan ? "plan ready"
      : p.status.hasTranscript ? "described"
      : "new";
    const thumbUrl = `/v2-source/${escapeHtml(p.slug)}/_first-thumb.jpg`;
    const archiveAction = p.archived
      ? `<button class="project-card-unarchive" type="button" role="menuitem">Restore project</button>`
      : `<button class="project-card-archive" type="button" role="menuitem">Archive project…</button>`;
    return `<article class="project-tile${p.archived ? " archived" : ""}" data-slug="${escapeHtml(p.slug)}" data-title="${escapeHtml(p.title)}" data-archived="${p.archived ? "1" : "0"}">
  <a class="project-link" href="#/project/${escapeHtml(p.slug)}" data-slug="${escapeHtml(p.slug)}">
    <div class="pl-thumb">
      <img loading="lazy" alt="" src="${thumbUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <span class="pl-thumb-fallback" style="display:none">${escapeHtml(initials)}</span>
      ${p.archived ? `<span class="pl-archived">Archived</span>` : ""}
    </div>
    <div class="pl-meta">
      <span class="project-title">${escapeHtml(p.title)}</span>
      <span class="pl-sub"><span>${escapeHtml(fmtAge(p.modifiedAt))}</span><span class="dot"></span><span>${escapeHtml(statusHint)}</span></span>
    </div>
  </a>
  <button class="project-menu-btn" type="button" aria-label="Project actions" aria-haspopup="menu" aria-expanded="false" title="Project actions">
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
  </button>
  <div class="project-card-menu" hidden role="menu">
    <button class="project-card-rename" type="button" role="menuitem">Rename project…</button>
    <button class="project-card-new-version" type="button" role="menuitem">Start new version…</button>
    ${archiveAction}
  </div>
</article>`;
  };
  const newProjectToggle = (emptyMode = false): string => `<details class="new-project-toggle${emptyMode ? " new-project-empty-toggle" : ""}" id="new-project-toggle">
      <summary${emptyMode ? ` class="empty-new-project-summary"` : ""}>
        ${emptyMode
      ? `<span class="empty-title">No Active Projects</span>
        <span class="empty-copy">${archivedProjects.length > 0 ? "Archived projects are below." : "Create a project from videos and optional external audio."}</span>
        <span class="empty-new-project-btn">Create New Project…</span>`
      : `<span class="np-toggle-icon">＋</span>
        <span class="np-toggle-label">New project</span>
        <span class="np-toggle-hint">a folder of videos + audio for one shoot or topic</span>`}
      </summary>
    <section class="new-project-block">
      <div class="np-row">
        <label class="np-label" for="new-project-files">Media files</label>
        <div class="file-picker file-picker-multi" id="new-project-picker">
          <input id="new-project-files" type="file" accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv,.m4a,.mp3,.wav,.aac,.flac" multiple hidden>
          <button class="picker-btn" type="button" id="new-project-browse">Choose files…</button>
          <span class="picker-name" id="new-project-files-summary">No files chosen yet</span>
        </div>
      </div>
      <div class="np-row" id="new-project-name-row" hidden>
        <label class="np-label" for="new-project-name-input">Name</label>
        <input id="new-project-name-input" type="text" placeholder="Suggested from selected files">
      </div>
      <div class="np-row np-checkbox-row">
        <span class="np-label">Audio</span>
        <label class="np-checkbox">
          <input id="new-project-automatch" type="checkbox" checked>
          <span>Auto-match separate audio tracks (if any) to videos</span>
        </label>
      </div>
      <div class="np-row np-checkbox-row">
        <span class="np-label">AI analysis</span>
        <label class="np-checkbox np-checkbox-rich">
          <input id="new-project-ai-scene-analysis" type="checkbox">
          <span>Analyze and suggest which scenes to cut from video using AI you have installed: ChatGPT, Claude, or Ollama based on config.<small>When off, AICW Video still uses Whisper audio transcripts, local face detection, and face-focused crop hints.</small></span>
        </label>
      </div>
      <div class="np-row np-actions">
        <span class="np-label"></span>
        <div class="np-actions-inner">
          <button id="new-project-go" class="primary-btn" type="button" disabled>Create project</button>
        </div>
      </div>
      <div id="new-project-status"></div>
    </section>
    </details>`;
  const projectRows = activeProjects.length === 0
    ? newProjectToggle(true)
    : activeProjects.map(renderProjectTile).join("\n");
  const archivedRows = archivedProjects.map(renderProjectTile).join("\n");

  // Embed the project list as JSON so the client-side router can render
  // the project page without a server round-trip.
  const projectsJson = JSON.stringify(
    args.projects.map((p) => ({
      slug: p.slug,
      title: p.title,
      path: p.path,
      modifiedAt: p.modifiedAt,
      status: p.status,
      archived: p.archived,
    })),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aicw-video</title>
<link rel="stylesheet" href="/assets/tailwind.css">
<style>
:root{
  --bg:#fafafa;
  --surface:#ffffff;
  --surface-2:#f4f4f5;
  --ink:#18181b;
  --muted:#71717a;
  --border:#e4e4e7;
  --border-strong:#d4d4d8;
  --accent:#f59e0b;
  --accent-soft:rgba(245,158,11,.12);
  --brand:#3b82f6;
  --brand-soft:rgba(59,130,246,.12);
  --ok:#16a34a;
  --ok-soft:rgba(22,163,74,.12);
  --warn:#ea580c;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.05);
  --shadow-elev:0 6px 18px rgba(0,0,0,.08);
}
[data-theme="dark"]{
  --bg:#0e1115;
  --surface:#191d24;
  --surface-2:#13171d;
  --ink:#e7eaee;
  --muted:#9aa3b2;
  --border:#2a2f37;
  --border-strong:#3a4250;
  --accent:#ffd60a;
  --accent-soft:rgba(255,214,10,.12);
  --brand:#6aa9ff;
  --brand-soft:rgba(106,169,255,.18);
  --ok:#33d17a;
  --ok-soft:rgba(51,209,122,.18);
  --warn:#ffa657;
  --shadow:0 1px 2px rgba(0,0,0,.4);
  --shadow-elev:0 8px 24px rgba(0,0,0,.55);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.55}
body{padding:0}
main{max-width:1280px;margin:0 auto;padding:24px 24px 60px}
h1{font-size:1.05rem;margin:0;font-weight:600}
h2{font-size:1.5rem;margin:0;font-weight:600;letter-spacing:-.01em}
h3{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin:0}
.hint-small{color:var(--muted);font-size:.82em}
code{background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:.85em;font-family:"SF Mono",Menlo,Consolas,monospace}
pre{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:.84em;font-family:"SF Mono",Menlo,Consolas,monospace;margin:0;color:var(--ink)}
input[type="text"]{background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.55em .75em;font-family:inherit;font-size:.95em;transition:border-color .15s,box-shadow .15s}
input[type="text"]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}

/* Top app bar */
.appbar{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--border);box-shadow:var(--shadow)}
.appbar-inner{max-width:1280px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:12px 24px}
.appbar-brand{display:flex;align-items:center;gap:10px;cursor:pointer;text-decoration:none;color:var(--ink)}
.appbar-brand .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--accent));display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:.92em;box-shadow:var(--shadow)}
.appbar-brand .name{font-size:1.05rem;font-weight:600}
.appbar-spacer{flex:1}
.appbar-actions{display:flex;align-items:center;gap:6px}
.appbar-site{color:var(--muted);font-size:.85em;text-decoration:none;padding:0 8px;border-radius:6px;transition:color .12s,background .12s}
.appbar-site:hover{color:var(--ink);background:var(--surface-2)}
.iconbtn{appearance:none;background:transparent;color:var(--ink);border:1px solid transparent;border-radius:8px;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:1.05em;transition:background .12s,border-color .12s}
.iconbtn svg,.project-menu-btn svg{display:block;flex-shrink:0;color:currentColor;fill:none;stroke:currentColor}
.appbar-gh svg,.project-menu-btn svg{fill:currentColor;stroke:none}
.iconbtn:hover{background:var(--surface-2);border-color:var(--border)}
.appbar-cta{appearance:none;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:.5em 1em;font-weight:600;font-size:.9em;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.appbar-cta:hover{filter:brightness(1.07)}

/* Drawer */
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:25;opacity:0;pointer-events:none;transition:opacity .18s}
body.drawer-open .drawer-overlay{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);background:var(--surface);border-left:1px solid var(--border);z-index:26;box-shadow:var(--shadow-elev);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column}
body.drawer-open .drawer{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.drawer-head h2{margin:0;font-size:1.05rem;font-weight:600}
.drawer-body{padding:18px;overflow-y:auto;flex:1}
.drawer-body h3{margin:1.4em 0 .5em}
.drawer-body h3:first-child{margin-top:0}

/* Modal used when a video has no usable audio and needs visual context. */
.visual-context-modal[hidden]{display:none}
.visual-context-modal{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px}
.vcm-overlay{position:absolute;inset:0;background:rgba(0,0,0,.42)}
.vcm-pane{position:relative;width:min(620px,100%);max-height:min(720px,92vh);overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-elev);padding:18px 20px}
.vcm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.vcm-head h2{font-size:1.08rem;line-height:1.25;margin:0}
.vcm-body{display:flex;flex-direction:column;gap:12px}
.vcm-copy{color:var(--muted);font-size:.9em;margin:0}
.vcm-files{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--ink);font-size:.84em;max-height:120px;overflow:auto}
.vcm-file{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
.vcm-file-reason{color:var(--muted);font-size:.9em;white-space:nowrap}
.vcm-options{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.vcm-options[hidden]{display:none}
.vcm-options-title{font-weight:700;color:var(--ink);font-size:.92em}
.vcm-check{display:flex;align-items:flex-start;gap:8px;color:var(--ink);font-size:.9em;line-height:1.35}
.vcm-check input{margin-top:3px;accent-color:var(--brand)}
.vcm-check span{display:flex;flex-direction:column;gap:1px}
.vcm-check small{color:var(--muted);font-size:.9em}
.vcm-label{display:flex;flex-direction:column;gap:6px;color:var(--ink);font-size:.9em;font-weight:600}
.vcm-label[hidden]{display:none}
.vcm-textarea{width:100%;min-height:150px;resize:vertical;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.7em .8em;font-family:inherit;font-size:.95em;line-height:1.45}
.vcm-textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.vcm-error{color:#dc2626;font-size:.84em}
.vcm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px}

/* Inner host-setup tabs (preserved) */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:.6em 0;flex-wrap:wrap}
.tab{appearance:none;background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;padding:.5em .8em;font-size:.85em;font-weight:500;cursor:pointer;font-family:inherit;border-radius:0}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--ink);border-bottom-color:var(--brand);font-weight:600}
.tab-panel{display:none;padding:14px 0}
.tab-panel.active{display:block}
.top-panel{display:block}
.top-panel:not(.active){display:none}
.settings-h{display:none}
.step{margin:.7em 0 .35em;color:var(--ink);font-weight:500;font-size:.92em}
.step:first-child{margin-top:0}
.kv{margin:.4em 0;padding-left:1.2em}
.kv li{margin:.3em 0;color:var(--ink);font-size:.92em}
.tab-h{font-size:.74rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:1.4em 0 .4em;font-weight:600}
.tab-h:first-child{margin-top:0}
.warn-text{background:rgba(234,88,12,.08);border:1px solid rgba(234,88,12,.4);border-radius:8px;padding:8px 12px;color:var(--ink);font-size:.88em}
.copy-row{display:flex;gap:8px;align-items:flex-start}
.copy-row pre{flex:1;min-width:0}
.copy-btn{background:var(--surface);border:1px solid var(--border);color:var(--ink);border-radius:6px;padding:.45em .8em;font-size:.82em;cursor:pointer;font-family:inherit;white-space:nowrap}
.copy-btn:hover{background:var(--surface-2)}
.copy-btn.copied{background:var(--ok-soft);border-color:var(--ok);color:var(--ok)}
.page-footer{margin-top:2em;padding:1em 0 1.2em;text-align:center;color:var(--muted);font-size:.82em;border-top:1px solid var(--border)}
.page-footer .footer-gh{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;color:var(--muted);transition:color .12s,background .12s}
.page-footer .footer-gh:hover{color:var(--ink);background:var(--surface-2)}
/* Project tile grid (YouTube-style cards) */
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.project-tile{position:relative;min-width:0}
.project-link{display:flex;flex-direction:column;gap:10px;text-decoration:none;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;transition:transform .12s ease}
.project-link:hover{transform:translateY(-2px)}
.project-link .pl-thumb{aspect-ratio:16/9;border-radius:12px;background:linear-gradient(135deg,var(--surface-2),var(--surface));border:1px solid var(--border);overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.78em;position:relative;box-shadow:var(--shadow)}
.project-link:hover .pl-thumb{box-shadow:var(--shadow-elev)}
.project-link .pl-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.project-link .pl-thumb-fallback{font-size:1.6em;color:var(--muted);font-weight:700}
.project-link .pl-archived{position:absolute;top:8px;left:8px;background:color-mix(in srgb,var(--surface) 92%,transparent);border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:.72em;font-weight:700}
.project-link .pl-meta{display:flex;flex-direction:column;gap:2px;padding:0 2px}
.project-link .project-title{font-size:.98rem;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-link .pl-sub{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.82em;font-variant-numeric:tabular-nums}
.project-link .pl-sub .dot{width:3px;height:3px;border-radius:50%;background:var(--muted)}
.archived-projects{margin-top:2em}
.project-tile.archived{opacity:.78}
.project-tile.archived:hover{opacity:1}
.project-menu-btn{appearance:none;position:absolute;top:8px;right:8px;width:34px;height:34px;border-radius:8px;border:1px solid var(--border);background:color-mix(in srgb,var(--surface) 92%,transparent);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow);opacity:.96;transition:background .12s,border-color .12s}
.project-menu-btn:focus,.project-menu-btn[aria-expanded="true"]{opacity:1}
.project-menu-btn:hover{background:var(--surface);border-color:var(--border-strong)}
.project-card-menu{position:absolute;top:48px;right:8px;min-width:190px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-elev);padding:6px;z-index:10}
.project-card-menu button{appearance:none;background:transparent;border:0;border-radius:6px;padding:.55em .7em;text-align:left;display:block;width:100%;cursor:pointer;color:var(--ink);font-family:inherit;font-size:.88em}
.project-card-menu button:hover{background:var(--surface-2)}
.project-card-menu .danger{color:#dc2626}
.project-card-menu .danger:hover{background:rgba(220,38,38,.08)}
.empty{background:var(--surface);border:1px dashed var(--border-strong);border-radius:12px;padding:32px 20px;color:var(--muted);text-align:center;grid-column:1/-1}
/* Project view (single project) */
#view-project-v2{padding:0}
.back-row{margin:0 0 1em}
.back-link{display:inline-flex;align-items:center;gap:6px;color:var(--muted);text-decoration:none;font-size:.88em;font-weight:500;padding:.3em 0;border-radius:4px}
.back-link:hover{color:var(--ink)}
.project-header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin:0 0 1em}
.project-header h2{margin:0}
.editable-title{cursor:text;display:inline-flex;max-width:100%;border-radius:6px;padding:0 2px;margin-left:-2px}
.editable-title:hover{background:var(--surface-2)}
.inline-title-input{width:min(620px,100%);font-size:1.5rem;font-weight:600;line-height:1.25;background:var(--surface);color:var(--ink);border:1px solid var(--brand);border-radius:8px;padding:.12em .3em;box-shadow:0 0 0 3px var(--brand-soft)}
.inline-title-input:focus{outline:none}
.project-header .age{color:var(--muted);font-size:.82em;font-variant-numeric:tabular-nums}
.project-header-main{flex:1;min-width:0}
.project-header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
.project-path{margin:.55em 0 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:.82em}
.project-path code{background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:.32em .55em;color:var(--ink);font-family:"SF Mono",Menlo,Consolas,monospace;max-width:min(900px,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-path button{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:7px;padding:.32em .65em;font-size:.86em;font-weight:700;cursor:pointer;font-family:inherit}
.project-path button:hover{background:var(--brand-soft);border-color:var(--brand)}
.home-projects-path{margin:.1em 0 1.1em}
.project-workflow{display:flex;flex-direction:column;gap:10px;margin:0 0 1.1em;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
.workflow-top{display:flex;align-items:center;gap:12px}
.workflow-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.wf-step{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.84em;white-space:nowrap}
.wf-step::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--border-strong)}
.wf-step.done{color:var(--ok)}
.wf-step.done::before{background:var(--ok)}
.wf-step.active{color:var(--brand);font-weight:600}
.wf-step.active::before{background:var(--brand)}
.wf-sep{color:var(--border-strong);font-size:.8em}
#v2-analyze-all-go{white-space:nowrap}
.workflow-status{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;background:var(--brand-soft);border:1px solid color-mix(in srgb,var(--brand) 36%,var(--border));border-radius:10px;padding:10px 12px;color:var(--ink);font-size:.92em}
.workflow-status[hidden]{display:none}
.workflow-status .wf-status-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.workflow-status .wf-status-action{appearance:none;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:.52em 1em;font-weight:700;font-size:.92em;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0}
.workflow-status .wf-status-action:hover:not(:disabled){filter:brightness(1.07)}
.workflow-status .wf-status-action:disabled{background:var(--border);color:var(--muted);cursor:not-allowed;filter:none}
.workflow-status .wf-ai-option{display:flex;align-items:flex-start;gap:8px;flex:1 1 100%;font-size:.9em;line-height:1.35;color:var(--ink)}
.workflow-status .wf-ai-option input{margin-top:.2em;accent-color:var(--brand);flex-shrink:0}
.workflow-status .wf-ai-option span{display:flex;flex-direction:column;gap:2px}
.workflow-status .wf-ai-option small{color:var(--muted);font-size:.88em}
.workflow-status .wf-spinner{width:16px;height:16px;border-radius:50%;border:2px solid color-mix(in srgb,var(--brand) 28%,transparent);border-top-color:var(--brand);animation:wfspin .8s linear infinite;flex-shrink:0}
.workflow-status .wf-status-text{font-weight:700}
.workflow-status .wf-status-detail{color:var(--muted);font-size:.92em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.workflow-status.idle{background:transparent;border-color:var(--border);color:var(--muted)}
.workflow-status.idle .wf-spinner{display:none}
.workflow-status.done{background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 42%,var(--border))}
.workflow-status.done .wf-spinner{display:none}
.workflow-status.error{background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.35)}
.workflow-status.error .wf-spinner{display:none}
@keyframes wfspin{to{transform:rotate(360deg)}}
/* Project actions dropdown */
.proj-menu{position:relative}
.proj-menu-pop{position:absolute;top:calc(100% + 6px);right:0;min-width:280px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-elev);padding:6px;z-index:30}
.proj-menu-pop button{appearance:none;background:transparent;border:0;border-radius:6px;padding:.55em .7em;text-align:left;display:flex;flex-direction:column;gap:2px;width:100%;cursor:pointer;color:var(--ink);font-family:inherit}
.proj-menu-pop button:hover:not(:disabled){background:var(--surface-2)}
.proj-menu-pop button:disabled{opacity:.55;cursor:not-allowed}
.proj-menu-pop button.danger-menu .pm-label{color:#dc2626}
.proj-menu-pop button.danger-menu:hover{background:rgba(220,38,38,.08)}
.proj-menu-pop .pm-label{font-size:.92em;font-weight:500}
.proj-menu-pop .pm-hint{font-size:.78em;color:var(--muted);font-weight:400}
.proj-videos-wrap{margin-top:.4em}
.proj-section{margin:1.4em 0 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;box-shadow:var(--shadow)}
.proj-h{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0 0 .4em;font-weight:600}
.step-section .step-header{display:flex;align-items:center;gap:10px;margin:0 0 .3em}
.proj-meta{margin:.2em 0 0;color:var(--muted);font-size:.9em;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.v2-renders-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:.8em}
.v2-render-card{position:relative;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.v2-render-card video{width:100%;aspect-ratio:9/16;background:#000;display:block}
.v2-render-meta{display:flex;flex-direction:column;gap:2px;padding:.6em .7em;font-size:.8em;min-width:0}
.v2-render-title{font-weight:700;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-render-sub{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-render-actions{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:0 .7em .7em;font-size:.78em;position:relative;flex-wrap:wrap}
.v2-render-actions a{color:var(--brand);font-weight:700;text-decoration:none}
.v2-render-actions a:hover{text-decoration:underline}
.v2-render-menu-wrap{margin-left:auto;position:relative}
.v2-render-menu-btn{appearance:none;background:transparent;color:var(--muted);border:1px solid transparent;border-radius:7px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:1.2em;font-weight:800;line-height:1;cursor:pointer}
.v2-render-menu-btn:hover,.v2-render-menu-btn[aria-expanded="true"]{background:var(--surface);color:var(--ink);border-color:var(--border)}
.v2-render-menu{position:absolute;right:0;bottom:calc(100% + 6px);min-width:150px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-elev);padding:5px;z-index:25}
.v2-render-menu button{appearance:none;background:transparent;border:0;border-radius:6px;padding:.5em .65em;text-align:left;display:block;width:100%;cursor:pointer;color:#dc2626;font-family:inherit;font-size:.9em}
.v2-render-menu button:hover{background:rgba(220,38,38,.08)}
/* File pickers */
.file-picker{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:.5em}
.file-picker.drag-over{outline:2px dashed var(--brand);outline-offset:4px;border-radius:10px}
.picker-btn{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.5em 1em;font-size:.9em;cursor:pointer;font-family:inherit}
.picker-btn:hover{background:var(--surface-2);border-color:var(--border-strong)}
.picker-name{flex:1;min-width:120px;color:var(--muted);font-size:.84em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.picker-name.has-file{color:var(--ink)}
/* V2 project: source files list */
.v2-files-group{margin-top:.7em}
.v2-files-group h4{font-size:.74rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0 0 .4em;font-weight:600}
.v2-file-row{display:flex;align-items:center;gap:12px;padding:.45em 0;border-bottom:1px solid var(--border);font-size:.9em}
.v2-file-row:last-child{border-bottom:0}
.v2-file-row .v2-file-name{font-weight:500;color:var(--ink)}
.v2-file-row .v2-file-title{flex:1;color:var(--muted);font-size:.84em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-file-row .v2-file-status{flex-shrink:0;font-size:.78em;color:var(--muted)}
.v2-file-row.described .v2-file-status{color:var(--ok)}
.v2-describe-actions{display:flex;gap:14px;align-items:center;margin-top:.6em}
.v2-progress{margin-top:.7em;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;max-height:220px;overflow-y:auto;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.78em;color:var(--muted)}
.v2-progress .pr-line{padding:1px 0}
.v2-progress .pr-done{color:var(--ok)}
.v2-progress .pr-error{color:#ef4444}

/* Per-video tile (YouTube watch-card style) */
.v2-videos-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}
.v2-video-card{display:flex;flex-direction:column;gap:8px;background:transparent;border:0;padding:0;margin:0;cursor:pointer;text-align:left;transition:transform .12s}
.v2-video-card:hover{transform:translateY(-2px)}
.v2-vc-thumb{aspect-ratio:16/9;border-radius:12px;background:#000;overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;color:#fff;border:1px solid var(--border);box-shadow:var(--shadow)}
.v2-video-card:hover .v2-vc-thumb{box-shadow:var(--shadow-elev)}
.v2-vc-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.v2-vc-thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:none;z-index:2;pointer-events:none}
.v2-vc-thumb.preview-on video{display:block}
.v2-vc-thumb-fallback{font-size:1.5em;color:rgba(255,255,255,.5);font-weight:700}
.v2-vc-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.0);transition:background .12s;z-index:1}
.v2-video-card:hover .v2-vc-play{background:rgba(0,0,0,.18)}
.v2-vc-play-icon{width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.95);color:var(--ink);display:flex;align-items:center;justify-content:center;font-size:1.2em;opacity:0;transition:opacity .12s;box-shadow:0 6px 20px rgba(0,0,0,.4)}
.v2-video-card:hover .v2-vc-play-icon{opacity:1}
.v2-vc-thumb.preview-on .v2-vc-play{display:none}
.v2-vc-info{display:flex;flex-direction:column;gap:2px;padding:0 2px}
.v2-vc-name{appearance:none;background:transparent;border:0;border-radius:6px;padding:0;text-align:left;font-weight:600;color:var(--ink);font-size:.95em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;font-family:inherit;line-height:1.35}
.v2-vc-name:hover,.v2-vc-name:focus{color:var(--brand);outline:none;text-decoration:underline;text-underline-offset:3px}
.v2-vc-title-input{background:var(--surface);color:var(--ink);border:1px solid var(--brand);border-radius:8px;padding:.25em .45em;font-size:.95em;font-weight:600;line-height:1.35;width:100%;box-shadow:0 0 0 3px var(--brand-soft)}
.v2-vc-title-input:focus{outline:none}
.v2-vc-title{color:var(--muted);font-size:.84em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-vc-status{font-size:.78em;color:var(--muted);display:flex;align-items:center;gap:6px;margin-top:2px}
.v2-vc-status .chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-weight:500}
.v2-vc-status .chip-muted{background:var(--surface-2);color:var(--muted);border:1px solid var(--border)}
.v2-vc-rows{display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:.8em}
.v2-vc-rows .vc-row{display:inline-flex;align-items:baseline;gap:6px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-vc-rows .vc-row strong{color:var(--ink);font-weight:500}
.v2-vc-rows .vc-ok{color:var(--ok)}
.v2-vc-rows .vc-ok strong{color:var(--ok)}
.v2-vc-rows .vc-muted{color:var(--muted)}
.v2-vc-rows .vc-pending{color:var(--warn)}
.v2-vc-rows .vc-dot{font-size:.85em;flex-shrink:0;min-width:.9em;display:inline-block;text-align:center}
.v2-vc-launch-status{font-size:.78em;color:var(--muted);min-height:1em;display:block;margin-top:2px}
.v2-vc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:7px}
.v2-vc-action{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.4em .75em;font-size:.78em;font-weight:600;cursor:pointer;font-family:inherit;line-height:1.2}
.v2-vc-action:hover:not(:disabled){background:var(--surface-2);border-color:var(--border-strong)}
.v2-vc-action:disabled{opacity:.6;cursor:wait}
/* Spinner overlay shown on a tile while /api/launch-plan-v2 builds. */
.v2-video-card.busy{cursor:wait}
.v2-vc-spinner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.55);color:#fff;z-index:5;border-radius:12px;backdrop-filter:blur(2px)}
.v2-vc-spinner-ring{width:38px;height:38px;border-radius:50%;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;animation:vcSpin .9s linear infinite}
.v2-vc-spinner-label{font-size:.82em;font-weight:500}
@keyframes vcSpin{to{transform:rotate(360deg)}}

/* Buttons: shared */
.primary-btn{appearance:none;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:.55em 1.1em;font-weight:600;cursor:pointer;font-family:inherit;font-size:.9em;white-space:nowrap;transition:filter .12s}
.primary-btn:hover:not(:disabled){filter:brightness(1.07)}
.primary-btn:disabled{background:var(--border);color:var(--muted);cursor:not-allowed}
.ghost-btn{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.5em 1em;font-size:.88em;cursor:pointer;font-family:inherit}
.ghost-btn:hover:not(:disabled){background:var(--surface-2);border-color:var(--border-strong)}
.ghost-btn:disabled{color:var(--muted);cursor:not-allowed;opacity:.6}

/* New-project: collapsed by default behind a "+ New project" button. */
.new-project-toggle{margin-bottom:1.2em;max-width:760px}
.new-project-toggle > summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:10px;padding:.6em 1.1em;background:var(--brand);color:#fff;border-radius:8px;font-weight:600;font-size:.95em;transition:filter .12s}
.new-project-toggle > summary:hover{filter:brightness(1.07)}
.new-project-toggle > summary::-webkit-details-marker{display:none}
.new-project-toggle .np-toggle-icon{font-size:1.1em;font-weight:400;line-height:1}
.new-project-toggle .np-toggle-hint{color:rgba(255,255,255,.78);font-size:.78em;font-weight:400}
.new-project-toggle[open] > summary{background:var(--surface);color:var(--ink);border:1px solid var(--border);box-shadow:var(--shadow);margin-bottom:0;border-bottom-left-radius:0;border-bottom-right-radius:0;padding:.55em 1.1em}
.new-project-toggle[open] > summary .np-toggle-hint{color:var(--muted)}
.new-project-toggle[open] > summary .np-toggle-icon{transform:rotate(45deg);display:inline-block;transition:transform .15s}
.new-project-toggle[open] .new-project-block{margin-bottom:0;border-top-left-radius:0;border-top-right-radius:0;border-top:0}
.new-project-empty-toggle{grid-column:1/-1;max-width:none;margin-bottom:0}
.new-project-empty-toggle > summary.empty-new-project-summary{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;background:var(--surface);color:var(--ink);border:1px dashed var(--border-strong);box-shadow:var(--shadow);padding:22px 24px;border-radius:12px}
.new-project-empty-toggle > summary.empty-new-project-summary:hover{filter:none;border-color:var(--brand)}
.new-project-empty-toggle .empty-title{font-size:1.1rem;font-weight:700;color:var(--ink)}
.new-project-empty-toggle .empty-copy{font-size:.88em;color:var(--muted);font-weight:400}
.new-project-empty-toggle .empty-new-project-btn{display:inline-flex;align-items:center;justify-content:center;margin-top:6px;background:var(--brand);color:#fff;border-radius:8px;padding:.62em 1em;font-size:.9em;font-weight:700}
.new-project-empty-toggle[open] > summary.empty-new-project-summary{border-bottom-left-radius:0;border-bottom-right-radius:0;border-style:solid}
.new-project-empty-toggle[open] .new-project-block{max-width:none;border-top:0;border-top-left-radius:0;border-top-right-radius:0}

/* Create-project card */
.new-project-block{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;box-shadow:var(--shadow);margin-bottom:1.2em;max-width:760px}
.np-h{font-size:1.05rem;font-weight:600;margin:0 0 .15em;color:var(--ink)}
.np-sub{color:var(--muted);font-size:.86em;margin:0 0 1em}
.new-project-block .np-row{display:grid;grid-template-columns:140px minmax(0,1fr);align-items:center;gap:12px;margin-top:.8em}
.new-project-block .np-row[hidden]{display:none}
.new-project-block .np-row .np-label{color:var(--muted);font-size:.84em;font-weight:600}
.new-project-block #new-project-name-input{width:100%;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.6em .75em;font-family:inherit;font-size:.95em}
.new-project-block #new-project-name-input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.new-project-block .file-picker-multi{display:flex;align-items:center;gap:12px;min-width:0}
.new-project-block .file-picker-multi .picker-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.new-project-block .np-checkbox-row{grid-template-columns:140px minmax(0,1fr)}
.new-project-block .np-checkbox{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.9em;color:var(--ink)}
.new-project-block .np-checkbox input{accent-color:var(--brand);width:16px;height:16px}
.new-project-block .np-checkbox-rich{align-items:flex-start}
.new-project-block .np-checkbox-rich input{margin-top:.22em;flex:0 0 auto}
.new-project-block .np-checkbox-rich span{display:flex;flex-direction:column;gap:3px;line-height:1.35}
.new-project-block .np-checkbox-rich small{font-size:.86em;color:var(--muted);line-height:1.35}
.new-project-block .np-actions{grid-template-columns:140px minmax(0,1fr);align-items:start}
.new-project-block .np-actions-inner{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#new-project-status{margin-top:.5em;color:var(--muted);font-size:.85em}
#new-project-go{appearance:none;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:.6em 1.15em;font-weight:600;cursor:pointer;font-family:inherit;font-size:.94em;white-space:nowrap}
#new-project-go:hover:not(:disabled){filter:brightness(1.07)}
#new-project-go:disabled{background:var(--border);color:var(--muted);cursor:not-allowed}
@media (max-width: 680px){
  .new-project-toggle,.new-project-block{max-width:none}
  .new-project-block .np-row,
  .new-project-block .np-checkbox-row,
  .new-project-block .np-actions{grid-template-columns:1fr;gap:6px}
  .new-project-block .file-picker-multi{align-items:flex-start;flex-direction:column}
}

/* Match-audio (folder utility) — pushed to footer drawer area */
.match-audio-block{margin:1.6em 0 0;background:transparent;border:0;border-radius:0;padding:0}
.match-audio-block > summary{list-style:none;cursor:pointer;display:inline-flex;gap:8px;align-items:center;color:var(--muted);font-size:.85em;padding:0}
.match-audio-block > summary::-webkit-details-marker{display:none}
.match-audio-block > summary::before{content:"▸";color:var(--muted);font-size:.78em;transition:transform .15s ease}
.match-audio-block[open] > summary::before{transform:rotate(90deg)}
.match-audio-block[open]{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
.match-audio-block[open] > summary{margin-bottom:.5em;color:var(--ink);font-weight:500}
.ma-summary-title{font-size:.92em}
#match-audio-folder{flex:1;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.5em .75em;font-family:inherit;font-size:.88em}
#match-audio-go{appearance:none;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:.5em 1em;font-weight:600;cursor:pointer;font-family:inherit;font-size:.88em;white-space:nowrap}
.ma-row{display:flex;align-items:center;gap:10px;padding:.45em 0;border-bottom:1px solid var(--border);font-size:.92em}
.ma-row:last-child{border-bottom:0}
.ma-row .ma-arrow{color:var(--muted)}
.ma-row .ma-score{color:var(--ok);font-size:.78em;font-variant-numeric:tabular-nums}
.ma-row.ma-no-match .ma-arrow,.ma-row.ma-no-match .ma-audio{color:var(--warn)}

/* Section title row helper */
.section-title-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 .8em}
.section-title-row h3{font-size:1rem;font-weight:600;color:var(--ink);text-transform:none;letter-spacing:0;margin:0}
.section-title-row .section-meta{color:var(--muted);font-size:.85em}
</style>
</head>
<body>

<header class="appbar">
  <div class="appbar-inner">
    <a class="appbar-brand" href="#" id="brand-home">
      <span class="logo">A</span>
      <span class="name">AICW Video</span>
    </a>
    <span class="appbar-spacer"></span>
    <div class="appbar-actions">
      <a class="appbar-gh iconbtn" href="https://github.com/aicw-io/aicw-video" target="_blank" rel="noopener" aria-label="aicw-video on GitHub" title="aicw-video on GitHub">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1 1.28 2.02 2.92 1.44.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16A10.7 10.7 0 0 1 12 6.1c.96 0 1.92.13 2.82.38 2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.33-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.12c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg>
      </a>
      <a class="appbar-site" href="https://www.aicw.io" target="_blank" rel="noopener">www.aicw.io</a>
      <button id="theme-toggle" class="iconbtn" type="button" aria-label="Toggle theme" title="Toggle theme">
        <svg class="theme-ico-light" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg class="theme-ico-dark" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      </button>
      <button id="open-help" class="iconbtn" type="button" aria-label="Help" title="Help">?</button>
    </div>
  </div>
</header>

<main>
<section class="top-panel active" data-top-panel="plans">
  <!-- LIST VIEW: project tile grid. -->
  <div id="view-list">
    ${activeProjects.length > 0 ? newProjectToggle(false) : ""}

    <div class="project-path home-projects-path">
      <span>Projects folder</span>
      <code id="home-open-command">${escapeHtml(projectsOpenCommand)}</code>
      <button id="home-copy-open-command" type="button">Copy command</button>
    </div>

    <div class="section-title-row">
      <h3>Your projects</h3>
      <span class="section-meta">${activeProjects.length} active</span>
    </div>
    <div class="projects">${projectRows}</div>

    ${archivedProjects.length > 0 ? `<section class="archived-projects">
      <div class="section-title-row">
        <h3>Archived projects</h3>
        <span class="section-meta">${archivedProjects.length} archived</span>
      </div>
      <div class="projects archived-grid">${archivedRows}</div>
    </section>` : ""}

    <details class="match-audio-block">
      <summary>
        <span class="ma-summary-title">Auto-pair videos with separate audio in a folder</span>
      </summary>
      <p class="hint-small" style="margin-top:.4em">Each file is transcribed once (cached next to the source).</p>
      <div class="copy-row" style="margin-top:.4em">
        <input id="match-audio-folder" type="text" placeholder="/path/to/folder">
        <button id="match-audio-go" type="button">Match</button>
      </div>
      <div id="match-audio-status" class="hint-small"></div>
      <div id="match-audio-results"></div>
    </details>
  </div>

  <!-- PROJECT VIEW: dedicated page for one project. Routes via
       #/project/<slug>. Populated client-side from the embedded list. -->
  <!-- V2 project view (multi-video). Shows after creating a project
       with multiple files. Source files in _sources/ are listed; the
       user clicks "Describe all" to populate descriptions + thumbnails.
       PR 2 will add per-video subprojects below. -->
  <div id="view-project-v2" hidden>
    <p class="back-row">
      <a class="back-link" href="#">← All projects</a>
    </p>
    <header class="project-header">
      <div class="project-header-main">
        <h2 id="v2-title" class="editable-title" tabindex="0" title="Click to rename"></h2>
        <p class="proj-meta" id="v2-meta"></p>
        <div class="project-path" id="v2-project-path-row" hidden>
          <span>Folder</span>
          <code id="v2-open-command"></code>
          <button id="v2-copy-open-command" type="button">Copy command</button>
        </div>
      </div>
      <div class="project-header-actions">
        <span class="age" id="v2-age"></span>
        <div class="proj-menu">
          <button id="proj-menu-btn" class="iconbtn" type="button" aria-label="Project actions" aria-haspopup="menu" aria-expanded="false" title="Project actions">⋮</button>
          <div class="proj-menu-pop" id="proj-menu-pop" hidden role="menu">
            <button id="proj-rename" type="button" role="menuitem">
              <span class="pm-label">Rename project…</span>
              <span class="pm-hint">updates the project folder name</span>
            </button>
            <button id="proj-add-files" type="button" role="menuitem">
              <span class="pm-label">Add files…</span>
              <span class="pm-hint">drop more videos / audio into _sources/</span>
            </button>
            <button id="proj-new-version" type="button" role="menuitem">
              <span class="pm-label">Start new version…</span>
              <span class="pm-hint">same source media, empty clips and renders</span>
            </button>
            <button id="v2-describe-go" type="button" role="menuitem">
              <span class="pm-label">Describe all video files</span>
              <span class="pm-hint">transcripts + thumbnails</span>
            </button>
            <button id="v2-match-go" type="button" role="menuitem">
              <span class="pm-label">Match video with separate audio track</span>
              <span class="pm-hint">replace each video's audio with its closest recording</span>
            </button>
            <button id="proj-show-files" type="button" role="menuitem">
              <span class="pm-label">Show source files</span>
            </button>
            <button id="proj-archive" type="button" role="menuitem">
              <span class="pm-label">Archive project…</span>
              <span class="pm-hint">renames the folder with a leading _</span>
            </button>
          </div>
          <input id="proj-add-files-input" type="file" accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv,.m4a,.mp3,.wav,.aac,.flac" multiple hidden>
        </div>
      </div>
    </header>

    <section class="project-workflow" id="v2-workflow">
      <div class="workflow-top">
        <div class="workflow-steps" id="v2-workflow-steps">
          <span class="wf-step" data-step="files">Files</span>
          <span class="wf-sep">→</span>
          <span class="wf-step" data-step="describe">Analyze</span>
          <span class="wf-sep">→</span>
          <span class="wf-step" data-step="audio">Audio</span>
          <span class="wf-sep">→</span>
          <span class="wf-step" data-step="plans">Clips</span>
        </div>
      </div>
      <div id="v2-analyze-progress" class="v2-progress" hidden></div>
      <div id="v2-analyze-status" class="workflow-status idle" hidden></div>
    </section>

    <!-- Inline progress for describe/match runs (streamed events). -->
    <div id="v2-describe-progress" class="v2-progress" hidden></div>
    <div id="v2-match-progress" class="v2-progress" hidden></div>
    <span id="v2-describe-status" class="hint-small" hidden></span>
    <span id="v2-match-status" class="hint-small" hidden></span>
    <section id="v2-describe-section" hidden></section>
    <section id="v2-match-section" hidden></section>

    <section class="proj-videos-wrap" id="v2-videos-section" hidden>
      <div id="v2-videos-list" class="v2-videos-list"></div>
    </section>

    <section class="proj-section" id="v2-renders-section" hidden>
      <div class="section-title-row">
        <h3>Rendered clips</h3>
        <span class="section-meta hint-small" id="v2-renders-count"></span>
      </div>
      <div id="v2-renders-list" class="v2-renders-list"></div>
    </section>

    <section class="proj-section" id="v2-orphans-section" hidden>
      <div class="section-title-row">
        <h3>Unmatched audio</h3>
        <span class="section-meta hint-small">no close video match</span>
      </div>
      <div id="v2-orphans-list"></div>
    </section>

    <details class="proj-section" id="v2-files-section" style="background:transparent;border:0;box-shadow:none;padding:0;margin-top:1.6em">
      <summary style="cursor:pointer;color:var(--muted);font-size:.85em;list-style:none;display:inline-flex;align-items:center;gap:6px"><span style="font-size:.78em">▸</span> Source files in this project</summary>
      <div id="v2-files" style="margin-top:.7em"></div>
    </details>
  </div>
</section>
</main>

<div id="visual-context-modal" class="visual-context-modal" hidden>
  <div class="vcm-overlay" data-vcm-cancel></div>
  <div class="vcm-pane" role="dialog" aria-modal="true" aria-labelledby="vcm-title">
    <div class="vcm-head">
      <h2 id="vcm-title">Describe this silent video</h2>
      <button class="iconbtn" type="button" aria-label="Close" title="Close" data-vcm-cancel>✕</button>
    </div>
    <div class="vcm-body">
      <p class="vcm-copy">No usable audio was detected. Add context so the visual analysis can create short moment captions from sampled frames.</p>
      <div id="vcm-files" class="vcm-files"></div>
      <div id="vcm-options" class="vcm-options" hidden>
        <div class="vcm-options-title">Regenerate</div>
        <label class="vcm-check"><input id="vcm-force-describe" type="checkbox" checked><span>Descriptions and captions<small>Refresh transcripts, visual captions, thumbnails, and source sidecars.</small></span></label>
        <label class="vcm-check"><input id="vcm-force-match" type="checkbox"><span>Audio matching<small>Redo separate-audio matching where audio files exist.</small></span></label>
        <label class="vcm-check"><input id="vcm-force-plans" type="checkbox" checked><span>Clip suggestions and plan<small>Replace existing suggested clips for each video.</small></span></label>
      </div>
      <label class="vcm-label" for="vcm-text">
        What is this video about?
        <textarea id="vcm-text" class="vcm-textarea" placeholder="Example: This screencast shows Revdoku running locally with Ollama and Gemma, reviewing private documents on a laptop."></textarea>
      </label>
      <div id="vcm-error" class="vcm-error" hidden></div>
      <div class="vcm-actions">
        <button class="ghost-btn" type="button" data-vcm-cancel>Cancel</button>
        <button class="primary-btn" type="button" id="vcm-save">Continue</button>
      </div>
    </div>
  </div>
</div>

<footer class="page-footer">
  <a href="https://github.com/aicw-io/aicw-video" target="_blank" rel="noopener" class="footer-gh" aria-label="aicw-video on GitHub" title="aicw-video on GitHub">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18.92-.26 1.9-.39 2.87-.39.97 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56 4.56-1.53 7.85-5.85 7.85-10.95C23.5 5.65 18.35.5 12 .5z"/></svg>
  </a>
</footer>

<div class="drawer-overlay" id="drawer-overlay" aria-hidden="true"></div>
<aside class="drawer" id="help-drawer" role="dialog" aria-label="Help" aria-modal="true">
  <div class="drawer-head">
    <h2>How to use</h2>
    <button id="close-help" class="iconbtn" type="button" aria-label="Close">✕</button>
  </div>
  <div class="drawer-body">
    <p style="margin:0 0 1em;color:var(--muted);font-size:.9em">Pick an AI host — install once, then trigger anytime.</p>
<section class="top-panel active" data-top-panel="settings">
  <nav class="tabs" role="tablist">
    <button class="tab active" data-host="claude-code">Claude Code</button>
    <button class="tab" data-host="claude-desktop">Claude Desktop</button>
    <button class="tab" data-host="claude-skill">Claude Skill</button>
    <button class="tab" data-host="openclaw">OpenClaw</button>
    <button class="tab" data-host="chatgpt">ChatGPT</button>
    <button class="tab" data-host="standalone">Standalone (no host)</button>
  </nav>

  <section class="tab-panel active" data-panel="claude-code">
    <h3 class="tab-h">Install</h3>
    <p class="step">1. Run in terminal:</p>
    <div class="copy-row">
      <pre id="snippet-cc">${escapeHtml(claudeCodeCmd)}</pre>
      <button class="copy-btn" data-copy-target="snippet-cc">Copy</button>
    </div>
    <p class="step">2. Verify: <code>claude mcp list</code> should now list <code>aicw-video</code>.</p>
    <h3 class="tab-h">Use it</h3>
    <p class="step">Start any Claude Code session in your terminal and type:</p>
    <div class="copy-row">
      <pre id="use-cc">use aicw-video to plan clips from video at &lt;local-path&gt;</pre>
      <button class="copy-btn" data-copy-target="use-cc">Copy</button>
    </div>
    <p class="step">Claude will run the full pipeline. When done, come back to the <a href="#" class="goto-plans">Plans</a> tab and open the plan UI to review &amp; render.</p>
  </section>

  <section class="tab-panel" data-panel="claude-desktop">
    <h3 class="tab-h">Install</h3>
    <p class="step">1. Open <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></p>
    <p class="step">2. Add this block (merge with existing <code>mcpServers</code> if present):</p>
    <div class="copy-row">
      <pre id="snippet-cd">${escapeHtml(claudeDesktopJson)}</pre>
      <button class="copy-btn" data-copy-target="snippet-cd">Copy</button>
    </div>
    <p class="step">3. Quit Claude Desktop with <kbd>⌘Q</kbd> and relaunch.</p>
    <h3 class="tab-h">Use it</h3>
    <p class="step">In any chat with Claude, type:</p>
    <div class="copy-row">
      <pre id="use-cd">use aicw-video to plan clips from video at &lt;local-path&gt;</pre>
      <button class="copy-btn" data-copy-target="use-cd">Copy</button>
    </div>
    <p class="step">Then come back to the <a href="#" class="goto-plans">Plans</a> tab and open the plan UI to review &amp; render.</p>
  </section>

  <section class="tab-panel" data-panel="claude-skill">
    <h3 class="tab-h">Install</h3>
    <p class="step">A Claude Skill turns common phrasings into one-shot triggers. Works alongside the Claude Code MCP registration.</p>
    <p class="step">1. Create the file at:</p>
    <div class="copy-row">
      <pre id="snippet-skill-path">${escapeHtml(skillPath)}</pre>
      <button class="copy-btn" data-copy-target="snippet-skill-path">Copy path</button>
    </div>
    <p class="step">2. Paste this content:</p>
    <div class="copy-row">
      <pre id="snippet-skill">${escapeHtml(skillBody)}</pre>
      <button class="copy-btn" data-copy-target="snippet-skill">Copy SKILL.md</button>
    </div>
    <h3 class="tab-h">Use it</h3>
    <p class="step">In any Claude Code session, the skill auto-triggers on matching phrasing. Just type:</p>
    <div class="copy-row">
      <pre id="use-skill">use aicw-video to plan clips from video at &lt;local-path&gt;</pre>
      <button class="copy-btn" data-copy-target="use-skill">Copy</button>
    </div>
    <p class="step">Then check the <a href="#" class="goto-plans">Plans</a> tab to open the plan UI.</p>
  </section>

  <section class="tab-panel" data-panel="openclaw">
    <h3 class="tab-h">Install</h3>
    <p class="step">Run in terminal:</p>
    <div class="copy-row">
      <pre id="snippet-ocl-cmd">${escapeHtml(openclawCmd)}</pre>
      <button class="copy-btn" data-copy-target="snippet-ocl-cmd">Copy</button>
    </div>
    <p class="step">Verify: <code>openclaw mcp list</code> should now list <code>aicw-video</code>.</p>
    <h3 class="tab-h">Use it</h3>
    <p class="step">In an OpenClaw chat, type:</p>
    <div class="copy-row">
      <pre id="use-ocl">use aicw-video to plan clips from video at &lt;local-path&gt;</pre>
      <button class="copy-btn" data-copy-target="use-ocl">Copy</button>
    </div>
    <p class="step">All tools execute locally on your machine. Then check the <a href="#" class="goto-plans">Plans</a> tab.</p>
  </section>

  <section class="tab-panel" data-panel="chatgpt">
    <h3 class="tab-h">Install</h3>
    <p class="step">ChatGPT Developer Mode currently imports remote MCP servers using SSE or streaming HTTP.</p>
    <p class="step">AICW Video currently exposes a local stdio MCP server:</p>
    <div class="copy-row">
      <pre id="snippet-cg">${escapeHtml(args.cliPath.full)}</pre>
      <button class="copy-btn" data-copy-target="snippet-cg">Copy</button>
    </div>
    <p class="step">Do not paste that command into ChatGPT's remote MCP URL field.</p>
    <p class="step">For OpenAI local-MCP workflows today, use the Codex tab. Once AICW Video has an HTTP MCP mode, create a ChatGPT app/connector from that HTTPS MCP URL.</p>
    <h3 class="tab-h">Use it</h3>
    <p class="step">In Codex, type:</p>
    <div class="copy-row">
      <pre id="use-cg">use aicw-video to plan clips from video at &lt;local-path&gt;</pre>
      <button class="copy-btn" data-copy-target="use-cg">Copy</button>
    </div>
    <p class="step">Then check the <a href="#" class="goto-plans">Plans</a> tab to open the plan UI.</p>
  </section>

  <section class="tab-panel" data-panel="standalone">
    <h3 class="tab-h">Run end-to-end without an MCP host</h3>
    <p class="step">If you'd rather not connect AICW Video to a chat host, configure ordered AI CLI tools in <code>config.json</code>. The app tries them in order for standalone AI steps.</p>
    <p class="step">Default chain: <code>${escapeHtml(configuredAiCliToolLabels().join(" → ") || "none configured")}</code>.</p>
    <p class="step">Install one or more supported CLIs, for example Claude Code:</p>
    <div class="copy-row">
      <pre id="snippet-standalone-install">npm install -g @anthropic-ai/claude-code</pre>
      <button class="copy-btn" data-copy-target="snippet-standalone-install">Copy</button>
    </div>
    <p class="step">2. Log in (uses your Claude account, opens a browser):</p>
    <div class="copy-row">
      <pre id="snippet-standalone-login">claude /login</pre>
      <button class="copy-btn" data-copy-target="snippet-standalone-login">Copy</button>
    </div>
    <h3 class="tab-h">Use it</h3>
    <p class="step">Run the full pipeline against any video — no chat needed:</p>
    <div class="copy-row">
      <pre id="use-standalone">aicw-video import &lt;local-path&gt; &amp;&amp; aicw-video go --project ~/aicw-video/projects/&lt;slug&gt;</pre>
      <button class="copy-btn" data-copy-target="use-standalone">Copy</button>
    </div>
    <p class="step">Or run individual AI steps:</p>
    <ul class="kv">
      <li><code>aicw-video describe --project &lt;p&gt;</code> — keyframe captions + summary.</li>
      <li><code>aicw-video plan-clips --project &lt;p&gt; [--count N]</code> — propose a shorts plan.</li>
    </ul>
    <p class="step">Each AI step shows which external CLI is running, then falls back to the next configured tool if one fails. Check the <a href="#" class="goto-plans">Plans</a> tab to open the plan UI for review &amp; render.</p>
  </section>
</section>
  </div>
</aside>

<script>
// Theme toggle (light default, persisted in localStorage).
(function(){
  var STORAGE_KEY = 'aicw-video-theme';
  function applyTheme(t){
    if(t === 'dark') document.documentElement.setAttribute('data-theme','dark');
    else document.documentElement.removeAttribute('data-theme');
    var l = document.querySelector('.theme-ico-light');
    var d = document.querySelector('.theme-ico-dark');
    if(l && d){ l.hidden = (t === 'dark'); d.hidden = (t !== 'dark'); }
  }
  try { applyTheme(localStorage.getItem(STORAGE_KEY) || 'light'); } catch(e){ applyTheme('light'); }
  var btn = document.getElementById('theme-toggle');
  if(btn) btn.addEventListener('click', function(){
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch(e){}
    applyTheme(next);
  });
})();

// Help drawer (replaces the old "How To Use" top tab).
function openHelp(){ document.body.classList.add('drawer-open'); }
function closeHelp(){ document.body.classList.remove('drawer-open'); }
function activateTop(name){ if(name === 'settings') openHelp(); else closeHelp(); }
var openH = document.getElementById('open-help');
if(openH) openH.addEventListener('click', openHelp);
var closeH = document.getElementById('close-help');
if(closeH) closeH.addEventListener('click', closeHelp);
var ovr = document.getElementById('drawer-overlay');
if(ovr) ovr.addEventListener('click', closeHelp);
document.addEventListener('keydown', function(ev){
  if(ev.key === 'Escape' && document.body.classList.contains('drawer-open')) closeHelp();
});
// Brand → home
var brand = document.getElementById('brand-home');
if(brand) brand.addEventListener('click', function(ev){ ev.preventDefault(); window.location.hash = ''; window.scrollTo({top:0,behavior:'smooth'}); });
document.querySelectorAll('.goto-settings').forEach(function(a){
  a.addEventListener('click', function(ev){ ev.preventDefault(); openHelp(); });
});
document.querySelectorAll('.goto-plans').forEach(function(a){
  a.addEventListener('click', function(ev){ ev.preventDefault(); closeHelp(); window.scrollTo({top:0,behavior:'smooth'}); });
});
// Inner tab strip (host-setup options inside Settings).
document.querySelectorAll('[data-host]').forEach(function(t){
  t.addEventListener('click', function(){
    var name = t.dataset.host;
    document.querySelectorAll('[data-host]').forEach(function(x){ x.classList.toggle('active', x.dataset.host === name); });
    document.querySelectorAll('[data-panel]').forEach(function(x){ x.classList.toggle('active', x.dataset.panel === name); });
  });
});
// Copy-to-clipboard for setup snippets.
document.querySelectorAll('.copy-btn').forEach(function(b){
  b.addEventListener('click', async function(){
    var el = document.getElementById(b.dataset.copyTarget);
    try {
      await navigator.clipboard.writeText(el.textContent);
      b.classList.add('copied');
      var was = b.textContent;
      b.textContent = 'Copied';
      setTimeout(function(){ b.classList.remove('copied'); b.textContent = was; }, 1400);
    } catch(e){ b.textContent = 'Copy failed'; }
  });
});
var homeCopyOpen = document.getElementById('home-copy-open-command');
if(homeCopyOpen) homeCopyOpen.addEventListener('click', async function(){
  var cmd = document.getElementById('home-open-command');
  if(!cmd) return;
  var was = homeCopyOpen.textContent;
  try {
    await navigator.clipboard.writeText(cmd.textContent || '');
    homeCopyOpen.textContent = 'Copied';
    setTimeout(function(){ homeCopyOpen.textContent = was; }, 1400);
  } catch(e){
    homeCopyOpen.textContent = 'Copy failed';
    setTimeout(function(){ homeCopyOpen.textContent = was; }, 1400);
  }
});
// Hash-based router. List view shows by default; #/project/<slug> shows
// the project page. The browser back button returns to the list because
// hashchange fires on every navigation.
var PROJECTS = ${projectsJson};
var AI_CLI_AVAILABLE = ${JSON.stringify(aiCliAvailable())};
function projectBySlug(slug){
  for (var i = 0; i < PROJECTS.length; i++) if (PROJECTS[i].slug === slug) return PROJECTS[i];
  return null;
}
function fmtAgeClient(ms){
  if (!ms) return '—';
  var s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function renderAgeLabel(value){
  var ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) && ms > 0 ? fmtAgeClient(ms) : '';
}
function renderAgeTitle(value){
  var ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '';
}
function pauseHomeMedia(){
  document.querySelectorAll('video,audio').forEach(function(el){
    try { el.pause(); } catch(_){}
  });
}
document.addEventListener('play', function(ev){
  var active = ev.target;
  if(!active || (active.tagName !== 'VIDEO' && active.tagName !== 'AUDIO')) return;
  document.querySelectorAll('video,audio').forEach(function(el){
    if(el !== active && !el.paused){ try { el.pause(); } catch(_){} }
  });
}, true);
async function showProject(slug){
  document.getElementById('view-list').hidden = true;
  try {
    var v2r = await fetch('/api/project-v2/' + encodeURIComponent(slug));
    if (!v2r.ok) { showList(); return; }
    var v2 = await v2r.json();
    var projectView = document.getElementById('view-project-v2');
    if(projectView.dataset.slug !== slug){
      ['v2-analyze-progress','v2-describe-progress','v2-match-progress'].forEach(function(id){
        var el = document.getElementById(id);
        if(el){ el.innerHTML = ''; el.hidden = true; }
      });
    }
    projectView.hidden = false;
    projectView.dataset.slug = slug;
    renderProjectV2(v2);
    window.scrollTo({top:0});
  } catch(_){ showList(); }
}
function fmtSize(b){
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(2) + ' GB';
}
function shellQuotePath(p){
  return "'" + String(p || '').replace(/'/g, "'\\\\''") + "'";
}
function encodePathSegments(p){
  return String(p || '').split('/').map(encodeURIComponent).join('/');
}
function showList(){
  document.getElementById('view-list').hidden = false;
  document.getElementById('view-project-v2').hidden = true;
}
function routeFromHash(){
  var h = window.location.hash || '';
  var m = h.match(/^#\\/project\\/(.+)$/);
  if (m) showProject(decodeURIComponent(m[1]));
  else showList();
}
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

async function getVisualContextIfNeeded(slug){
  if(!currentAiSceneAnalysis()) return '';
  try {
    var r = await fetch('/api/project-visual-context-needed/' + encodeURIComponent(slug));
    if(!r.ok) return '';
    var data = await r.json();
    if(!data.needsContext) return '';
    var result = await openVisualContextModal(data, { reanalyze: false });
    if(result === null) return null;
    if(!(await saveVisualContext(slug, result.visualContext))) return null;
    return result.visualContext;
  } catch(_){
    return '';
  }
}

function currentAiSceneAnalysis(){
  var el = document.getElementById('v2-ai-scene-analysis');
  return !!(el && el.checked);
}

async function getAnalyzeRunOptions(slug, reanalyze){
  var aiSceneAnalysis = currentAiSceneAnalysis();
  if(!aiSceneAnalysis){
    return {
      forceDescribe: !!reanalyze,
      forceMatch: false,
      forcePlans: !!reanalyze,
      visualContext: '',
      aiSceneAnalysis: false,
    };
  }
  try {
    var url = '/api/project-visual-context-needed/' + encodeURIComponent(slug) + (reanalyze ? '?include_described=1' : '');
    var r = await fetch(url);
    var data = r.ok ? await r.json() : { needsContext: false, videos: [], visualContext: '' };
    if(!reanalyze && !data.needsContext){
      return { forceDescribe: false, forceMatch: false, forcePlans: false, visualContext: '', aiSceneAnalysis: true };
    }
    var result = await openVisualContextModal(data, { reanalyze: reanalyze });
    if(result === null) return null;
    if(result.visualContext && !(await saveVisualContext(slug, result.visualContext))) return null;
    result.aiSceneAnalysis = true;
    return result;
  } catch(_){
    return { forceDescribe: false, forceMatch: false, forcePlans: false, visualContext: '', aiSceneAnalysis: true };
  }
}

async function saveVisualContext(slug, value){
  var save = await fetch('/api/project-visual-context/' + encodeURIComponent(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visualContext: value }),
  });
  var saved = await save.json().catch(function(){ return {}; });
  if(!save.ok){
    alert('Could not save video description: ' + (saved.error || ('HTTP ' + save.status)));
    return false;
  }
  return true;
}

function openVisualContextModal(data, opts){
  return new Promise(function(resolve){
    opts = opts || {};
    var modal = document.getElementById('visual-context-modal');
    var files = document.getElementById('vcm-files');
    var text = document.getElementById('vcm-text');
    var error = document.getElementById('vcm-error');
    var save = document.getElementById('vcm-save');
    var title = document.getElementById('vcm-title');
    var copy = modal ? modal.querySelector('.vcm-copy') : null;
    var label = modal ? modal.querySelector('.vcm-label') : null;
    var options = document.getElementById('vcm-options');
    var forceDescribe = document.getElementById('vcm-force-describe');
    var forceMatch = document.getElementById('vcm-force-match');
    var forcePlans = document.getElementById('vcm-force-plans');
    if(!modal || !text || !save){ resolve(null); return; }
    var needsContext = !!data.needsContext;
    var reasonLabel = {
      no_audio_stream: 'no audio track',
      silent_audio: 'silent audio',
      empty_transcript: 'empty audio',
    };
    if(title) title.textContent = opts.reanalyze ? 'Analyze again' : 'Describe this silent video';
    if(copy){
      copy.textContent = opts.reanalyze
        ? 'Choose which cached work to refresh. Silent videos also need context so visual analysis can create useful moment captions.'
        : 'No usable audio was detected. Add context so the visual analysis can create short moment captions.';
    }
    if(files){
      files.hidden = !needsContext;
      files.innerHTML = (data.videos || []).map(function(v){
        return '<div class="vcm-file"><span>' + escapeHtmlClient(v.filename || '') + '</span><span class="vcm-file-reason">' +
          escapeHtmlClient(reasonLabel[v.reason] || v.reason || 'no usable audio') + '</span></div>';
      }).join('');
    }
    if(options){
      options.hidden = !opts.reanalyze;
      if(forceDescribe) forceDescribe.checked = true;
      if(forceMatch){
        forceMatch.checked = false;
        forceMatch.disabled = !(data.audioCount > 0);
      }
      if(forcePlans) forcePlans.checked = true;
    }
    if(label) label.hidden = !needsContext;
    text.value = data.visualContext || '';
    if(error){ error.hidden = true; error.textContent = ''; }
    modal.hidden = false;
    setTimeout(function(){
      if(needsContext){ text.focus(); text.select(); }
      else if(forceDescribe){ forceDescribe.focus(); }
      else save.focus();
    }, 20);

    function cleanup(){
      modal.querySelectorAll('[data-vcm-cancel]').forEach(function(btn){
        btn.removeEventListener('click', onCancel);
      });
      save.removeEventListener('click', onSave);
      document.removeEventListener('keydown', onKey);
    }
    function close(value){
      cleanup();
      modal.hidden = true;
      resolve(value);
    }
    function onCancel(){ close(null); }
    function onKey(ev){ if(ev.key === 'Escape') close(null); }
    function onSave(){
      var value = (text.value || '').trim();
      if(needsContext && !value){
        if(error){
          error.textContent = 'Add a short description before continuing.';
          error.hidden = false;
        }
        text.focus();
        return;
      }
      close({
        visualContext: value,
        forceDescribe: opts.reanalyze ? !!(forceDescribe && forceDescribe.checked) : false,
        forceMatch: opts.reanalyze ? !!(forceMatch && forceMatch.checked) : false,
        forcePlans: opts.reanalyze ? !!(forcePlans && forcePlans.checked) : false,
      });
    }
    modal.querySelectorAll('[data-vcm-cancel]').forEach(function(btn){
      btn.addEventListener('click', onCancel);
    });
    save.addEventListener('click', onSave);
    document.addEventListener('keydown', onKey);
  });
}

async function postProjectRename(slug, name){
  var r = await fetch('/api/project-rename/' + encodeURIComponent(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name }),
  });
  var data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  if(data.projects) PROJECTS = data.projects;
  return data;
}

async function archiveProjectBySlug(slug){
  var r = await fetch('/api/project-archive/' + encodeURIComponent(slug), { method: 'POST' });
  var data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  if(data.projects) PROJECTS = data.projects;
  return data;
}

async function unarchiveProjectBySlug(slug){
  var r = await fetch('/api/project-unarchive/' + encodeURIComponent(slug), { method: 'POST' });
  var data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  if(data.projects) PROJECTS = data.projects;
  return data;
}

async function startProjectNewVersion(slug){
  var r = await fetch('/api/project-new-version/' + encodeURIComponent(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  var data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  if(data.projects) PROJECTS = data.projects;
  return data;
}

function confirmProjectNewVersion(title){
  return confirm('Start a new version of "' + title + '"?\\n\\nThis creates a separate project with the same source media files only. Existing clips, renders, generated illustrations, and tutorials stay unchanged in the current project.');
}

function startInlineTitleEdit(display, current, onSave, small){
  if(!display || display.dataset.editing === '1') return;
  display.dataset.editing = '1';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = small ? 'v2-vc-title-input' : 'inline-title-input';
  input.value = current || '';
  display.hidden = true;
  display.insertAdjacentElement('afterend', input);
  input.focus();
  input.select();
  var done = false;
  async function finish(save){
    if(done) return;
    done = true;
    var next = input.value.trim();
    input.remove();
    display.hidden = false;
    display.dataset.editing = '';
    if(!save || !next || next === current) return;
    try {
      await onSave(next);
    } catch(e){
      alert('Rename failed: ' + e.message);
    }
  }
  input.addEventListener('keydown', function(ev){
    if(ev.key === 'Enter'){ ev.preventDefault(); finish(true); }
    if(ev.key === 'Escape'){ ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', function(){ finish(true); });
}

// Project card kebab menus on the home grid.
(function(){
  document.addEventListener('click', async function(ev){
    var menuBtn = ev.target.closest && ev.target.closest('.project-menu-btn');
    if(menuBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var tile = menuBtn.closest('.project-tile');
      var pop = tile && tile.querySelector('.project-card-menu');
      var willOpen = pop && pop.hidden;
      document.querySelectorAll('.project-card-menu').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.project-menu-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
      if(pop){
        pop.hidden = !willOpen;
        menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      }
      return;
    }
    var renameBtn = ev.target.closest && ev.target.closest('.project-card-rename');
    if(renameBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var tileR = renameBtn.closest('.project-tile');
      var slugR = tileR.dataset.slug;
      var curR = tileR.dataset.title || '';
      var nextR = window.prompt('Rename project', curR);
      if(nextR === null) return;
      nextR = nextR.trim();
      if(!nextR || nextR === curR) return;
      try {
        await postProjectRename(slugR, nextR);
        window.location.reload();
      } catch(e){ alert('Rename failed: ' + e.message); }
      return;
    }
    var archiveBtn = ev.target.closest && ev.target.closest('.project-card-archive');
    if(archiveBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var tileD = archiveBtn.closest('.project-tile');
      var slugD = tileD.dataset.slug;
      var titleD = tileD.dataset.title || slugD;
      if(!confirm('Archive project "' + titleD + '"?\\n\\nThe project folder will be renamed with a leading underscore and moved to Archived projects. No files are deleted.')) return;
      try {
        await archiveProjectBySlug(slugD);
        window.location.reload();
      } catch(e){ alert('Archive failed: ' + e.message); }
      return;
    }
    var newVersionBtn = ev.target.closest && ev.target.closest('.project-card-new-version');
    if(newVersionBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var tileV = newVersionBtn.closest('.project-tile');
      var slugV = tileV.dataset.slug;
      var titleV = tileV.dataset.title || slugV;
      if(!confirmProjectNewVersion(titleV)) return;
      newVersionBtn.disabled = true;
      try {
        var versionData = await startProjectNewVersion(slugV);
        if(versionData.slug) window.location.hash = '#/project/' + encodeURIComponent(versionData.slug);
        window.location.reload();
      } catch(e){
        alert('Start new version failed: ' + e.message);
        newVersionBtn.disabled = false;
      }
      return;
    }
    var unarchiveBtn = ev.target.closest && ev.target.closest('.project-card-unarchive');
    if(unarchiveBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var tileU = unarchiveBtn.closest('.project-tile');
      var slugU = tileU.dataset.slug;
      try {
        await unarchiveProjectBySlug(slugU);
        window.location.reload();
      } catch(e){ alert('Restore failed: ' + e.message); }
      return;
    }
    if(!(ev.target.closest && ev.target.closest('.project-card-menu'))){
      document.querySelectorAll('.project-card-menu').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.project-menu-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
    }
  });
})();

// New v2 project: multi-file picker first, then suggested project name.
(function(){
  var browse = document.getElementById('new-project-browse');
  var fileEl = document.getElementById('new-project-files');
  var summary = document.getElementById('new-project-files-summary');
  var nameRow = document.getElementById('new-project-name-row');
  var nameInput = document.getElementById('new-project-name-input');
  var autoMatchEl = document.getElementById('new-project-automatch');
  var aiSceneEl = document.getElementById('new-project-ai-scene-analysis');
  var goBtn = document.getElementById('new-project-go');
  var status = document.getElementById('new-project-status');
  if (!browse) return;
  var pickedFiles = [];
  var nameAutoFilled = false; // user-typed names take priority over our suggestions
  function dateShootName(files){
    var stamped = files
      .map(function(f){ return f.lastModified || 0; })
      .filter(function(ms){ return ms > 0; })
      .sort(function(a,b){ return a - b; });
    var d = stamped.length ? new Date(stamped[0]) : new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' shoot';
  }
  function isGenericMediaPrefix(prefix){
    return /^(img|dsc|dji|gh|gopro|gopr|clip|video|mov|mvi|pxl|vid|c\\d*)[_\\-\\s]*\\d*$/i.test(prefix.trim());
  }
  // Derive a project name from the picked filenames. Prefer a useful
  // shared stem, but camera-roll names such as IMG_6980/IMG_6981
  // become a date-based shoot name instead.
  function suggestNameFromFiles(files){
    if (files.length === 0) return '';
    var stems = files.map(function(f){ return f.name.replace(/\\.[^.]+$/, ''); });
    var prefix = stems[0];
    for (var i = 1; i < stems.length && prefix; i++){
      var s = stems[i], k = 0;
      while (k < prefix.length && k < s.length && prefix[k] === s[k]) k++;
      prefix = prefix.slice(0, k);
    }
    prefix = prefix.replace(/[\\s_\\-]+$/, '');
    if (prefix.length >= 3 && !isGenericMediaPrefix(prefix)) return prefix;
    return dateShootName(files);
  }
  function refreshSummary(){
    if(nameRow) nameRow.hidden = pickedFiles.length === 0;
    if (pickedFiles.length === 0){
      summary.textContent = 'No files chosen yet';
      summary.classList.remove('has-file');
    } else {
      var v = pickedFiles.filter(function(f){ return /\\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name); }).length;
      var a = pickedFiles.length - v;
      summary.textContent = pickedFiles.length + ' file' + (pickedFiles.length===1?'':'s') + ' (' + v + ' video' + (v===1?'':'s') + ', ' + a + ' audio)';
      summary.classList.add('has-file');
    }
    goBtn.disabled = pickedFiles.length === 0 || !nameInput.value.trim();
  }
  function maybeAutoFillName(){
    // Only fill if the user hasn't typed something themselves.
    if (nameInput.value && !nameAutoFilled) return;
    var suggestion = suggestNameFromFiles(pickedFiles);
    if (suggestion){
      nameInput.value = suggestion;
      nameAutoFilled = true;
      refreshSummary();
    }
  }
  function revealSuggestedName(){
    if(nameRow) nameRow.hidden = pickedFiles.length === 0;
    if(pickedFiles.length > 0 && nameInput.value){
      setTimeout(function(){
        try { nameInput.focus(); nameInput.select(); } catch(_){}
      }, 0);
    }
  }
  browse.addEventListener('click', function(){ fileEl.click(); });
  fileEl.addEventListener('change', function(){
    pickedFiles = Array.prototype.slice.call(fileEl.files || []);
    maybeAutoFillName();
    refreshSummary();
    revealSuggestedName();
  });
  nameInput.addEventListener('input', function(){
    nameAutoFilled = false; // user is typing — stop auto-overwriting
    refreshSummary();
  });
  // Drag-drop the picker box.
  var picker = document.getElementById('new-project-picker');
  if (picker){
    ['dragenter','dragover'].forEach(function(t){ picker.addEventListener(t, function(e){ e.preventDefault(); picker.classList.add('drag-over'); }); });
    ['dragleave','drop'].forEach(function(t){ picker.addEventListener(t, function(e){ e.preventDefault(); picker.classList.remove('drag-over'); }); });
    picker.addEventListener('drop', function(e){
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      pickedFiles = Array.prototype.slice.call(files);
      maybeAutoFillName();
      refreshSummary();
      revealSuggestedName();
    });
  }

  goBtn.addEventListener('click', async function(){
    if (pickedFiles.length === 0) return;
    var name = nameInput.value.trim();
    if (!name){ status.textContent = 'Give the project a name first.'; return; }
    goBtn.disabled = true; browse.disabled = true; nameInput.disabled = true;
    status.textContent = 'Creating project…';
    try {
      // 1. Create the project.
      var c = await fetch('/api/new-project-v2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          autoMatchAudio: !!autoMatchEl.checked,
          aiSceneAnalysis: !!(aiSceneEl && aiSceneEl.checked),
        }),
      });
      var cdata = await c.json();
      if (!c.ok) throw new Error(cdata.error || 'failed');
      var slug = cdata.slug;
      // 2. Upload each file in turn (sequential keeps progress messages
      //    deterministic and avoids saturating the disk on slow drives).
      for (var i = 0; i < pickedFiles.length; i++){
        var f = pickedFiles[i];
        status.textContent = 'Copying ' + f.name + ' (' + (i+1) + ' of ' + pickedFiles.length + ', ' + fmtSize(f.size) + ')…';
        try {
          // Read into ArrayBuffer first so the browser doesn't try to
          // stream a File object (Safari 'Load failed' on big files).
          var buf = await f.arrayBuffer();
          var u = await fetch('/api/upload-source-multi/' + encodeURIComponent(slug), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name },
            body: buf,
          });
          if (!u.ok){
            var ud = await u.json().catch(function(){ return {}; });
            throw new Error(ud.error || ('HTTP ' + u.status));
          }
        } catch(uploadErr) {
          throw new Error('Couldn\\'t upload ' + f.name + ': ' + uploadErr.message);
        }
      }
      status.textContent = '✓ Project created — opening…';
      var pr = await fetch('/api/projects');
      var pdata = await pr.json();
      PROJECTS = pdata.projects;
      window.location.hash = '#/project/' + encodeURIComponent(slug);
    } catch(e){
      status.textContent = 'Couldn\\'t create: ' + e.message;
      goBtn.disabled = false; browse.disabled = false; nameInput.disabled = false;
    }
  });

})();

function updateWorkflowState(p, state){
  var status = document.getElementById('v2-analyze-status');
  var steps = document.getElementById('v2-workflow-steps');
  if(!status || !steps) return;
  var hasFiles = (p.sourceVideos.length + p.sourceAudios.length) > 0;
  var hasVideos = p.sourceVideos.length > 0;
  var done = {
    files: hasFiles,
    describe: !!state.allDescribed,
    audio: !!state.allVideosReady,
    plans: !!state.plansReady,
  };
  var order = ['files','describe','audio','plans'];
  var active = order.find(function(k){ return !done[k]; }) || 'plans';
  order.forEach(function(k){
    var el = steps.querySelector('[data-step="' + k + '"]');
    if(!el) return;
    el.classList.toggle('done', !!done[k]);
    el.classList.toggle('active', k === active && !done[k]);
  });
  if(status){
    status.hidden = false;
    status.className = 'workflow-status ' + (state.plansReady ? 'done' : 'idle');
    var aiSceneAnalysis = !!(p.meta && p.meta.aiSceneAnalysis);
    var message = '';
    if(!hasVideos) message = 'Add at least one video file.';
    else if(state.plansReady) message = 'Clip plans are ready - click a video below.';
    else if(state.allVideosReady) message = 'Videos are ready for clip planning.';
    else if(state.allDescribed) message = 'Videos are ready for audio setup.';
    else message = 'Ready to start.';
    var actionLabel = state.plansReady ? 'Analyze again' : 'Analyze all videos';
    status.innerHTML =
      '<label class="wf-ai-option">' +
        '<input id="v2-ai-scene-analysis" type="checkbox"' + (aiSceneAnalysis ? ' checked' : '') + '>' +
        '<span><strong>Analyze and suggest scenes with installed AI</strong>' +
        '<small>Uses ChatGPT, Claude, or Ollama from your config. When off, AICW Video uses Whisper audio, local face detection, and face-focused crop hints.</small></span>' +
      '</label>' +
      '<button id="v2-analyze-all-go" class="wf-status-action" type="button" data-reanalyze="' + (state.plansReady ? '1' : '0') + '"' + (!hasVideos ? ' disabled' : '') + '>' +
        escapeHtmlClient(actionLabel) +
      '</button>' +
      '<span class="wf-status-main"><span class="wf-spinner"></span><span class="wf-status-text">' + escapeHtmlClient(message) + '</span></span>';
  }
}

// V2 project view: render source files list and the guided analyze workflow.
function renderProjectV2(p){
  document.getElementById('v2-title').textContent = p.meta.title || p.slug;
  document.getElementById('v2-age').textContent = '';
  var meta = '';
  meta += p.sourceVideos.length + ' video' + (p.sourceVideos.length===1?'':'s');
  meta += ' · ' + p.sourceAudios.length + ' audio file' + (p.sourceAudios.length===1?'':'s');
  if (p.meta.autoMatchAudio) meta += ' · <span style="color:var(--accent)">auto-match enabled</span>';
  if (p.slug && p.slug.charAt(0) === '_') meta += ' · <span style="color:var(--muted)">archived</span>';
  document.getElementById('v2-meta').innerHTML = meta;
  var pathRow = document.getElementById('v2-project-path-row');
  var openCommand = document.getElementById('v2-open-command');
  if(pathRow && openCommand){
    openCommand.textContent = 'open ' + shellQuotePath(p.root || '');
    pathRow.hidden = !p.root;
  }
  var archiveMenu = document.getElementById('proj-archive');
  if(archiveMenu){
    var archived = p.slug && p.slug.charAt(0) === '_';
    var label = archiveMenu.querySelector('.pm-label');
    var hint = archiveMenu.querySelector('.pm-hint');
    if(label) label.textContent = archived ? 'Restore project' : 'Archive project…';
    if(hint) hint.textContent = archived ? 'renames the folder without the leading _' : 'renames the folder with a leading _';
  }
  var allFiles = p.sourceVideos.concat(p.sourceAudios);
  var allDescribed = allFiles.length > 0 && allFiles.every(function(f){ return !!f.description; });
  var allVideosReady = p.sourceVideos.length > 0 && p.videos && p.videos.length >= p.sourceVideos.length;
  var plansReady = allVideosReady && p.videos.every(function(v){ return (v.suggestedClipsCount|0) > 0; });
  updateWorkflowState(p, {
    allDescribed: allDescribed,
    allVideosReady: allVideosReady,
    plansReady: plansReady,
  });
  // File listing
  var filesEl = document.getElementById('v2-files');
  function fileRow(f){
    var described = !!f.description;
    var title = (f.description && f.description.title) ? f.description.title : (described ? '' : 'not described yet');
    return '<div class="v2-file-row' + (described?' described':'') + '">' +
      '<span class="v2-file-name">' + escapeHtmlClient(f.originalName) + '</span>' +
      '<span class="v2-file-title">' + escapeHtmlClient(title) + '</span>' +
      '<span class="v2-file-status">' + (described ? '✓ described' : 'pending') + '</span>' +
      '</div>';
  }
  var html = '';
  if (p.sourceVideos.length > 0){
    html += '<div class="v2-files-group"><h4>Videos</h4>' + p.sourceVideos.map(fileRow).join('') + '</div>';
  }
  if (p.sourceAudios.length > 0){
    html += '<div class="v2-files-group"><h4>Audio recordings</h4>' + p.sourceAudios.map(fileRow).join('') + '</div>';
  }
  if (!html){
    html = '<p class="hint-small">No files yet — go back and add some.</p>';
  }
  filesEl.innerHTML = html;
  // Describe-all action (lives in the project ⋮ menu now).
  var btn = document.getElementById('v2-describe-go');
  var status = document.getElementById('v2-describe-status');
  btn.disabled = (p.sourceVideos.length + p.sourceAudios.length) === 0 || allDescribed;
  var btnLabel = btn.querySelector('.pm-label');
  var btnHint = btn.querySelector('.pm-hint');
  if(btnLabel) btnLabel.textContent = allDescribed ? 'Re-describe video files' : 'Describe all video files';
  if(btnHint) btnHint.textContent = allDescribed ? 'all files already described' : 'transcripts + thumbnails';
  status.textContent = '';
  document.getElementById('v2-describe-progress').hidden = true;
  document.getElementById('v2-describe-progress').innerHTML = '';

  // Match action (also in the ⋮ menu). Enabled once describe completes.
  var matchBtn = document.getElementById('v2-match-go');
  var matchStatus = document.getElementById('v2-match-status');
  var matchLabel = matchBtn.querySelector('.pm-label');
  var matchHint = matchBtn.querySelector('.pm-hint');
  if(matchLabel) matchLabel.textContent = 'Match video with separate audio track';
  if (allDescribed && p.sourceVideos.length > 0){
    matchBtn.disabled = false;
    if (p.videos && p.videos.length > 0){
      if(matchHint) matchHint.textContent = '✓ ' + p.videos.length + ' video' + (p.videos.length===1?'':'s') + ' matched · re-run to redo';
    } else {
      if(matchHint) matchHint.textContent = 'replace each video\\'s audio with its closest recording';
    }
  } else {
    matchBtn.disabled = true;
    if(matchHint) matchHint.textContent = 'describe files first';
  }
  matchStatus.textContent = '';
  document.getElementById('v2-match-progress').hidden = true;
  document.getElementById('v2-match-progress').innerHTML = '';

  // Per-video tiles in a YouTube-style grid. Whole tile is the click target
  // that opens the plan UI; hover swaps the static first-thumbnail for an
  // inline muted preview so the user can scan content at a glance.
  var videosSection = document.getElementById('v2-videos-section');
  var videosList = document.getElementById('v2-videos-list');
  if (p.videos && p.videos.length > 0){
    videosSection.hidden = false;
    videosList.innerHTML = p.videos.map(function(v){
      var src = v.sourceFile;
      var title = (src.description && src.description.title) ? src.description.title : '';
      var firstThumb = (src.description && src.description.thumbnails && src.description.thumbnails[0])
        ? '/v2-source/' + encodeURIComponent(p.slug) + '/_sources/' + encodeURIComponent(src.description.thumbnails[0])
        : '';
      var videoUrl = '/v2-source/' + encodeURIComponent(p.slug) + '/' + encodeURIComponent(v.slug) + '/' + encodeURIComponent(v.videoFileName);
      var thumbInner = firstThumb
        ? '<img loading="lazy" alt="" src="' + firstThumb + '">'
        : '<span class="v2-vc-thumb-fallback">' + escapeHtmlClient((src.originalName||'').slice(0,3).toUpperCase()) + '</span>';
      // Status rows: described, audio match, plan/render counts.
      var rows = [];
      rows.push(v.isDescribed
        ? '<span class="vc-row vc-ok"><span class="vc-dot">✓</span> Described</span>'
        : '<span class="vc-row vc-pending"><span class="vc-dot">○</span> Not described yet</span>');
      if (v.matchedAudio){
        rows.push('<span class="vc-row vc-ok"><span class="vc-dot">✓</span> Matched with audio track: <strong>' + escapeHtmlClient(v.matchedAudio.originalName) + '</strong></span>');
      } else if (v.hasReplacedAudio){
        rows.push('<span class="vc-row vc-ok"><span class="vc-dot">✓</span> Cleaner audio applied</span>');
      } else {
        rows.push('<span class="vc-row vc-muted"><span class="vc-dot">○</span> No audio match</span>');
      }
      var s = (v.suggestedClipsCount|0), r = (v.renderedCount|0);
      if (s > 0 || r > 0){
        var bits = [];
        if (s > 0) bits.push(s + ' suggested clip' + (s===1?'':'s'));
        if (r > 0) bits.push(r + ' rendered');
        rows.push('<span class="vc-row vc-muted"><span class="vc-dot">·</span> ' + bits.join(' · ') + '</span>');
      }
      if ((v.tutorialCount|0) > 0){
        rows.push('<span class="vc-row vc-muted"><span class="vc-dot">·</span> ' + (v.tutorialCount|0) + ' tutorial' + ((v.tutorialCount|0)===1?'':'s') + '</span>');
      }
      var latestTutorialName = v.latestTutorialName || '';
      return '<article class="v2-video-card" data-slug="' + escapeHtmlClient(v.slug) + '" data-video-url="' + escapeHtmlClient(videoUrl) + '" data-latest-tutorial="' + escapeHtmlClient(latestTutorialName) + '" tabindex="0" role="button">' +
        '<div class="v2-vc-thumb">' +
          thumbInner +
          '<video preload="none" muted playsinline></video>' +
          '<span class="v2-vc-play"><span class="v2-vc-play-icon">▶</span></span>' +
        '</div>' +
        '<div class="v2-vc-info">' +
          '<button class="v2-vc-name" type="button" data-video-rename="' + escapeHtmlClient(v.slug) + '" title="Click to rename">' + escapeHtmlClient(title || src.originalName) + '</button>' +
          '<span class="v2-vc-title">' + escapeHtmlClient(src.originalName) + '</span>' +
          '<div class="v2-vc-rows">' + rows.join('') + '</div>' +
          '<span class="v2-vc-launch-status"></span>' +
          '<div class="v2-vc-actions">' +
            '<button class="v2-vc-action v2-vc-create-tutorial" type="button">Export tutorial</button>' +
            '<button class="v2-vc-action v2-vc-open-tutorial" type="button" data-tutorial-name="' + escapeHtmlClient(latestTutorialName) + '"' + (latestTutorialName ? '' : ' hidden') + '>Open folder</button>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  } else {
    videosSection.hidden = true;
  }

  // Project-level rendered clips list. This aggregates every rendered
  // mp4 across all video subprojects so the project page is useful after
  // rendering without opening each plan one by one.
  var rendersSection = document.getElementById('v2-renders-section');
  var rendersList = document.getElementById('v2-renders-list');
  var rendersCount = document.getElementById('v2-renders-count');
  var renders = p.renderedClips || [];
  if(renders.length > 0){
    rendersSection.hidden = false;
    if(rendersCount) rendersCount.textContent = renders.length + ' rendered';
    rendersList.innerHTML = renders.slice(0, 60).map(function(r){
      var rel = encodePathSegments(r.relativePath);
      var url = '/v2-source/' + encodeURIComponent(p.slug) + '/' + rel;
      var poster = '/v2-render-poster/' + encodeURIComponent(p.slug) + '/' + rel;
      var title = r.outputTitle || r.videoTitle || r.file;
      var age = renderAgeLabel(r.createdMs || r.renderedAt);
      var ageTitle = renderAgeTitle(r.createdMs || r.renderedAt);
      var sub = [age || r.stamp || '', r.formatLabel || '', r.videoTitle || r.sourceName || ''].filter(Boolean).join(' · ');
      var sourceUrl = r.videoSlug ? '/p/' + encodeURIComponent(p.slug) + '/' + encodeURIComponent(r.videoSlug) + '/plan.html' : '';
      return '<article class="v2-render-card" data-relative-path="' + escapeHtmlClient(r.relativePath || '') + '" data-render-file="' + escapeHtmlClient(r.file || '') + '">' +
        '<video controls preload="none" poster="' + poster + '" src="' + url + '"></video>' +
        '<div class="v2-render-meta">' +
          '<span class="v2-render-title">' + escapeHtmlClient(title) + '</span>' +
          '<span class="v2-render-sub" title="' + escapeHtmlClient(ageTitle) + '">' + escapeHtmlClient(sub) + '</span>' +
        '</div>' +
        '<div class="v2-render-actions">' +
          (sourceUrl ? '<a href="' + sourceUrl + '">Source</a>' : '') +
          '<a href="' + url + '" target="_blank" rel="noopener">Open</a>' +
          '<a href="' + url + '" download="' + escapeHtmlClient(r.file || 'render.mp4') + '">Download</a>' +
          '<span class="v2-render-menu-wrap">' +
            '<button class="v2-render-menu-btn" type="button" aria-label="Rendered clip actions" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
            '<span class="v2-render-menu" role="menu" hidden><button class="v2-render-delete" type="button" role="menuitem">Delete render...</button></span>' +
          '</span>' +
        '</div>' +
      '</article>';
    }).join('');
  } else {
    rendersSection.hidden = true;
    if(rendersList) rendersList.innerHTML = '';
    if(rendersCount) rendersCount.textContent = '';
  }

  // Orphan audios section.
  var orphansSection = document.getElementById('v2-orphans-section');
  var orphansList = document.getElementById('v2-orphans-list');
  if (p.orphanAudios && p.orphanAudios.length > 0 && p.videos && p.videos.length > 0){
    orphansSection.hidden = false;
    orphansList.innerHTML = p.orphanAudios.map(function(a){
      var title = (a.description && a.description.title) ? a.description.title : '';
      return '<div class="v2-file-row described">' +
        '<span class="v2-file-name">' + escapeHtmlClient(a.originalName) + '</span>' +
        '<span class="v2-file-title">' + escapeHtmlClient(title) + '</span>' +
        '<span class="v2-file-status">no match</span>' +
        '</div>';
    }).join('');
  } else {
    orphansSection.hidden = true;
  }
}

// Project-level rendered clips: kebab menu + confirmed delete.
(function(){
  document.addEventListener('click', async function(ev){
    var menuBtn = ev.target.closest && ev.target.closest('.v2-render-menu-btn');
    if(menuBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var wrap = menuBtn.closest('.v2-render-menu-wrap');
      var pop = wrap && wrap.querySelector('.v2-render-menu');
      var willOpen = pop && pop.hasAttribute('hidden');
      document.querySelectorAll('.v2-render-menu').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.v2-render-menu-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
      if(pop){
        pop.hidden = !willOpen;
        menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      }
      return;
    }

    var deleteBtn = ev.target.closest && ev.target.closest('.v2-render-delete');
    if(deleteBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var card = deleteBtn.closest('.v2-render-card');
      var slug = document.getElementById('view-project-v2').dataset.slug || '';
      var relativePath = card && card.dataset.relativePath || '';
      var file = card && card.dataset.renderFile || 'render.mp4';
      if(!slug || !relativePath) return;
      if(!confirm('Delete rendered clip "' + file + '"? This removes the .mp4 file.')) return;
      pauseHomeMedia();
      deleteBtn.disabled = true;
      try {
        var r = await fetch('/api/delete-render-v2/' + encodeURIComponent(slug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relative_path: relativePath }),
        });
        var data = await r.json().catch(function(){ return {}; });
        if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        if(data.project) renderProjectV2(data.project);
      } catch(e){
        alert('Delete failed: ' + (e && e.message ? e.message : e));
        deleteBtn.disabled = false;
      }
      return;
    }

    if(!ev.target.closest || !ev.target.closest('.v2-render-menu')){
      document.querySelectorAll('.v2-render-menu').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.v2-render-menu-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
    }
  });
})();

// Project page ⋮ dropdown: open/close + outside-click + ESC.
(function(){
  var trigger = document.getElementById('proj-menu-btn');
  var pop = document.getElementById('proj-menu-pop');
  if(!trigger || !pop) return;
  function close(){ pop.hidden = true; trigger.setAttribute('aria-expanded','false'); }
  function open(){ pop.hidden = false; trigger.setAttribute('aria-expanded','true'); }
  trigger.addEventListener('click', function(ev){
    ev.stopPropagation();
    if(pop.hidden) open(); else close();
  });
  document.addEventListener('click', function(ev){
    if(pop.hidden) return;
    if(!pop.contains(ev.target) && ev.target !== trigger) close();
  });
  document.addEventListener('keydown', function(ev){
    if(ev.key === 'Escape' && !pop.hidden) close();
  });
  // Close after picking any menu item (the action's own handler runs first).
  pop.addEventListener('click', function(ev){
    var btn = ev.target.closest && ev.target.closest('button[role="menuitem"]');
    if(btn) close();
  });
  // "Show source files" → expand the existing details panel.
  var showFiles = document.getElementById('proj-show-files');
  if(showFiles) showFiles.addEventListener('click', function(){
    var det = document.getElementById('v2-files-section');
    if(det){ det.open = true; det.scrollIntoView({behavior:'smooth', block:'start'}); }
  });
  var copyOpen = document.getElementById('v2-copy-open-command');
  if(copyOpen) copyOpen.addEventListener('click', async function(){
    var cmd = document.getElementById('v2-open-command');
    if(!cmd) return;
    var was = copyOpen.textContent;
    try {
      await navigator.clipboard.writeText(cmd.textContent || '');
      copyOpen.textContent = 'Copied';
      setTimeout(function(){ copyOpen.textContent = was; }, 1400);
    } catch(e){
      copyOpen.textContent = 'Copy failed';
      setTimeout(function(){ copyOpen.textContent = was; }, 1400);
    }
  });
  var renameProjectBtn = document.getElementById('proj-rename');
  if(renameProjectBtn) renameProjectBtn.addEventListener('click', function(){
    var titleEl = document.getElementById('v2-title');
    startInlineTitleEdit(titleEl, titleEl.textContent.trim(), async function(next){
      var slug = document.getElementById('view-project-v2').dataset.slug;
      var data = await postProjectRename(slug, next);
      if(data.slug && data.slug !== slug){
        window.location.hash = '#/project/' + encodeURIComponent(data.slug);
      } else if(data.project) {
        renderProjectV2(data.project);
      }
    });
  });
  var newVersionProjectBtn = document.getElementById('proj-new-version');
  if(newVersionProjectBtn) newVersionProjectBtn.addEventListener('click', async function(){
    var slug = document.getElementById('view-project-v2').dataset.slug;
    var title = document.getElementById('v2-title').textContent.trim() || slug;
    if(!confirmProjectNewVersion(title)) return;
    newVersionProjectBtn.disabled = true;
    try {
      var data = await startProjectNewVersion(slug);
      if(data.slug) window.location.hash = '#/project/' + encodeURIComponent(data.slug);
      else if(data.project) renderProjectV2(data.project);
    } catch(e){
      alert('Start new version failed: ' + e.message);
    } finally {
      newVersionProjectBtn.disabled = false;
    }
  });
  var archiveProjectBtn = document.getElementById('proj-archive');
  if(archiveProjectBtn) archiveProjectBtn.addEventListener('click', async function(){
    var slug = document.getElementById('view-project-v2').dataset.slug;
    var title = document.getElementById('v2-title').textContent.trim() || slug;
    var archived = slug && slug.charAt(0) === '_';
    if(archived){
      try {
        var restored = await unarchiveProjectBySlug(slug);
        if(restored.slug && restored.slug !== slug) window.location.hash = '#/project/' + encodeURIComponent(restored.slug);
        window.location.reload();
      } catch(e){
        alert('Restore failed: ' + e.message);
      }
      return;
    }
    if(!confirm('Archive project "' + title + '"?\\n\\nThe project folder will be renamed with a leading underscore and moved to Archived projects. No files are deleted.')) return;
    try {
      var archivedData = await archiveProjectBySlug(slug);
      if(archivedData.slug && archivedData.slug !== slug) window.location.hash = '#/project/' + encodeURIComponent(archivedData.slug);
      window.location.reload();
    } catch(e){
      alert('Archive failed: ' + e.message);
    }
  });
  var projectTitle = document.getElementById('v2-title');
  if(projectTitle){
    function editProjectTitle(){
      startInlineTitleEdit(projectTitle, projectTitle.textContent.trim(), async function(next){
        var slug = document.getElementById('view-project-v2').dataset.slug;
        var data = await postProjectRename(slug, next);
        if(data.slug && data.slug !== slug){
          window.location.hash = '#/project/' + encodeURIComponent(data.slug);
        } else if(data.project) {
          renderProjectV2(data.project);
        }
      });
    }
    projectTitle.addEventListener('click', editProjectTitle);
    projectTitle.addEventListener('keydown', function(ev){
      if(ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        editProjectTitle();
      }
    });
  }
  // "Add files…" → open the hidden file input. On change, upload each
  // file via the existing /api/upload-source-multi/<slug> endpoint,
  // then refresh the project view + reset the input.
  var addBtn = document.getElementById('proj-add-files');
  var addInput = document.getElementById('proj-add-files-input');
  if(addBtn && addInput){
    addBtn.addEventListener('click', function(){ addInput.click(); });
    addInput.addEventListener('change', async function(){
      var files = Array.prototype.slice.call(addInput.files || []);
      if(files.length === 0) return;
      var slug = document.getElementById('view-project-v2').dataset.slug;
      var status = document.getElementById('v2-describe-status');
      if(status){ status.hidden = false; status.textContent = 'Uploading 0/' + files.length + '…'; }
      for(var i = 0; i < files.length; i++){
        var f = files[i];
        if(status) status.textContent = 'Uploading ' + (i+1) + '/' + files.length + ' (' + f.name + ')…';
        try {
          var buf = await f.arrayBuffer();
          var u = await fetch('/api/upload-source-multi/' + encodeURIComponent(slug), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name },
            body: buf,
          });
          if(!u.ok){
            var d = await u.json().catch(function(){ return {}; });
            throw new Error(d.error || 'HTTP ' + u.status);
          }
        } catch(e){
          if(status) status.textContent = 'Upload failed: ' + e.message;
          addInput.value = '';
          return;
        }
      }
      if(status) status.textContent = '✓ ' + files.length + ' file' + (files.length===1?'':'s') + ' added — refreshing…';
      addInput.value = '';
      // Reload project state so the new files appear in the listing
      // (and Describe/Match menu items unlock as needed).
      try {
        var v2r = await fetch('/api/project-v2/' + encodeURIComponent(slug));
        if(v2r.ok) renderProjectV2(await v2r.json());
      } catch(_){}
    });
  }
})();

// Primary project workflow: describe sources, set up audio/video folders,
// and pre-build each video's clip plan UI.
(function(){
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest && ev.target.closest('#v2-analyze-all-go');
    if(!btn) return;
    ev.preventDefault();
    if(btn.disabled) return;
    var slug = document.getElementById('view-project-v2').dataset.slug;
    var status = document.getElementById('v2-analyze-status');
    var progress = document.getElementById('v2-analyze-progress');
    var steps = document.getElementById('v2-workflow-steps');
    var runOpts = await getAnalyzeRunOptions(slug, btn.dataset.reanalyze === '1');
    if(runOpts === null) return;
    btn.disabled = true;
    function setAnalyzeStatus(text, detail, mode){
      if(!status) return;
      status.hidden = false;
      status.className = 'workflow-status ' + (mode || 'running');
      status.innerHTML =
        '<span class="wf-status-main"><span class="wf-spinner"></span>' +
        '<span class="wf-status-text">' + escapeHtmlClient(text || '') + '</span>' +
        (detail ? '<span class="wf-status-detail">' + escapeHtmlClient(detail) + '</span>' : '') +
        '</span>';
    }
    setAnalyzeStatus('Starting analysis…', 'Preparing source files and cached work');
    progress.innerHTML = '';
    progress.hidden = false;
    function appendLine(text, cls){
      var div = document.createElement('div');
      div.className = 'pr-line' + (cls?' '+cls:'');
      div.textContent = text;
      progress.appendChild(div);
      progress.scrollTop = progress.scrollHeight;
    }
    function setPhase(phase){
      var map = { preflight: 'files', describe: 'describe', audio: 'audio', materialise: 'audio', plans: 'plans' };
      var key = map[phase] || phase;
      if(!steps) return;
      ['files','describe','audio','plans'].forEach(function(k){
        var el = steps.querySelector('[data-step="' + k + '"]');
        if(!el) return;
        el.classList.toggle('active', k === key);
        if((key === 'describe' && k === 'files') ||
           (key === 'audio' && (k === 'files' || k === 'describe')) ||
           (key === 'plans' && (k === 'files' || k === 'describe' || k === 'audio'))){
          el.classList.add('done');
        }
      });
    }
    function describeLine(ev){
      if (ev.type === 'start') {
        appendLine('Describing ' + ev.total + ' files…');
        setAnalyzeStatus('Analyzing sources…', ev.total + ' file' + (ev.total===1?'':'s') + ' queued');
      }
      else if (ev.type === 'file-start') {
        appendLine('  ' + ev.kind + ': ' + ev.filename + ' — ' + (ev.stage || ''));
        setAnalyzeStatus('Analyzing ' + ev.filename + '…', ev.stage || '');
      }
      else if (ev.type === 'file-progress') {
        appendLine('    ' + (ev.stage || ''));
        setAnalyzeStatus('Analyzing ' + ev.filename + '…', ev.stage || '');
      }
      else if (ev.type === 'file-done') appendLine('    ✓ ' + ev.filename + (ev.title ? ' — "' + ev.title + '"' : ''), 'pr-done');
      else if (ev.type === 'file-skip') appendLine('    skipped ' + ev.filename + ' (' + ev.reason + ')');
      else if (ev.type === 'done') {
        appendLine('Descriptions ready: ' + ev.describedAudios + ' audio + ' + ev.describedVideos + ' video.', 'pr-done');
        setAnalyzeStatus('Source analysis complete', ev.describedAudios + ' audio + ' + ev.describedVideos + ' video ready', 'done');
      }
      else if (ev.type === 'error') {
        appendLine('Error: ' + ev.message, 'pr-error');
        setAnalyzeStatus('Analysis error', ev.message, 'error');
      }
    }
    function aiPreflightLine(ev){
      var results = Array.isArray(ev.results) ? ev.results : [];
      if(results.length === 0){
        appendLine('AI preflight: no configured AI CLI tools');
        return;
      }
      var ready = results.filter(function(r){ return r && r.ok; });
      results.forEach(function(r){
        var label = (r && r.label) || 'AI CLI';
        var suffix = r && r.supportsImages ? ' (images)' : '';
        if(r && r.ok) appendLine('  ✓ ' + label + suffix + ' ready', 'pr-done');
        else appendLine('  warning: ' + label + suffix + ' failed preflight — ' + ((r && r.error) || 'unknown error'), 'pr-error');
      });
      if(ready.length > 0){
        appendLine('AI fallback chain ready: ' + ready.map(function(r){ return r.label; }).join(' → '), 'pr-done');
        setAnalyzeStatus('AI tools ready', ready.map(function(r){ return r.label; }).join(' → '), 'done');
      } else {
        appendLine('AI preflight did not find a working CLI; analysis will use local fallbacks where possible.', 'pr-error');
        setAnalyzeStatus('AI tools unavailable', 'Fix CLI auth/session setup for visual descriptions and proofreading', 'error');
      }
    }
    function matchLine(ev){
      if (ev.type === 'start') appendLine('Matching ' + ev.videoCount + ' videos against ' + ev.audioCount + ' audio recordings…');
      else if (ev.type === 'matching') appendLine('  ' + ev.videoFile + ' — finding best audio…');
      else if (ev.type === 'matched') appendLine('    matched with ' + ev.audioFile + ' (' + ev.score + ' shared words)', 'pr-done');
      else if (ev.type === 'no-match') appendLine('    no clear audio match — keeping the video\\'s original audio');
      else if (ev.type === 'materialising') appendLine('    setting up working folder…');
      else if (ev.type === 'replacing') appendLine('    aligning external audio with the video…');
      else if (ev.type === 'applied') appendLine('    ✓ cleaner audio applied (offset ' + (ev.offsetMs/1000).toFixed(2) + 's)', 'pr-done');
      else if (ev.type === 'skipped') appendLine('    skipped: ' + ev.reason);
      else if (ev.type === 'error') appendLine('    error: ' + ev.message, 'pr-error');
      else if (ev.type === 'done') appendLine('Audio setup ready. Updated ' + ev.replaced + ' video' + (ev.replaced===1?'':'s') + '.', 'pr-done');
    }
    try {
      var qs = [];
      if(runOpts.forceDescribe) qs.push('force_describe=1');
      if(runOpts.forceMatch) qs.push('force_match=1');
      if(runOpts.forcePlans) qs.push('force_plans=1');
      qs.push('ai_scene_analysis=' + (runOpts.aiSceneAnalysis ? '1' : '0'));
      var r = await fetch('/api/analyze-project-stream/' + encodeURIComponent(slug) + (qs.length ? ('?' + qs.join('&')) : ''));
      if(!r.ok || !r.body) throw new Error('failed to start analysis');
      var reader = r.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      while(true){
        var read = await reader.read();
        if(read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for(var i = 0; i < lines.length; i++){
          var line = lines[i].trim();
          if(!line) continue;
          var ev; try { ev = JSON.parse(line); } catch(_){ continue; }
          if(ev.type === 'phase'){
            setPhase(ev.phase);
            appendLine(ev.label + '…');
            setAnalyzeStatus(ev.label + '…', 'Workflow phase: ' + ev.phase);
          } else if(ev.type === 'ai-preflight') {
            aiPreflightLine(ev);
          } else if(ev.type === 'local-analysis') {
            appendLine(ev.message || 'Using local analysis only.', 'pr-done');
            setAnalyzeStatus('Local analysis enabled', 'Whisper audio, local faces, and crop hints', 'done');
          } else if(ev.type === 'describe') {
            describeLine(ev.event || {});
          } else if(ev.type === 'match') {
            matchLine(ev.event || {});
          } else if(ev.type === 'materialise-start') {
            appendLine('  ' + ev.videoFile + ' — setting up working folder…');
            setAnalyzeStatus('Preparing video workspace…', ev.videoFile);
          } else if(ev.type === 'materialise-done') {
            appendLine('    ✓ ' + ev.videoFile + ' ready', 'pr-done');
          } else if(ev.type === 'plan-start') {
            appendLine('  ' + ev.videoFile + ' — preparing clips…');
            setAnalyzeStatus('Preparing clip plan…', ev.videoFile);
          } else if(ev.type === 'plan-done') {
            appendLine('    ✓ clip plan ready for ' + ev.videoFile, 'pr-done');
          } else if(ev.type === 'plan-error') {
            appendLine('    error preparing ' + ev.videoFile + ': ' + ev.message, 'pr-error');
            setAnalyzeStatus('Clip plan error', ev.message, 'error');
          } else if(ev.type === 'done') {
            appendLine('Done. ' + ev.prepared + ' video plan' + (ev.prepared===1?'':'s') + ' ready.', 'pr-done');
            setAnalyzeStatus('Analysis finished', ev.prepared + ' video plan' + (ev.prepared===1?'':'s') + ' ready', 'done');
          } else if(ev.type === 'error') {
            appendLine('Error: ' + ev.message, 'pr-error');
            setAnalyzeStatus('Analysis error', ev.message, 'error');
          }
        }
      }
      setAnalyzeStatus('Analysis finished', 'Refreshing project view…', 'done');
      var v2r = await fetch('/api/project-v2/' + encodeURIComponent(slug));
      if(v2r.ok) renderProjectV2(await v2r.json());
    } catch(e){
      setAnalyzeStatus('Analysis failed', e.message, 'error');
      btn.disabled = false;
    }
  });
})();

// Hook the v2 Describe-all button (delegated, attaches once on page load).
(function(){
  var btn = document.getElementById('v2-describe-go');
  if (!btn) return;
  btn.addEventListener('click', async function(){
    var slug = document.getElementById('view-project-v2').dataset.slug;
    var status = document.getElementById('v2-describe-status');
    var progress = document.getElementById('v2-describe-progress');
    var aiSceneAnalysis = currentAiSceneAnalysis();
    var visualContext = aiSceneAnalysis ? await getVisualContextIfNeeded(slug) : '';
    if(visualContext === null) return;
    btn.disabled = true;
    status.hidden = false; status.textContent = 'Working…';
    progress.innerHTML = '';
    progress.hidden = false;
    function appendLine(text, cls){
      var div = document.createElement('div');
      div.className = 'pr-line' + (cls?' '+cls:'');
      div.textContent = text;
      progress.appendChild(div);
      progress.scrollTop = progress.scrollHeight;
    }
    try {
      var r = await fetch('/api/describe-stream/' + encodeURIComponent(slug) + '?ai_scene_analysis=' + (aiSceneAnalysis ? '1' : '0'));
      if (!r.ok || !r.body) throw new Error('failed to start describe');
      var reader = r.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      while (true){
        var read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++){
          var line = lines[i].trim();
          if (!line) continue;
          var ev;
          try { ev = JSON.parse(line); } catch(_){ continue; }
          if (ev.type === 'start') appendLine('Describing ' + ev.total + ' files…');
          else if (ev.type === 'local-analysis') appendLine(ev.message || 'Using local analysis only.', 'pr-done');
          else if (ev.type === 'ai-preflight') {
            var results = Array.isArray(ev.results) ? ev.results : [];
            results.forEach(function(r){
              if(r && r.ok) appendLine('AI ready: ' + r.label, 'pr-done');
              else appendLine('AI warning: ' + ((r && r.label) || 'AI CLI') + ' failed preflight — ' + ((r && r.error) || 'unknown error'), 'pr-error');
            });
          }
          else if (ev.type === 'file-start') appendLine('  ' + ev.kind + ': ' + ev.filename + ' — ' + (ev.stage || ''));
          else if (ev.type === 'file-progress') appendLine('    ' + (ev.stage || ''));
          else if (ev.type === 'file-done') appendLine('    ✓ ' + ev.filename + (ev.title ? ' — "' + ev.title + '"' : ''), 'pr-done');
          else if (ev.type === 'file-skip') appendLine('    skipped ' + ev.filename + ' (' + ev.reason + ')');
          else if (ev.type === 'done') appendLine('Done: ' + ev.describedAudios + ' audio + ' + ev.describedVideos + ' video described.', 'pr-done');
          else if (ev.type === 'error') appendLine('Error: ' + ev.message, 'pr-error');
        }
      }
      status.textContent = '✓ Description finished — refreshing…';
      // Reload the v2 view with fresh data.
      var v2r = await fetch('/api/project-v2/' + encodeURIComponent(slug));
      if (v2r.ok) renderProjectV2(await v2r.json());
    } catch(e){
      status.textContent = 'Failed: ' + e.message;
      btn.disabled = false;
    }
  });
})();

// V2 auto-match-and-replace button (NDJSON-streamed progress).
(function(){
  var btn = document.getElementById('v2-match-go');
  if (!btn) return;
  btn.addEventListener('click', async function(){
    var slug = document.getElementById('view-project-v2').dataset.slug;
    var status = document.getElementById('v2-match-status');
    var progress = document.getElementById('v2-match-progress');
    // Decide whether to ask for re-match: count already-matched
    // videos. If >0 we offer "Re-match every video" (force=true).
    // OK = unmatched only, Cancel = abort.
    var force = false;
    try {
      var pr = await fetch('/api/project-v2/' + encodeURIComponent(slug));
      var p = pr.ok ? await pr.json() : null;
      var alreadyMatched = (p && p.videos || []).filter(function(v){ return !!v.matchedAudio; }).length;
      if (alreadyMatched > 0){
        var choice = window.prompt(
          alreadyMatched + ' video' + (alreadyMatched===1?'':'s') + ' already matched.\\n\\n' +
          'Type:\\n  • "1" → match only the unmatched videos (skip matched)\\n  • "2" → re-match every video from scratch\\n\\n' +
          'Cancel to abort.',
          '1'
        );
        if (choice === null) return; // user cancelled
        if (String(choice).trim() === '2') force = true;
      }
    } catch(_){ /* offline — fall through, run with no force */ }
    btn.disabled = true;
    status.hidden = false; status.textContent = force ? 'Re-matching every video…' : 'Working…';
    progress.innerHTML = '';
    progress.hidden = false;
    function appendLine(text, cls){
      var div = document.createElement('div');
      div.className = 'pr-line' + (cls?' '+cls:'');
      div.textContent = text;
      progress.appendChild(div);
      progress.scrollTop = progress.scrollHeight;
    }
    try {
      var url = '/api/auto-match-stream/' + encodeURIComponent(slug) + (force ? '?force=1' : '');
      var r = await fetch(url);
      if (!r.ok || !r.body) throw new Error('failed to start');
      var reader = r.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      while (true){
        var read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++){
          var line = lines[i].trim();
          if (!line) continue;
          var ev;
          try { ev = JSON.parse(line); } catch(_){ continue; }
          if (ev.type === 'start') appendLine('Matching ' + ev.videoCount + ' videos against ' + ev.audioCount + ' audio recordings…');
          else if (ev.type === 'matching') appendLine('  ' + ev.videoFile + ' — finding best audio…');
          else if (ev.type === 'matched') appendLine('    matched with ' + ev.audioFile + ' (' + ev.score + ' shared words)', 'pr-done');
          else if (ev.type === 'no-match') appendLine('    no clear audio match — keeping the video\\'s original audio');
          else if (ev.type === 'materialising') appendLine('    setting up working folder…');
          else if (ev.type === 'replacing') appendLine('    aligning external audio with the video…');
          else if (ev.type === 'applied') appendLine('    ✓ cleaner audio applied (offset ' + (ev.offsetMs/1000).toFixed(2) + 's, "' + (ev.matchedPhrase || '') + '")', 'pr-done');
          else if (ev.type === 'skipped') appendLine('    skipped: ' + ev.reason);
          else if (ev.type === 'error') appendLine('    error: ' + ev.message, 'pr-error');
          else if (ev.type === 'done') {
            appendLine('Done. Cleaned up ' + ev.replaced + ' video' + (ev.replaced===1?'':'s') + '.' + (ev.orphans.length ? ' Unmatched audio: ' + ev.orphans.join(', ') : ''), 'pr-done');
          }
        }
      }
      status.textContent = '✓ Setup finished — refreshing…';
      var v2r = await fetch('/api/project-v2/' + encodeURIComponent(slug));
      if (v2r.ok) renderProjectV2(await v2r.json());
    } catch(e){
      status.textContent = 'Failed: ' + e.message;
      btn.disabled = false;
    }
  });
})();

// V2 video tile: whole tile launches the plan UI; hover swaps in a muted
// inline preview so the user can scan content at a glance.
(function(){
  var listEl = document.getElementById('v2-videos-list');
  if (!listEl) return;

  async function launchPlan(card){
    var status = card.querySelector('.v2-vc-launch-status');
    var thumb = card.querySelector('.v2-vc-thumb');
    var projectSlug = document.getElementById('view-project-v2').dataset.slug;
    var videoSlug = card.dataset.slug;
    if (card.dataset.busy === '1') return;
    card.dataset.busy = '1';
    card.classList.add('busy');
    if (status) status.textContent = '';
    // Inject a spinner overlay on the thumb. Removed on error / unload.
    if (thumb && !thumb.querySelector('.v2-vc-spinner')){
      var sp = document.createElement('div');
      sp.className = 'v2-vc-spinner';
      sp.innerHTML = '<div class="v2-vc-spinner-ring"></div><div class="v2-vc-spinner-label">Opening plan…</div>';
      thumb.appendChild(sp);
    }
    try {
      var r = await fetch('/api/launch-plan-v2/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(videoSlug), { method: 'POST' });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      window.location.href = data.url;
    } catch(e){
      if (status) status.textContent = 'Failed: ' + e.message;
      card.classList.remove('busy');
      var spx = thumb && thumb.querySelector('.v2-vc-spinner');
      if (spx) spx.remove();
      card.dataset.busy = '';
    }
  }

  async function createTutorial(card, btn){
    if (card.dataset.tutorialBusy === '1') return;
    var status = card.querySelector('.v2-vc-launch-status');
    var openBtn = card.querySelector('.v2-vc-open-tutorial');
    var projectSlug = document.getElementById('view-project-v2').dataset.slug;
    var videoSlug = card.dataset.slug;
    card.dataset.tutorialBusy = '1';
    btn.disabled = true;
    if (status) status.textContent = 'Exporting tutorial...';
    try {
      var r = await fetch('/api/create-tutorial-v2/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(videoSlug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      var data = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      card.dataset.latestTutorial = data.tutorialName || '';
      if (openBtn && data.tutorialName){
        openBtn.hidden = false;
        openBtn.dataset.tutorialName = data.tutorialName;
      }
      if (status) status.textContent = 'Tutorial ready' + (data.stepCount ? ' · ' + data.stepCount + ' steps' : '');
    } catch(e){
      if (status) status.textContent = 'Failed: ' + e.message;
    } finally {
      btn.disabled = false;
      card.dataset.tutorialBusy = '';
    }
  }

  async function openTutorialFolder(card, btn){
    var status = card.querySelector('.v2-vc-launch-status');
    var projectSlug = document.getElementById('view-project-v2').dataset.slug;
    var videoSlug = card.dataset.slug;
    var tutorialName = btn.dataset.tutorialName || card.dataset.latestTutorial || '';
    if (!tutorialName){
      if (status) status.textContent = 'Export a tutorial first';
      return;
    }
    btn.disabled = true;
    if (status) status.textContent = 'Opening folder...';
    try {
      var r = await fetch('/api/open-tutorial-v2/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(videoSlug) + '/' + encodeURIComponent(tutorialName), {
        method: 'POST',
      });
      var data = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      if (status) status.textContent = data.ok === false ? (data.error || data.path || 'Folder is ready') : 'Opened folder';
    } catch(e){
      if (status) status.textContent = 'Failed: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  listEl.addEventListener('click', function(ev){
    var createBtn = ev.target.closest && ev.target.closest('.v2-vc-create-tutorial');
    if(createBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var createCard = createBtn.closest('.v2-video-card');
      if (createCard) createTutorial(createCard, createBtn);
      return;
    }
    var openBtn = ev.target.closest && ev.target.closest('.v2-vc-open-tutorial');
    if(openBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var openCard = openBtn.closest('.v2-video-card');
      if (openCard) openTutorialFolder(openCard, openBtn);
      return;
    }
    var rename = ev.target.closest && ev.target.closest('.v2-vc-name');
    if(rename){
      ev.preventDefault();
      ev.stopPropagation();
      var titleButton = rename;
      var cardForRename = titleButton.closest('.v2-video-card');
      var current = titleButton.textContent.trim();
      startInlineTitleEdit(titleButton, current, async function(next){
        var projectSlug = document.getElementById('view-project-v2').dataset.slug;
        var videoSlug = cardForRename.dataset.slug;
        var r = await fetch('/api/project-video-rename/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(videoSlug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next }),
        });
        var data = await r.json().catch(function(){ return {}; });
        if(!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        if(data.project) renderProjectV2(data.project);
      }, true);
      return;
    }
    var card = ev.target.closest && ev.target.closest('.v2-video-card');
    if (!card) return;
    launchPlan(card);
  });
  listEl.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.target.closest && ev.target.closest('.v2-vc-action')) return;
    if (ev.target.closest && ev.target.closest('.v2-vc-name')) return;
    var card = ev.target.closest && ev.target.closest('.v2-video-card');
    if (!card) return;
    ev.preventDefault();
    launchPlan(card);
  });

  // Hover-preview: swap in a muted <video> on mouseenter, pause on leave.
  listEl.addEventListener('mouseover', function(ev){
    var card = ev.target.closest && ev.target.closest('.v2-video-card');
    if (!card) return;
    var thumb = card.querySelector('.v2-vc-thumb');
    var v = thumb && thumb.querySelector('video');
    if (!v) return;
    if (!v.getAttribute('src')) v.setAttribute('src', card.dataset.videoUrl || '');
    thumb.classList.add('preview-on');
    v.currentTime = 0;
    v.play().catch(function(){});
  });
  listEl.addEventListener('mouseout', function(ev){
    var card = ev.target.closest && ev.target.closest('.v2-video-card');
    if (!card) return;
    if (card.contains(ev.relatedTarget)) return;
    var thumb = card.querySelector('.v2-vc-thumb');
    var v = thumb && thumb.querySelector('video');
    if (v) { try { v.pause(); } catch(_){} }
    if (thumb) thumb.classList.remove('preview-on');
  });
})();


// Match audio: folder-level auto-pairing.
var maGo = document.getElementById('match-audio-go');
if (maGo){
  maGo.addEventListener('click', async function(){
    var folder = document.getElementById('match-audio-folder').value.trim();
    var status = document.getElementById('match-audio-status');
    var results = document.getElementById('match-audio-results');
    if (!folder){ status.textContent = 'enter a folder path first'; return; }
    maGo.disabled = true;
    status.textContent = 'transcribing each file (cached on disk after first run)…';
    results.innerHTML = '';
    try {
      var r = await fetch('/api/match-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder }),
      });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      status.textContent = 'paired ' + data.videos.filter(function(v){return v.best;}).length + ' of ' + data.videos.length + ' videos';
      var rows = data.videos.map(function(v){
        if (v.best) {
          return '<div class="ma-row"><span class="ma-video">' + escapeHtmlClient(v.videoName) + '</span> <span class="ma-arrow">→</span> <span class="ma-audio"><strong>' + escapeHtmlClient(v.best.audioName) + '</strong></span> <span class="ma-score">' + v.best.totalMatchedWords + 'w · ' + v.best.anchorCount + ' anchors</span></div>';
        }
        var t = (v.allScores || [])[0];
        return '<div class="ma-row ma-no-match"><span class="ma-video">' + escapeHtmlClient(v.videoName) + '</span> <span class="ma-arrow">→</span> <span class="ma-audio">no clear match</span> <span class="ma-score">top: ' + escapeHtmlClient(t ? t.audioName : '-') + ' ' + (t ? t.totalMatchedWords : 0) + 'w</span></div>';
      }).join('');
      if (data.unpairedAudios && data.unpairedAudios.length > 0){
        rows += '<div class="ma-row"><span class="hint-small">Unpaired audio: ' + data.unpairedAudios.map(escapeHtmlClient).join(', ') + '</span></div>';
      }
      results.innerHTML = rows;
    } catch(e){
      status.textContent = 'error: ' + e.message;
    } finally { maGo.disabled = false; }
  });
}
function escapeHtmlClient(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
</script>

</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}") as T;
}

async function deleteProjectRenderedClip(projectPath: string, relativePath: string): Promise<void> {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new Error("bad render path");
  }
  const parts = relativePath.split("/");
  if (parts.length !== 4) throw new Error("bad render path");
  const [videoSlug, shortsSegment, renderDirName, fileName] = parts;
  if (!isSafePathSegment(videoSlug) || shortsSegment !== "shorts") throw new Error("bad render path");
  if (!/^render-\d{8}-\d{6}$/.test(renderDirName)) throw new Error("bad render dir");
  if (!/^[A-Za-z0-9._\-\[\]]+\.mp4$/i.test(fileName)) throw new Error("bad render file");

  const root = path.resolve(projectPath);
  const renderDir = path.resolve(path.join(root, videoSlug, "shorts", renderDirName));
  const target = path.resolve(path.join(renderDir, fileName));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("forbidden");
  if (!existsSync(target)) throw new Error("render not found");

  await rm(target, { force: true });
  await rm(target.replace(/\.mp4$/i, ".json"), { force: true });
  await rm(path.join(renderDir, "_posters", fileName.replace(/\.mp4$/i, ".jpg")), { force: true });
  try {
    const postersLeft = await readdir(path.join(renderDir, "_posters"));
    if (postersLeft.length === 0) await rm(path.join(renderDir, "_posters"), { recursive: true, force: true });
  } catch { /* no poster cache */ }

  const remaining = await readdir(renderDir).catch(() => []);
  if (remaining.length === 0) {
    await rm(renderDir, { recursive: true, force: true });
    const latest = path.join(root, videoSlug, "shorts", "latest");
    try {
      const targetPath = await readlink(latest);
      if (path.basename(targetPath) === renderDirName) await rm(latest, { force: true });
    } catch { /* best effort */ }
  }
}

async function createProjectVersionFromSources(
  projectPath: string,
  requestedName?: string,
): Promise<{ slug: string; path: string; title: string; sourceCount: number }> {
  const project = await loadProjectV2(projectPath);
  if (!project) throw new Error("not a v2 project");
  const sourceFiles = [...project.sourceVideos, ...project.sourceAudios];
  if (sourceFiles.length === 0) throw new Error("project has no source files to copy");

  const title = requestedName?.trim() || await nextProjectVersionTitle(project.meta.title || project.slug);
  const slug = uniqueSlugIn(projectsRoot(), projectNameToSlug(title));
  const nextRoot = await initProjectV2(slug, {
    title,
    autoMatchAudio: project.meta.autoMatchAudio,
    aiSceneAnalysis: project.meta.aiSceneAnalysis === true,
  });

  if (project.meta.visualContext?.trim()) {
    const nextMeta = await readProjectMeta(nextRoot);
    if (nextMeta) {
      nextMeta.visualContext = project.meta.visualContext.trim();
      await writeProjectMeta(nextRoot, nextMeta);
    }
  }

  for (const source of sourceFiles) {
    const dst = await sourceFileTarget(nextRoot, source.originalName);
    await copyFile(source.sourcePath, dst);
  }

  return { slug, path: nextRoot, title, sourceCount: sourceFiles.length };
}

async function nextProjectVersionTitle(currentTitle: string): Promise<string> {
  const base = stripProjectVersionSuffix(currentTitle || "Project");
  let maxVersion = 1;
  let entries: Dirent[] = [];
  try {
    entries = await readdir(projectsRoot(), { withFileTypes: true });
  } catch {
    return `${base} (version 2)`;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readProjectMeta(path.join(projectsRoot(), entry.name));
    if (!meta) continue;
    if (stripProjectVersionSuffix(meta.title).toLowerCase() !== base.toLowerCase()) continue;
    maxVersion = Math.max(maxVersion, projectTitleVersion(meta.title));
  }
  return `${base} (version ${maxVersion + 1})`;
}

function stripProjectVersionSuffix(title: string): string {
  const stripped = String(title || "").replace(/\s+\(version\s+\d+\)\s*$/i, "").trim();
  return stripped || "Project";
}

function projectTitleVersion(title: string): number {
  const match = String(title || "").match(/\s+\(version\s+(\d+)\)\s*$/i);
  const n = match ? Math.round(Number(match[1])) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isSafePathSegment(segment: string): boolean {
  return !!segment && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\");
}

function projectPathForSlug(slug: string): string | null {
  if (!isSafePathSegment(slug)) return null;
  const root = path.resolve(projectsRoot());
  const target = path.resolve(path.join(root, slug));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function updateProjectMetaTitle(projectPath: string, title: string): Promise<void> {
  const meta = await readProjectMeta(projectPath);
  if (!meta) return;
  meta.title = title;
  meta.updatedAt = new Date().toISOString();
  await writeProjectMeta(projectPath, meta);
}

async function updateProjectVisualContext(projectPath: string, visualContext: string): Promise<void> {
  const meta = await readProjectMeta(projectPath);
  if (!meta) throw new Error("not a v2 project");
  meta.visualContext = visualContext;
  meta.updatedAt = new Date().toISOString();
  await writeProjectMeta(projectPath, meta);
}

async function updateProjectAiSceneAnalysis(projectPath: string, enabled: boolean): Promise<void> {
  const meta = await readProjectMeta(projectPath);
  if (!meta) throw new Error("not a v2 project");
  meta.aiSceneAnalysis = enabled;
  meta.updatedAt = new Date().toISOString();
  await writeProjectMeta(projectPath, meta);
}

async function refreshVideoSubprojectDescription(videoRoot: string, source: SourceFile): Promise<void> {
  const descSource = sourceDescriptionPath(source.sourcePath);
  if (!existsSync(descSource)) return;
  const desc = JSON.parse(await readFile(descSource, "utf-8")) as SourceDescription;
  await writeFile(path.join(videoRoot, "video.json"), JSON.stringify(desc, null, 2));
}

async function resetVideoDerivedCaches(
  videoRoot: string,
  opts: { forcePlans?: boolean },
): Promise<void> {
  for (const rel of ["transcript.json", "analysis/moments.json"]) {
    try { await rm(path.join(videoRoot, rel), { force: true }); } catch { /* best effort */ }
  }
  if (opts.forcePlans) {
    for (const rel of ["shorts/suggestions.json", "shorts/plan.json"]) {
      try { await rm(path.join(videoRoot, rel), { force: true }); } catch { /* best effort */ }
    }
  }
}

function inferPriorVisualContext(videos: SourceFile[]): string {
  for (const video of videos) {
    const explicit = video.description?.visualContext?.trim();
    if (explicit) return explicit;
  }

  const repeated = new Map<string, number>();
  for (const video of videos) {
    for (const m of video.description?.moments ?? []) {
      const text = cleanupContextCandidate(m.original_text || m.text || "");
      if (text.length < 40) continue;
      repeated.set(text, (repeated.get(text) || 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [text, count] of repeated) {
    if (count > bestCount || (count === bestCount && text.length > best.length)) {
      best = text;
      bestCount = count;
    }
  }
  if (bestCount >= 2) return best;

  for (const video of videos) {
    const summary = cleanupContextCandidate(video.description?.summary || "");
    if (summary) return summary;
  }
  return "";
}

function cleanupContextCandidate(text: string): string {
  return String(text)
    .replace(/\s+/g, " ")
    .trim();
}

async function visualContextForRequest(projectPath: string, u: URL): Promise<string | undefined> {
  const fromQuery = (u.searchParams.get("visual_context") ?? "").trim();
  if (fromQuery) {
    await updateProjectVisualContext(projectPath, fromQuery);
    return fromQuery;
  }
  return (await readProjectMeta(projectPath))?.visualContext?.trim() || undefined;
}

async function aiSceneAnalysisForRequest(projectPath: string, u: URL): Promise<boolean> {
  const raw = (u.searchParams.get("ai_scene_analysis") ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true") {
    await updateProjectAiSceneAnalysis(projectPath, true);
    return true;
  }
  if (raw === "0" || raw === "false") {
    await updateProjectAiSceneAnalysis(projectPath, false);
    return false;
  }
  return (await readProjectMeta(projectPath))?.aiSceneAnalysis === true;
}

async function readProjectMeta(projectPath: string): Promise<ProjectMeta | null> {
  const metaPath = path.join(projectPath, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return null;
  let meta: ProjectMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8")) as ProjectMeta;
  } catch {
    return null;
  }
  return meta.version === 2 ? meta : null;
}

async function writeProjectMeta(projectPath: string, meta: ProjectMeta): Promise<void> {
  const metaPath = path.join(projectPath, PROJECT_META_FILE);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function dropPlanDirCache(planDirs: Map<string, string>, projectSlug: string): void {
  for (const key of Array.from(planDirs.keys())) {
    if (key === projectSlug || key.startsWith(`${projectSlug}/`)) planDirs.delete(key);
  }
}

async function cleanupKnownRenderSessions(): Promise<void> {
  try {
    const projects = await scanProjects();
    for (const p of projects) {
      const project = await loadProjectV2(p.path);
      if (!project) continue;
      for (const video of project.videos) {
        await cleanupExpiredRenderSessions(video.root);
      }
    }
  } catch {
    // Best-effort startup cleanup only. Rendering also runs cleanup before
    // creating each new tmp session, so failure here should not block the hub.
  }
}

type Res = ServerResponse<IncomingMessage>;

function json(res: Res, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function streamRequestToFile(req: IncomingMessage, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(target);
    req.pipe(ws);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
    req.on("error", reject);
  });
}

async function listBackups(dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  if (!existsSync(dir)) return [];
  try {
    const names = await readdir(dir);
    const out: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const s = statSync(full);
        if (s.isFile()) out.push({ name, size: s.size, mtimeMs: s.mtimeMs });
      } catch { /* skip */ }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch {
    return [];
  }
}

function streamFile(filePath: string, req: IncomingMessage, res: Res): void {
  if (!existsSync(filePath)) {
    text(res, 404, "not found");
    return;
  }
  const sz = statSync(filePath).size;
  const lower = filePath.toLowerCase();
  const ct = lower.endsWith(".mp4") || lower.endsWith(".m4v") || lower.endsWith(".mov")
    ? "video/mp4"
    : lower.endsWith(".webm")
      ? "video/webm"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : lower.endsWith(".png")
          ? "image/png"
          : lower.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
  const range = req.headers.range;
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
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { "Content-Type": ct, "Content-Length": String(sz), "Accept-Ranges": "bytes" });
  createReadStream(filePath).pipe(res);
}

function text(res: Res, code: number, body: string): void {
  res.writeHead(code, { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}

async function listen(server: Server, preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 20; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          reject(e);
        };
        const onListening = (): void => {
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
