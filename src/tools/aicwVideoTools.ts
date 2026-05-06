import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { autoMatchAndReplace, materialiseVideoSubproject } from "../auto-match.js";
import { describeAllSources } from "../describe-sources.js";
import { HostSamplingUnavailable, sample } from "../host-llm.js";
import { getProvider } from "../llm/index.js";
import { buildPlanUi } from "../plan-builder.js";
import {
  classifyFile,
  initProjectV2,
  loadProjectV2,
  PROJECT_META_FILE,
  projectNameToSlug,
  sourceFileTarget,
  sourceThumbsDir,
  uniqueSlugIn,
  type ProjectMeta,
  type ProjectV2,
  type VideoSubproject,
} from "../project-v2.js";
import { projectsRoot, scanProjects } from "../projectFolder.js";
import {
  PlanSchema,
  RENDER_VARIANTS,
  renderAllShorts,
  renderClipVariants,
  renderShort,
  saveShortsPlan,
  type Plan,
  type RenderVariant,
} from "../shorts.js";
import { startHomeServer, type HomeServerHandle } from "../home-server.js";
import { buildClipTutorial } from "../tutorial-aicw.js";
import { prepareV2VideoForPlanning } from "../v2-plan-prep.js";

let homeHandle: HomeServerHandle | null = null;

const AspectSchema = z.enum([
  "9:16",
  "youtube-shorts",
  "1:1",
  "4:5",
  "linkedin",
  "16:9",
]);

