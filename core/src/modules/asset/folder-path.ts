/**
 * Folder path rules (24-IMPL-dam-folder-tree). Kept apart from the commands so that commands.ts and
 * folder-commands.ts can both build zod schemas from it without importing each other.
 */
import { z } from "zod";

/** `/`, `/a`, `/a/b` — letters, digits, `_`, `-`, Hangul and spaces per segment */
export const FOLDER_PATH_RE = /^\/([a-zA-Z0-9_\-가-힣 ]+(\/[a-zA-Z0-9_\-가-힣 ]+)*)?$/;

/** A real folder — the root `/` is not one */
export const folderPathSchema = z
  .string()
  .max(400)
  .regex(FOLDER_PATH_RE, "Folder path format: /a/b")
  .refine((p) => p !== "/", "The root folder cannot be created, renamed or deleted")
  .refine((p) => p.split("/").every((seg) => seg === seg.trim()), "Folder names cannot start or end with a space");

/** `/a/b/c` → [`/a`, `/a/b`] */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, i) => `/${segments.slice(0, i + 1).join("/")}`);
}

export function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i <= 0 ? null : path.slice(0, i);
}
