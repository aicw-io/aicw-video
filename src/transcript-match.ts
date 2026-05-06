import type { Word } from "./transcript-cache.js";

export type Anchor = { videoIdx: number; externalIdx: number; length: number };

// Find the longest run of contiguous matching tokens within
// videoWords[vStart..vEnd) that also appears anywhere in
// externalWords[eStart..). Returns indices into the FULL arrays so callers
// don't have to re-base. Capped at 16 video words per search.
export function findMatchInRange(
  videoWords: Word[],
  externalWords: Word[],
  vStart: number,
  vEnd: number,
  eStart: number,
): Anchor | null {
  const cap = Math.min(vEnd, vStart + 16);
  if (vStart >= cap) return null;
  const videoTokens = videoWords.slice(vStart, cap).map((w) => normalise(w.text));
  const externalTokens = externalWords.slice(eStart).map((w) => normalise(w.text));

  let best: Anchor | null = null;
  for (let vOff = 0; vOff < videoTokens.length; vOff++) {
    const remaining = videoTokens.length - vOff;
    if (best && remaining <= best.length) break;
    for (let eOff = 0; eOff < externalTokens.length; eOff++) {
      let len = 0;
      while (
        vOff + len < videoTokens.length &&
        eOff + len < externalTokens.length &&
        videoTokens[vOff + len] === externalTokens[eOff + len] &&
        videoTokens[vOff + len].length > 0
      ) {
        len++;
      }
      if (len >= 3 && (!best || len > best.length)) {
        best = { videoIdx: vStart + vOff, externalIdx: eStart + eOff, length: len };
        if (len === remaining) break;
      }
    }
  }
  return best;
}

// Walk both transcripts looking for every contiguous shared phrase ≥3
// words. Caps at 12 anchors so we stay bounded on long recordings.
export function harvestAnchors(videoWords: Word[], externalWords: Word[]): Anchor[] {
  const found: Anchor[] = [];
  let vCursor = 0;
  let eCursor = 0;
  const MAX = 12;
  while (vCursor < videoWords.length && eCursor < externalWords.length && found.length < MAX) {
    const window = Math.min(videoWords.length, vCursor + 16);
    const m = findMatchInRange(videoWords, externalWords, vCursor, window, eCursor);
    if (!m) {
      vCursor++;
      continue;
    }
    found.push(m);
    vCursor = m.videoIdx + m.length;
    eCursor = m.externalIdx + m.length;
  }
  return found;
}

export function matchPhrase(a: Anchor, videoWords: Word[]): string {
  return videoWords
    .slice(a.videoIdx, a.videoIdx + a.length)
    .map((w) => w.text)
    .join(" ");
}

export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "").trim();
}