export function registerAicwVideoTools(server: McpServer): void {
  server.tool(
    "list_projects",
    "List AICW Video projects from the configured projects root.",
    {},
    async () => {
      const projects = await scanProjects();
      return jsonText({ root: projectsRoot(), projects });
    },
  );

  server.tool(
    "get_project",
    "Read a current AICW Video project. Pass a project slug from list_projects or an absolute project folder path.",
    { project: z.string() },
    async ({ project }) => {
      const { project: loaded } = await loadProject(project);
      return jsonText(compactProject(loaded));
    },
  );

  server.tool(
    "create_project",
    "Create an AICW Video project from local video/audio files. Files are copied into the project's _sources folder.",
    {
      name: z.string().optional(),
      files: z.array(z.string()).min(1),
      autoMatchAudio: z.boolean().default(true),
      aiSceneAnalysis: z.boolean().default(false),
    },
    async ({ name, files, autoMatchAudio, aiSceneAnalysis }) => {
      const root = projectsRoot();
      await mkdir(root, { recursive: true });
      const title = name?.trim() || defaultProjectTitle(files);
      const slug = uniqueSlugIn(root, projectNameToSlug(title));
      const projectPath = await initProjectV2(slug, { title, autoMatchAudio, aiSceneAnalysis });
      const imported: Array<{ source: string; target: string; kind: "video" | "audio" }> = [];
      const skipped: Array<{ source: string; reason: string }> = [];

      for (const file of files) {
        const source = expandHome(file);
        let fileStat;
        try {
          fileStat = await stat(source);
        } catch {
          skipped.push({ source, reason: "not found" });
          continue;
        }
        if (!fileStat.isFile()) {
          skipped.push({ source, reason: "not a file" });
          continue;
        }
        const kind = classifyFile(path.basename(source));
        if (!kind) {
          skipped.push({ source, reason: "unsupported file type" });
          continue;
        }
        const target = await uniqueSourceFileTarget(projectPath, path.basename(source));
        await copyFile(source, target);
        imported.push({ source, target, kind });
      }

      return jsonText({
        project: { slug, path: projectPath, title },
        imported,
        skipped,
        next: imported.length > 0
          ? "Call analyze_project to describe sources, match audio, and prepare clip plans."
          : "No supported media files were imported.",
      });
    },
  );

  server.tool(
    "describe_project",
    "Describe all project source videos/audio. In MCP mode, visual frame analysis and caption proofreading use the parent host model via MCP sampling instead of spawning a local AI CLI.",
    {
      project: z.string(),
      visualContext: z.string().optional(),
      force: z.boolean().default(false),
      aiSceneAnalysis: z.boolean().default(true),
    },
    async ({ project, visualContext, force, aiSceneAnalysis }) => {
      const { projectPath } = await loadProject(project);
      await updateProjectAiSceneAnalysis(projectPath, aiSceneAnalysis);
      const events: unknown[] = [];
      for await (const event of describeAllSources(projectPath, {
        visualContext,
        force,
        aiSceneAnalysis,
        llmProvider: aiSceneAnalysis ? getProvider(server) : undefined,
        llmLabel: aiSceneAnalysis ? "MCP host model" : undefined,
      })) {
        events.push(event);
      }
      const reloaded = await loadProjectV2(projectPath);
      return jsonText({
        project: reloaded ? compactProject(reloaded) : { path: projectPath },
        events,
      });
    },
  );

  server.tool(
    "prepare_clips",
    "Materialize per-video folders, auto-match external audio when available, create clip suggestions, and build each video's plan UI.",
    {
      project: z.string(),
      forceMatchAudio: z.boolean().default(false),
      forceDescribe: z.boolean().default(false),
    },
    async ({ project, forceMatchAudio, forceDescribe }) => {
      const { projectPath } = await loadProject(project);
      const result = await prepareProjectVideos(projectPath, { forceMatchAudio, forceDescribe });
      return jsonText(result);
    },
  );

  server.tool(
    "analyze_project",
    "Run the normal AICW Video project pipeline. In MCP mode, visual frame analysis and caption proofreading use the parent host model via MCP sampling instead of spawning a local AI CLI.",
    {
      project: z.string(),
      visualContext: z.string().optional(),
      forceDescribe: z.boolean().default(false),
      forceMatchAudio: z.boolean().default(false),
      aiSceneAnalysis: z.boolean().default(true),
    },
    async ({ project, visualContext, forceDescribe, forceMatchAudio, aiSceneAnalysis }) => {
      const { projectPath } = await loadProject(project);
      await updateProjectAiSceneAnalysis(projectPath, aiSceneAnalysis);
      const describeEvents: unknown[] = [];
      for await (const event of describeAllSources(projectPath, {
        visualContext,
        force: forceDescribe,
        aiSceneAnalysis,
        llmProvider: aiSceneAnalysis ? getProvider(server) : undefined,
        llmLabel: aiSceneAnalysis ? "MCP host model" : undefined,
      })) {
        describeEvents.push(event);
      }
      const prepare = await prepareProjectVideos(projectPath, { forceMatchAudio, forceDescribe });
      return jsonText({ describeEvents, prepare });
    },
  );

  server.tool(
    "get_clip_plan",
    "Read shorts/plan.json for a video's clip plan. If the project has one video, video may be omitted.",
    {
      project: z.string(),
      video: z.string().optional(),
    },
    async ({ project, video }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      const plan = await readPlan(loadedVideo.root);
      return jsonText({ project, video: loadedVideo.slug, plan });
    },
  );

  server.tool(
    "save_clip_plan",
    "Validate and save shorts/plan.json for a video's clip plan. If the project has one video, video may be omitted.",
    {
      project: z.string(),
      video: z.string().optional(),
      plan: PlanSchema,
    },
    async ({ project, video, plan }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      const file = await saveShortsPlan(loadedVideo.root, plan);
      return jsonText({ wrote: file, video: loadedVideo.slug, clipCount: plan.clips.length });
    },
  );

  server.tool(
    "build_plan_ui",
    "Build the browser plan UI for a video's current clip plan. If the project has one video, video may be omitted.",
    {
      project: z.string(),
      video: z.string().optional(),
    },
    async ({ project, video }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      const planHtml = await buildPlanUi(loadedVideo.root);
      return jsonText({ video: loadedVideo.slug, planHtml });
    },
  );

  server.tool(
    "review_project",
    "Start or reuse the AICW Video web app and return direct local review links for the project's per-video plan UIs.",
    {
      project: z.string(),
      video: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      openBrowser: z.boolean().default(false),
      includePreviewImages: z.boolean().default(false),
      maxPreviewImages: z.number().int().min(1).max(6).default(3),
    },
    async ({ project, video, port, openBrowser, includePreviewImages, maxPreviewImages }) => {
      const { projectPath } = await loadProject(project);
      const preparedProject = await ensureVideosForReview(projectPath);
      const videos = video ? [pickVideo(preparedProject, video)] : preparedProject.videos;
      if (videos.length === 0) {
        throw new Error(`project has no videos to review: ${projectPath}`);
      }

      const handle = await ensureHomeServer(port);
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      const previewImages: Array<{ video: string; source: string; mimeType: string }> = [];
      const reviewUrls: Array<{
        video: string;
        title: string;
        url: string;
        planHtml: string;
      }> = [];
      for (const v of videos) {
        await prepareV2VideoForPlanning(v.root);
        const planHtml = await buildPlanUi(v.root);
        reviewUrls.push({
          video: v.slug,
          title: v.sourceFile.description?.title || v.sourceFile.originalName,
          url: localUrl(handle.url, `/p/${encodeURIComponent(preparedProject.slug)}/${encodeURIComponent(v.slug)}/plan.html`),
          planHtml,
        });
        if (includePreviewImages && previewImages.length < maxPreviewImages) {
          const preview = await firstPreviewImage(v);
          if (preview) {
            previewImages.push({ video: v.slug, source: preview.source, mimeType: preview.mimeType });
            content.push({ type: "image", data: preview.data, mimeType: preview.mimeType });
          }
        }
      }

      if (openBrowser && process.platform === "darwin") {
        spawn("open", [reviewUrls[0]!.url], { stdio: "ignore", detached: true }).unref();
      }

      content.unshift({
        type: "text",
        text: JSON.stringify({
          homeUrl: handle.url,
          project: {
            slug: preparedProject.slug,
            path: preparedProject.root,
            title: preparedProject.meta.title,
          },
          reviewUrls,
          previewImages,
        }, null, 2),
      });
      return { content };
    },
  );

  server.tool(
    "render_clip",
    "Render one clip from a video's plan. Optional aspects: 9:16, youtube-shorts, 1:1, 4:5, linkedin, 16:9.",
    {
      project: z.string(),
      video: z.string().optional(),
      clipId: z.string(),
      aspects: z.array(AspectSchema).optional(),
    },
    async ({ project, video, clipId, aspects }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      if (!aspects || aspects.length === 0) {
        const file = await renderShort(loadedVideo.root, clipId);
        return jsonText({ video: loadedVideo.slug, files: [file] });
      }

      const events: unknown[] = [];
      const files: string[] = [];
      for await (const event of renderClipVariants(
        loadedVideo.root,
        clipId,
        aspects as Array<RenderVariant["aspect_ratio"]>,
        { updateLatest: true },
      )) {
        events.push(event);
        if (event.type === "variant-done") files.push(event.file);
      }
      return jsonText({ video: loadedVideo.slug, files, events });
    },
  );

  server.tool(
    "render_all_clips",
    "Render every clip in a video's current shorts/plan.json. If the project has one video, video may be omitted.",
    {
      project: z.string(),
      video: z.string().optional(),
      concurrency: z.number().int().min(1).max(12).optional(),
    },
    async ({ project, video, concurrency }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      const files = await renderAllShorts(loadedVideo.root, { concurrency });
      return jsonText({ video: loadedVideo.slug, files });
    },
  );

  server.tool(
    "export_clip_tutorial",
    "Export one clip as a tutorial folder using that clip's captioned moments and frames.",
    {
      project: z.string(),
      video: z.string().optional(),
      clipId: z.string(),
      title: z.string().optional(),
      steps: z.number().int().min(1).max(30).optional(),
      format: z.enum(["html", "md", "both"]).default("both"),
    },
    async ({ project, video, clipId, title, steps, format }) => {
      const { video: loadedVideo } = await loadVideo(project, video);
      const plan = await readPlan(loadedVideo.root);
      const clip = plan.clips.find((c) => c.id === clipId);
      if (!clip) throw new Error(`no clip with id '${clipId}' in ${loadedVideo.root}/shorts/plan.json`);
      const result = await buildClipTutorial(loadedVideo.root, {
        clipId: clip.id,
        title: title?.trim() || clip.title,
        startMs: clip.start_ms,
        endMs: clip.end_ms,
        points: plan.points,
        steps,
        format,
      });
      return jsonText({ video: loadedVideo.slug, clipId, ...result });
    },
  );

  server.tool(
    "open_app",
    "Start or reuse the AICW Video web app and return its local URL. On macOS, openBrowser=true also opens it in the default browser.",
    {
      port: z.number().int().min(1).max(65535).optional(),
      openBrowser: z.boolean().default(false),
    },
    async ({ port, openBrowser }) => {
      const handle = await ensureHomeServer(port);
      if (openBrowser && process.platform === "darwin") {
        spawn("open", [handle.url], { stdio: "ignore", detached: true }).unref();
      }
      return jsonText({ url: handle.url, port: handle.port });
    },
  );

  server.tool(
    "ping_host",
    "Test whether the connected MCP host supports sampling/createMessage. Set includeImage=true to verify image sampling for frame analysis.",
    {
      phrase: z.string().default("hello from AICW Video"),
      includeImage: z.boolean().default(false),
    },
    async ({ phrase, includeImage }) => {
      try {
        const reply = await sample(server, {
          prompt: includeImage
            ? `Reply with one short sentence acknowledging this phrase: "${phrase}", and confirm whether an image block was received.`
            : `Reply with one short sentence acknowledging this phrase: "${phrase}".`,
          images: includeImage ? [{ data: TEST_PNG_BASE64, mimeType: "image/png" }] : undefined,
          maxTokens: 80,
        });
        return text(`host replied: ${reply.trim()}`);
      } catch (e) {
        if (e instanceof HostSamplingUnavailable) {
          return {
            content: [{ type: "text" as const, text: `sampling unavailable: ${e.message}` }],
            isError: true,
          };
        }
        throw e;
      }
    },
  );
}

