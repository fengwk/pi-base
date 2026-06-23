import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_UNDERSTANDING_SKILL_NAME = "image-understanding";

const packageRoot = dirname(fileURLToPath(import.meta.url));
export const IMAGE_UNDERSTANDING_SKILL_DIR = join(packageRoot, "..", "skills", IMAGE_UNDERSTANDING_SKILL_NAME);
const SKILL_MD_PATH = join(IMAGE_UNDERSTANDING_SKILL_DIR, "SKILL.md");

/** Pi model registry uses `input: ("text" | "image")[]`. Missing `input` is treated as text-only for read fallback. */
export function modelSupportsImages(model: { input?: readonly string[] } | undefined | null): boolean {
  if (!model) return true;
  const input = model.input;
  if (!Array.isArray(input)) return false;
  return input.includes("image");
}

function loadSkillMarkdownBody(): string {
  try {
    const raw = readFileSync(SKILL_MD_PATH, "utf8");
    const withoutFrontmatter = raw.replace(/^---[\s\S]*?---\s*/u, "").trim();
    return withoutFrontmatter.replaceAll("<skill-dir>", IMAGE_UNDERSTANDING_SKILL_DIR);
  } catch {
    return [
      "# image-understanding",
      "",
      `Skill directory: ${IMAGE_UNDERSTANDING_SKILL_DIR}`,
      "",
      `${join(IMAGE_UNDERSTANDING_SKILL_DIR, "scripts", "image-understanding-cli")} --prompt "<text>" --image "<path>"`,
    ].join("\n");
  }
}

/** Text-only read result for non-vision models: metadata + inlined skill doc + paths (no skill registration). */
export function buildImageReadDowngradeMessage(rawPath: string, absolutePath: string): string {
  const cli = join(IMAGE_UNDERSTANDING_SKILL_DIR, "scripts", "image-understanding-cli");
  const skillSection = loadSkillMarkdownBody();
  return [
    `path: ${rawPath}`,
    "kind: file",
    "mediaType: image",
    "message: The current model does not support image attachments, so this image was not sent inline.",
    `absolutePath: ${absolutePath}`,
    `skillDir: ${IMAGE_UNDERSTANDING_SKILL_DIR}`,
    `skillDoc: ${join(IMAGE_UNDERSTANDING_SKILL_DIR, "SKILL.md")}`,
    "",
    "Use the **image-understanding** skill below (no separate registration required). Run via bash, for example:",
    `${cli} --prompt "<what you need from the image>" --image "${absolutePath}"`,
    "",
    "---",
    skillSection,
    "---",
    "",
    "You can also use `bash` with `file` or `identify` for basic metadata when full vision is not required.",
  ].join("\n");
}