import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FACE_EMOJI, DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM, DEFAULT_FACE_EMOJI_SCALE } from "./constants.js";

export { DEFAULT_FACE_EMOJI };
export { DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM };
export { DEFAULT_FACE_EMOJI_SCALE };

export type FaceEmojiOption = {
  emoji: string;
  label: string;
  file: string;
  scale?: number;
  yOffset?: number;
};

export const FACE_EMOJI_NONE = "none";

export const FACE_EMOJI_OPTIONS: FaceEmojiOption[] = [
  { emoji: "🙂", label: "Smile", file: "smile.png" },
  { emoji: "😀", label: "Grin", file: "grin.png" },
  { emoji: "😂", label: "Laugh", file: "laugh.png" },
  { emoji: "🤣", label: "Laughing", file: "laughing.png" },
  { emoji: "😎", label: "Cool", file: "cool.png" },
  { emoji: "😮", label: "Open mouth", file: "open-mouth.png", scale: 1.08 },
  { emoji: "🤖", label: "Robot", file: "robot.png", scale: 1.06, yOffset: -0.03 },
  { emoji: "🐶", label: "Dog", file: "dog.png", scale: 1.16, yOffset: -0.06 },
  { emoji: "🐱", label: "Cat", file: "cat.png", scale: 1.18, yOffset: -0.07 },
  { emoji: "🐯", label: "Tiger", file: "tiger.png", scale: 1.18, yOffset: -0.07 },
  { emoji: "🤪", label: "Goofy", file: "goofy.png" },
  { emoji: "😜", label: "Wink", file: "wink.png" },
  { emoji: "🥸", label: "Disguise", file: "disguise.png" },
  { emoji: "🤩", label: "Star", file: "star.png" },
];

export function normalizeFaceEmoji(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const exact = FACE_EMOJI_OPTIONS.find((opt) => opt.emoji === text);
  if (exact) return exact.emoji;
  return FACE_EMOJI_OPTIONS.find((opt) => text.includes(opt.emoji))?.emoji ?? DEFAULT_FACE_EMOJI;
}

export function normalizeFaceEmojiSelection(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.toLowerCase() === FACE_EMOJI_NONE) return FACE_EMOJI_NONE;
  return normalizeFaceEmoji(value);
}

export function faceEmojiOption(value: unknown): FaceEmojiOption {
  const emoji = normalizeFaceEmoji(value);
  return FACE_EMOJI_OPTIONS.find((opt) => opt.emoji === emoji) ?? FACE_EMOJI_OPTIONS[0]!;
}

export function faceEmojiAssetUrl(value: unknown): string {
  return `/assets/face-emojis/${faceEmojiOption(value).file}`;
}

export function faceEmojiAssetPath(value: unknown): string {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(runtimeDir, "assets", "face-emojis", faceEmojiOption(value).file);
}

export function faceEmojiPresentation(value: unknown): { scale: number; yOffset: number } {
  const opt = faceEmojiOption(value);
  return {
    scale: Number.isFinite(opt.scale) ? opt.scale! : 1,
    yOffset: Number.isFinite(opt.yOffset) ? opt.yOffset! : 0,
  };
}

export type FaceMouthKind = "speaking";

export function faceMouthAssetFile(kind: FaceMouthKind): string {
  void kind;
  return "mouth-speaking.png";
}

export function faceMouthAssetUrl(kind: FaceMouthKind): string {
  return `/assets/face-emojis/${faceMouthAssetFile(kind)}`;
}

export function faceMouthAssetPath(kind: FaceMouthKind): string {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(runtimeDir, "assets", "face-emojis", faceMouthAssetFile(kind));
}

export function faceMouthPresetSvg(kind: FaceMouthKind): string {
  void kind;
  const shape = `<ellipse cx="256" cy="256" rx="108" ry="150" fill="#fff" stroke="#24272d" stroke-width="34"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${shape}
</svg>`;
}

