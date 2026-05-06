import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * If `filePath` already exists on disk, copy it to
 * `<parent>/_backup/<stem>-<YYYYMMDD-HHMMSS><ext>`.
 *
 * Creates the `_backup/` directory if needed.
 * Returns the backup path if a copy was made, or `null` if the file
 * didn't exist (nothing to back up).
 */
export async function backupIfExists(filePath: string): Promise<string | null> {
  try {
    await stat(filePath);
  } catch {
    // File doesn't exist — nothing to back up.
    return null;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const backupDir = path.join(dir, "_backup");
  await mkdir(backupDir, { recursive: true });

  const now = new Date();
  const ts = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const backupPath = path.join(backupDir, `${stem}-${ts}${ext}`);
  await copyFile(filePath, backupPath);
  return backupPath;
}
