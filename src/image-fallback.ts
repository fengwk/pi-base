import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_UNDERSTANDING_SKILL_NAME = "image-understanding";

const packageRoot = dirname(fileURLToPath(import.meta.url));
export const IMAGE_UNDERSTANDING_SKILL_DIR = join(packageRoot, "..", "skills", IMAGE_UNDERSTANDING_SKILL_NAME);
export const IMAGE_UNDERSTANDING_SKILL_DOC = join(IMAGE_UNDERSTANDING_SKILL_DIR, "SKILL.md");

/** Pi model registry uses `input: ("text" | "image")[]`. Missing `input` is treated as text-only for read fallback. */
export function modelSupportsImages(model: { input?: readonly string[] } | undefined | null): boolean {
  if (!model) return true;
  const input = model.input;
  if (!Array.isArray(input)) return false;
  return input.includes("image");
}

/** Text-only read result for non-vision models: paths + pointer to the skill doc (no inlined SKILL.md). */
export function buildImageReadDowngradeMessage(rawPath: string, absolutePath: string): string {
  return [
    `path: ${rawPath}`,
    "kind: file",
    "mediaType: image",
    "message: The current model does not support image attachments, so this image was not sent inline.",
    `absolutePath: ${absolutePath}`,
    `skill: ${IMAGE_UNDERSTANDING_SKILL_NAME}`,
    `skillDir: ${IMAGE_UNDERSTANDING_SKILL_DIR}`,
    `skillDoc: ${IMAGE_UNDERSTANDING_SKILL_DOC}`,
    "",
    "To understand this image, `read` the skill document above (`skillDoc`) for usage and CLI commands.",
    "For basic file metadata only, you can use `bash` with `file` or `identify`.",
  ].join("\n");
}