// 1x1 PNG used only to verify that an MCP host accepts image content in
// sampling/createMessage calls. Actual video analysis sends sampled frames.
const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8kP7wAAAABJRU5ErkJggg==";

async function prepareProjectVideos(
  projectPath: string,
  opts: { forceMatchAudio?: boolean; forceDescribe?: boolean } = {},
): Promise<{
  project: ReturnType<typeof compactProject>;
  events: unknown[];
  plans: Array<{ video: string; planHtml: string }>;
}> {
  let project = await requireProject(projectPath);
  const events: unknown[] = [];

  if (project.meta.autoMatchAudio && project.sourceAudios.length > 0) {
    for await (const event of autoMatchAndReplace(projectPath, { force: opts.forceMatchAudio })) {
      events.push(event);
    }
  } else {
    for (const sourceVideo of project.sourceVideos) {
      events.push({ type: "materialising", videoFile: sourceVideo.originalName });
      await materialiseVideoSubproject(projectPath, sourceVideo, undefined, {
        refreshDescription: opts.forceDescribe,
      });
    }
  }

  project = await requireProject(projectPath);
  const plans: Array<{ video: string; planHtml: string }> = [];
  for (const video of project.videos) {
    await prepareV2VideoForPlanning(video.root);
    const planHtml = await buildPlanUi(video.root);
    plans.push({ video: video.slug, planHtml });
  }

  project = await requireProject(projectPath);
  return { project: compactProject(project), events, plans };
}

