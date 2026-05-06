import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import sharp from "sharp";
import type { NormalizedVisualRegion, VisualMomentMetadata } from "./project-v2.js";

export type LocalFaceDetection = {
  ts_ms: number;
  visual_metadata?: VisualMomentMetadata;
};

type HumanModule = {
  Human?: new (config?: Record<string, unknown>) => HumanInstance;
  default?: new (config?: Record<string, unknown>) => HumanInstance;
};

type HumanInstance = {
  tf: {
    tensor3d(data: Uint8Array, shape: [number, number, number], dtype: "int32"): unknown;
    dispose(value: unknown): void;
  };
  init(): Promise<void>;
  detect(input: unknown): Promise<{
    error?: string | null;
    face?: Array<{ score?: number; boxScore?: number; boxRaw?: [number, number, number, number] }>;
  }>;
};

let detectorPromise: Promise<HumanInstance | null> | null = null;
let fileFetchPatched = false;

export async function detectLocalFacesInThumbnails(
  thumbs: Array<{ ts_ms: number; path: string }>,
): Promise<LocalFaceDetection[]> {
  if (thumbs.length === 0) return [];
  const detector = await getDetector();
  if (!detector) return [];

  const detections: LocalFaceDetection[] = [];
  for (const thumb of thumbs) {
    const metadata = await detectFacesInImage(detector, thumb.path);
    detections.push({ ts_ms: thumb.ts_ms, visual_metadata: metadata });
  }
  return detections;
}

async function getDetector(): Promise<HumanInstance | null> {
  detectorPromise ??= createDetector();
  return detectorPromise;
}

async function createDetector(): Promise<HumanInstance | null> {
  try {
    patchFileFetch();
    const require = createRequire(import.meta.url);
    const humanMain = require.resolve("@vladmandic/human");
    const humanDistDir = path.dirname(humanMain);
    const humanWasmPath = path.join(humanDistDir, "human.node-wasm.js");
    const wasmPackageDir = path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm/package.json"));
    const wasmPath = path.join(wasmPackageDir, "dist") + path.sep;
    const modelBasePath = pathToFileURL(path.resolve(humanDistDir, "../models")).href + "/";
    const mod = await import(pathToFileURL(humanWasmPath).href) as HumanModule;
    const Human = mod.Human ?? mod.default;
    if (!Human) return null;
    const human = new Human({
      backend: "wasm",
      wasmPath,
      modelBasePath,
      debug: false,
      warmup: "none",
      async: false,
      cacheModels: false,
      cacheSensitivity: 0,
      filter: { enabled: false },
      face: {
        enabled: true,
        detector: {
          maxDetected: 12,
          minConfidence: 0.15,
          minSize: 16,
          rotation: false,
        },
        mesh: { enabled: false },
        iris: { enabled: false },
        emotion: { enabled: false },
        description: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    });
    await human.init();
    return human;
  } catch {
    return null;
  }
}

function patchFileFetch(): void {
  if (fileFetchPatched || typeof globalThis.fetch !== "function") return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (raw.startsWith("file://") || raw.startsWith("/")) {
      const filePath = raw.startsWith("file://") ? fileURLToPath(raw) : raw;
      const data = await readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          "content-type": filePath.endsWith(".json") ? "application/json" : "application/octet-stream",
        },
      });
    }
    return nativeFetch(input, init);
  };
  fileFetchPatched = true;
}

async function detectFacesInImage(detector: HumanInstance, imagePath: string): Promise<VisualMomentMetadata | undefined> {
  let tensor: unknown | null = null;
  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .toColorspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width <= 0 || info.height <= 0 || info.channels !== 3) return undefined;
    tensor = detector.tf.tensor3d(data, [info.height, info.width, info.channels], "int32");
    const result = await detector.detect(tensor);
    const faces = (result.face ?? [])
      .map((face) => regionFromBox(face.boxRaw, face.boxScore ?? face.score))
      .filter((face): face is NormalizedVisualRegion => !!face);
    if (faces.length === 0) return undefined;
    return metadataFromFaces(faces);
  } catch {
    return undefined;
  } finally {
    if (tensor) {
      try { detector.tf.dispose(tensor); } catch { /* ignore tensor cleanup failures */ }
    }
  }
}

function regionFromBox(
  box: [number, number, number, number] | undefined,
  confidence: number | undefined,
): NormalizedVisualRegion | undefined {
  if (!box) return undefined;
  const [x, y, width, height] = box;
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  if (width <= 0.01 || height <= 0.01) return undefined;
  const nx = clamp01(x);
  const ny = clamp01(y);
  const nw = Math.min(clamp01(width), 1 - nx);
  const nh = Math.min(clamp01(height), 1 - ny);
  if (nw <= 0.01 || nh <= 0.01) return undefined;
  const region: NormalizedVisualRegion = {
    x: nx,
    y: ny,
    width: nw,
    height: nh,
    label: "face",
    type: "face",
  };
  if (typeof confidence === "number" && Number.isFinite(confidence)) region.confidence = clamp01(confidence);
  return region;
}

function metadataFromFaces(faces: NormalizedVisualRegion[]): VisualMomentMetadata {
  const focus = focusRegionFromFaces(faces);
  return {
    main_focus: focus,
    faces,
    text_regions: [],
    crop_regions: focus ? cropRegionsFromFocus(focus) : [],
    privacy_risks: faces.map((face) => ({
      ...face,
      type: "face",
      severity: "high",
      label: "detected face",
    })),
    safe_caption_zones: [],
  };
}

function focusRegionFromFaces(faces: NormalizedVisualRegion[]): NormalizedVisualRegion | null {
  if (faces.length === 0) return null;
  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  for (const face of faces) {
    left = Math.min(left, face.x);
    top = Math.min(top, face.y);
    right = Math.max(right, face.x + face.width);
    bottom = Math.max(bottom, face.y + face.height);
  }
  const marginX = Math.max(0.08, (right - left) * 0.55);
  const marginY = Math.max(0.10, (bottom - top) * 0.75);
  left = clamp01(left - marginX);
  top = clamp01(top - marginY);
  right = clamp01(right + marginX);
  bottom = clamp01(bottom + marginY);
  return {
    x: left,
    y: top,
    width: Math.max(0.02, right - left),
    height: Math.max(0.02, bottom - top),
    confidence: Math.max(...faces.map((face) => face.confidence ?? 0.5)),
    label: faces.length === 1 ? "person face area" : "people face area",
    reason: "local face detector focus area",
  };
}

function cropRegionsFromFocus(focus: NormalizedVisualRegion): NormalizedVisualRegion[] {
  return ["9:16", "1:1", "4:5", "16:9"].map((aspectRatio) => ({
    ...focus,
    aspect_ratio: aspectRatio,
    reason: "keeps locally detected faces in frame",
  }));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
