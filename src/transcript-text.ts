export type TranscriptTextWord = { text: string };

const PUNCT_ONLY_RE = /^[,.;:!?%]+$/;
const CLOSING_RE = /^[)\]}]+$/;
const OPENING_RE = /[(\[{]$/;
const CONTRACTION_RE = /^(?:'s|'re|'ve|'ll|'d|'m|n't)$/i;

export function joinRawTranscriptWords(words: TranscriptTextWord[]): string {
  return words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function joinTranscriptWords(words: TranscriptTextWord[]): string {
  return cleanupTranscriptText(joinRawTranscriptWords(words));
}

export function cleanupTranscriptText(text: string): string {
  const tokens = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let out = "";
  for (const token of tokens) {
    if (!out) {
      out = token;
      continue;
    }
    if (shouldAttach(out, token)) out += token;
    else out += ` ${token}`;
  }
  return out
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/\s+'(s|re|ve|ll|d|t|m)\b/gi, "'$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldAttach(current: string, token: string): boolean {
  if (PUNCT_ONLY_RE.test(token)) return true;
  if (CLOSING_RE.test(token)) return true;
  if (CONTRACTION_RE.test(token)) return true;
  const lastToken = current.match(/(\S+)$/)?.[1] ?? "";
  if (OPENING_RE.test(lastToken)) return true;
  // whisper.cpp can emit BPE fragments as separate segments when we ask
  // for one-token timing. Keep this conservative: glue "V"+"ibe" and
  // "C"+"oding", but do not glue ordinary "A lot" / "I like" phrases.
  if (/^[B-HJ-Z]$/.test(lastToken) && /^[a-z]{2,5}[,.;:!?%)]?$/.test(token)) return true;
  return false;
}

export function firstWordsFromTranscript(text: string, count: number): string {
  const cleaned = cleanupTranscriptText(text);
  return cleaned.split(/\s+/).slice(0, count).join(" ").replace(/[.!?,:;]+$/, "");
}