async function loadProject(input: string): Promise<{ projectPath: string; project: ProjectV2 }> {
  const projectPath = resolveProjectInput(input);
  return { projectPath, project: await requireProject(projectPath) };
}

async function loadVideo(
  projectInput: string,
  videoInput?: string,
): Promise<{ projectPath: string; project: ProjectV2; video: VideoSubproject }> {
  const loaded = await loadProject(projectInput);
  const video = pickVideo(loaded.project, videoInput);
  return { ...loaded, video };
}

async function requireProject(projectPath: string): Promise<ProjectV2> {
  const project = await loadProjectV2(projectPath);
  if (!project) throw new Error(`not an AICW Video project: ${projectPath}`);
  return project;
}

async function updateProjectAiSceneAnalysis(projectPath: string, enabled: boolean): Promise<void> {
  const metaPath = path.join(projectPath, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as ProjectMeta;
  if (meta.version !== 2) return;
  meta.aiSceneAnalysis = enabled;
  meta.updatedAt = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

async function ensureVideosForReview(projectPath: string): Promise<ProjectV2> {
  let project = await requireProject(projectPath);
  if (project.videos.length > 0) return project;

  for (const sourceVideo of project.sourceVideos) {
    await materialiseVideoSubproject(projectPath, sourceVideo);
  }
  project = await requireProject(projectPath);
  return project;
}

async function ensureHomeServer(port?: number): Promise<HomeServerHandle> {
  if (!homeHandle) homeHandle = await startHomeServer({ port });
  return homeHandle;
}

function pickVideo(project: ProjectV2, input?: string): VideoSubproject {
  if (!input) {
    if (project.videos.length === 1) return project.videos[0]!;
    if (project.videos.length === 0) {
      throw new Error(`project has no prepared videos yet: ${project.root}. Call prepare_clips or analyze_project first.`);
    }
    throw new Error(`project has ${project.videos.length} videos; pass one of: ${project.videos.map((v) => v.slug).join(", ")}`);
  }
  const wanted = input.trim();
  const video = project.videos.find((v) =>
    v.slug === wanted ||
    v.sourceFile.originalName === wanted ||
    v.sourceFile.description?.title === wanted
  );
  if (!video) {
    throw new Error(`video not found: ${wanted}. Available: ${project.videos.map((v) => v.slug).join(", ")}`);
  }
  return video;
}

function resolveProjectInput(input: string): string {
  const trimmed = expandHome(input.trim());
  if (!trimmed) throw new Error("missing project");
  if (isSafeSlug(trimmed)) return path.join(projectsRoot(), trimmed);
  return path.resolve(trimmed);
}

function isSafeSlug(value: string): boolean {
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes(path.sep);
}

async function uniqueSourceFileTarget(projectPath: string, originalName: string): Promise<string> {
  let candidateName = originalName.replace(/[\/\\]/g, "_");
  let target = await sourceFileTarget(projectPath, candidateName);
  if (!existsSync(target)) return target;

  const ext = path.extname(candidateName);
  const stem = path.basename(candidateName, ext);
  let i = 2;
  while (existsSync(target)) {
    candidateName = `${stem}-${i++}${ext}`;
    target = await sourceFileTarget(projectPath, candidateName);
  }
  return target;
}

async function readPlan(videoRoot: string): Promise<Plan> {
  const file = path.join(videoRoot, "shorts", "plan.json");
  if (!existsSync(file)) throw new Error(`no clip plan at ${file}`);
  return PlanSchema.parse(JSON.parse(await readFile(file, "utf-8")));
}

async function firstPreviewImage(
  video: VideoSubproject,
): Promise<{ data: string; mimeType: string; source: string } | null> {
  const dir = sourceThumbsDir(video.sourceFile);
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return null;
  }
  const file = files[0];
  if (!file) return null;
  const source = path.join(dir, file);
  const data = (await readFile(source)).toString("base64");
  const mimeType = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
  return { data, mimeType, source };
}

function localUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname, baseUrl).toString();
}