export function faceEmojiPresetSvg(value: unknown): string {
  const emoji = normalizeFaceEmoji(value);
  const face = `
    <defs>
      <radialGradient id="faceFill" cx="37%" cy="28%" r="73%">
        <stop offset="0%" stop-color="#fff9a8"/>
        <stop offset="42%" stop-color="#ffdf4f"/>
        <stop offset="76%" stop-color="#ffbd33"/>
        <stop offset="100%" stop-color="#ed8e1c"/>
      </radialGradient>
      <radialGradient id="cheek" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f36e4f" stop-opacity=".34"/>
        <stop offset="100%" stop-color="#f36e4f" stop-opacity="0"/>
      </radialGradient>
      <filter id="softShadow" x="-28%" y="-28%" width="156%" height="156%">
        <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".32"/>
      </filter>
      <filter id="innerGlow" x="-18%" y="-18%" width="136%" height="136%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/>
        <feOffset dy="4" result="offset"/>
        <feComposite in="offset" in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="inner"/>
        <feColorMatrix in="inner" type="matrix" values="0 0 0 0 1 0 0 0 0 .47 0 0 0 0 0 0 0 0 .38 0"/>
        <feComposite in2="SourceGraphic" operator="over"/>
      </filter>
    </defs>
    <g filter="url(#softShadow)">
      <circle cx="256" cy="256" r="210" fill="url(#faceFill)" filter="url(#innerGlow)"/>
      <circle cx="168" cy="282" r="54" fill="url(#cheek)"/>
      <circle cx="344" cy="282" r="54" fill="url(#cheek)"/>
    </g>
  `;
  const eyes = `
    <ellipse cx="178" cy="198" rx="27" ry="38" fill="#604017"/>
    <ellipse cx="334" cy="198" rx="27" ry="38" fill="#604017"/>
    <ellipse cx="169" cy="184" rx="7" ry="12" fill="#fff" opacity=".45"/>
    <ellipse cx="325" cy="184" rx="7" ry="12" fill="#fff" opacity=".45"/>
  `;
  const smile = `<path d="M154 300 C194 374 318 374 358 300" fill="none" stroke="#5c3515" stroke-width="28" stroke-linecap="round"/>`;
  const mouthOval = `
    <ellipse cx="256" cy="322" rx="54" ry="72" fill="#5c3515"/>
    <ellipse cx="256" cy="350" rx="32" ry="30" fill="#ff6b8f" opacity=".78"/>
  `;
  const openMouth = `
    <ellipse cx="178" cy="198" rx="27" ry="38" fill="#604017"/>
    <ellipse cx="334" cy="198" rx="27" ry="38" fill="#604017"/>
    ${mouthOval}
  `;
  const grin = `
    <path d="M130 292 C165 400 347 400 382 292 Q256 344 130 292Z" fill="#5c3515"/>
    <path d="M168 302 H344 V334 Q256 364 168 334Z" fill="#fff"/>
  `;
  const tears = `
    <path d="M104 250 C48 290 67 374 134 359 C162 309 145 275 104 250Z" fill="#58c8ff"/>
    <path d="M408 250 C464 290 445 374 378 359 C350 309 367 275 408 250Z" fill="#58c8ff"/>
    <path d="M88 281 C111 286 129 305 132 331" fill="none" stroke="#d8f6ff" stroke-width="8" stroke-linecap="round" opacity=".9"/>
    <path d="M424 281 C401 286 383 305 380 331" fill="none" stroke="#d8f6ff" stroke-width="8" stroke-linecap="round" opacity=".9"/>
  `;
  const sunglasses = `
    <path d="M98 164 H224 Q241 164 243 182 Q245 248 190 256 Q127 263 108 209Z" fill="#17191f"/>
    <path d="M288 164 H414 L404 209 Q385 263 322 256 Q267 248 269 182 Q271 164 288 164Z" fill="#17191f"/>
    <path d="M236 194 H276" stroke="#17191f" stroke-width="20" stroke-linecap="round"/>
    <path d="M148 184 H211" stroke="#707987" stroke-width="9" stroke-linecap="round" opacity=".72"/>
    <path d="M304 184 H367" stroke="#707987" stroke-width="9" stroke-linecap="round" opacity=".72"/>
  `;
  const tongue = `
    <ellipse cx="178" cy="195" rx="31" ry="40" fill="#604017"/>
    <path d="M312 176 C342 150 383 165 394 198" fill="none" stroke="#604017" stroke-width="23" stroke-linecap="round"/>
    <path d="M150 298 C188 378 324 378 362 298 Q256 348 150 298Z" fill="#5c3515"/>
    <path d="M224 326 C230 414 306 414 312 326" fill="#ff5c8a" stroke="#d83b6c" stroke-width="8"/>
    <path d="M268 336 V392" stroke="#d83b6c" stroke-width="6" stroke-linecap="round" opacity=".7"/>
  `;
  const disguise = `
    <circle cx="178" cy="198" r="55" fill="none" stroke="#2f333d" stroke-width="16"/>
    <circle cx="334" cy="198" r="55" fill="none" stroke="#2f333d" stroke-width="16"/>
    <path d="M232 198 H280" stroke="#2f333d" stroke-width="14" stroke-linecap="round"/>
    <path d="M174 290 C214 260 238 262 256 300 C274 262 298 260 338 290" fill="#4b2d1c"/>
    <path d="M190 138 C238 112 280 112 328 138" fill="none" stroke="#4b2d1c" stroke-width="28" stroke-linecap="round"/>
  `;
  const robot = `
    <rect x="104" y="120" width="304" height="284" rx="66" fill="#d9e1ea" stroke="#5d6672" stroke-width="16"/>
    <path d="M256 116 V74" stroke="#5d6672" stroke-width="18" stroke-linecap="round"/>
    <circle cx="256" cy="58" r="20" fill="#ff5c5c"/>
    <circle cx="178" cy="216" r="36" fill="#1d2935"/>
    <circle cx="334" cy="216" r="36" fill="#1d2935"/>
    <circle cx="178" cy="216" r="13" fill="#71e6ff"/>
    <circle cx="334" cy="216" r="13" fill="#71e6ff"/>
    <rect x="174" y="302" width="164" height="44" rx="18" fill="#1d2935"/>
    <path d="M202 324 H310" stroke="#71e6ff" stroke-width="8" stroke-linecap="round" opacity=".78"/>
    <rect x="76" y="210" width="34" height="96" rx="16" fill="#5d6672"/>
    <rect x="402" y="210" width="34" height="96" rx="16" fill="#5d6672"/>
  `;
  const dog = `
    <path d="M122 146 C74 184 62 280 104 362 C142 436 370 436 408 362 C450 280 438 184 390 146 C332 102 180 102 122 146Z" fill="#c08345"/>
    <path d="M132 158 C78 142 36 188 54 258 C70 322 122 312 150 258Z" fill="#71442a"/>
    <path d="M380 158 C434 142 476 188 458 258 C442 322 390 312 362 258Z" fill="#71442a"/>
    <ellipse cx="256" cy="284" rx="88" ry="74" fill="#f0cfa9"/>
    <ellipse cx="178" cy="224" rx="26" ry="34" fill="#3b2418"/>
    <ellipse cx="334" cy="224" rx="26" ry="34" fill="#3b2418"/>
    <path d="M232 270 Q256 292 280 270 Q256 252 232 270Z" fill="#3b2418"/>
    <path d="M256 288 C236 326 204 320 192 300" fill="none" stroke="#3b2418" stroke-width="12" stroke-linecap="round"/>
    <path d="M256 288 C276 326 308 320 320 300" fill="none" stroke="#3b2418" stroke-width="12" stroke-linecap="round"/>
  `;
  const cat = `
    <path d="M104 188 L126 78 L206 136 C238 126 274 126 306 136 L386 78 L408 188 C438 244 424 352 362 400 C310 440 202 440 150 400 C88 352 74 244 104 188Z" fill="#f0b24c"/>
    <path d="M136 156 L148 110 L184 142Z" fill="#f6d0c7"/>
    <path d="M376 156 L364 110 L328 142Z" fill="#f6d0c7"/>
    <ellipse cx="182" cy="238" rx="25" ry="35" fill="#27313a"/>
    <ellipse cx="330" cy="238" rx="25" ry="35" fill="#27313a"/>
    <path d="M236 286 Q256 306 276 286 Q256 270 236 286Z" fill="#5b2d25"/>
    <path d="M256 302 C238 330 210 326 198 310" fill="none" stroke="#5b2d25" stroke-width="10" stroke-linecap="round"/>
    <path d="M256 302 C274 330 302 326 314 310" fill="none" stroke="#5b2d25" stroke-width="10" stroke-linecap="round"/>
    <path d="M118 284 H204 M122 320 H204 M308 284 H394 M308 320 H390" stroke="#5b2d25" stroke-width="9" stroke-linecap="round"/>
  `;
  const tiger = `
    <path d="M104 188 L126 82 L202 138 C236 126 276 126 310 138 L386 82 L408 188 C438 244 424 352 362 400 C310 440 202 440 150 400 C88 352 74 244 104 188Z" fill="#f28b21"/>
    <path d="M136 156 L148 112 L184 142Z" fill="#ffd2b0"/>
    <path d="M376 156 L364 112 L328 142Z" fill="#ffd2b0"/>
    <path d="M164 148 L192 206 M224 128 L232 198 M288 128 L280 198 M348 148 L320 206 M126 240 L188 266 M386 240 L324 266" stroke="#2d2119" stroke-width="16" stroke-linecap="round"/>
    <ellipse cx="184" cy="248" rx="24" ry="34" fill="#2d2119"/>
    <ellipse cx="328" cy="248" rx="24" ry="34" fill="#2d2119"/>
    <ellipse cx="256" cy="310" rx="78" ry="60" fill="#ffd2b0"/>
    <path d="M234 294 Q256 316 278 294 Q256 276 234 294Z" fill="#2d2119"/>
    <path d="M256 312 C238 340 208 336 194 318" fill="none" stroke="#2d2119" stroke-width="11" stroke-linecap="round"/>
    <path d="M256 312 C274 340 304 336 318 318" fill="none" stroke="#2d2119" stroke-width="11" stroke-linecap="round"/>
  `;
  const star = (cx: number, cy: number) =>
    `<polygon points="${cx},142 ${cx + 18},183 ${cx + 62},187 ${cx + 30},216 ${cx + 39},259 ${cx},236 ${cx - 39},259 ${cx - 30},216 ${cx - 62},187 ${cx - 18},183" fill="#5c3515"/>`;

  let features = eyes + smile;
  if (emoji === "😀") features = eyes + grin;
  else if (emoji === "😂" || emoji === "🤣") features = tears + eyes + grin;
  else if (emoji === "😎") features = sunglasses + smile;
  else if (emoji === "😮") features = openMouth;
  else if (emoji === "🤖") return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <filter id="softShadow" x="-28%" y="-28%" width="156%" height="156%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".32"/>
    </filter>
  </defs>
  <g filter="url(#softShadow)">${robot}</g>
</svg>`;
  else if (emoji === "🐶") return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <filter id="softShadow" x="-28%" y="-28%" width="156%" height="156%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".32"/>
    </filter>
  </defs>
  <g filter="url(#softShadow)">${dog}</g>
</svg>`;
  else if (emoji === "🐱") return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <filter id="softShadow" x="-28%" y="-28%" width="156%" height="156%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".32"/>
    </filter>
  </defs>
  <g filter="url(#softShadow)">${cat}</g>
</svg>`;
  else if (emoji === "🐯") return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <filter id="softShadow" x="-28%" y="-28%" width="156%" height="156%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".32"/>
    </filter>
  </defs>
  <g filter="url(#softShadow)">${tiger}</g>
</svg>`;
  else if (emoji === "🤪" || emoji === "😜") features = tongue;
  else if (emoji === "🥸") features = disguise + smile;
  else if (emoji === "🤩") features = star(178, 198) + star(334, 198) + grin;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${face}
  <g filter="url(#softShadow)" opacity=".98">${features}</g>
</svg>`;
}
