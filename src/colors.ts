// Tiny ANSI colour helpers. Disabled when NO_COLOR is set or stdout isn't a TTY.
const enabled = process.env.NO_COLOR == null && Boolean(process.stdout.isTTY);

const ESC = (code: string) => (enabled ? `\x1b[${code}m` : "");

export const c = {
  reset: ESC("0"),
  bold: ESC("1"),
  dim: ESC("90"),
  red: ESC("31"),
  green: ESC("32"),
  yellow: ESC("33"),
  blue: ESC("34"),
  cyan: ESC("36"),
};

export const ok = (s: string): string => `${c.green}✓${c.reset}  ${s}`;
export const bad = (s: string): string => `${c.red}✗${c.reset}  ${s}`;
export const warn = (s: string): string => `${c.yellow}⚠${c.reset}  ${s}`;
export const step = (s: string): string => `${c.blue}→${c.reset}  ${s}`;
export const dim = (s: string): string => `${c.dim}${s}${c.reset}`;
export const bold = (s: string): string => `${c.bold}${s}${c.reset}`;
export const heading = (s: string): string => `${c.bold}${c.cyan}${s}${c.reset}`;
// Solid-color highlight for natural-language prompts the user should paste.
export const promptText = (s: string): string => `${c.bold}${c.yellow}${s}${c.reset}`;