function compactProject(project: ProjectV2) {
  return {
    slug: project.slug,
    path: project.root,
    title: project.meta.title,
    autoMatchAudio: project.meta.autoMatchAudio,
    aiSceneAnalysis: project.meta.aiSceneAnalysis === true,
    sourceVideos: project.sourceVideos.map((v) => ({
      name: v.originalName,
      slug: v.slug,
      described: Boolean(v.description),
      title: v.description?.title,
      durationMs: v.description?.durationMs,
    })),
    sourceAudios: project.sourceAudios.map((a) => ({
      name: a.originalName,
      slug: a.slug,
      described: Boolean(a.description),
      title: a.description?.title,
      durationMs: a.description?.durationMs,
    })),
    videos: project.videos.map((v) => ({
      slug: v.slug,
      title: v.sourceFile.description?.title || v.sourceFile.originalName,
      root: v.root,
      source: v.sourceFile.originalName,
      matchedAudio: v.matchedAudio?.originalName,
      hasPlan: v.hasPlan,
      suggestedClipsCount: v.suggestedClipsCount,
      renderedCount: v.renderedCount,
      tutorialCount: v.tutorialCount,
      latestTutorialName: v.latestTutorialName,
    })),
    orphanAudios: project.orphanAudios.map((a) => a.originalName),
    renderedClips: project.renderedClips.map((r) => ({
      videoSlug: r.videoSlug,
      file: r.relativePath,
      clipId: r.clipId,
      formatLabel: r.formatLabel,
      renderedAt: r.renderedAt,
    })),
    renderVariants: RENDER_VARIANTS.map((v) => ({
      aspect_ratio: v.aspect_ratio,
      name: v.name,
      size: `${v.w}x${v.h}`,
      for: v.for,
    })),
  };
}

function defaultProjectTitle(files: string[]): string {
  const first = files[0] ? path.basename(files[0], path.extname(files[0])) : "";
  return first.trim() || "AICW Video Project";
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function jsonText(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
