export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const LEGACY_FILE_MUTATION_TOOL_NAMES = ["edit", "write"] as const;

export type FileMutationToolSelection = "implicit" | "explicit";

function isFileMutationTool(toolName: string): boolean {
  return toolName === APPLY_PATCH_TOOL_NAME
    || LEGACY_FILE_MUTATION_TOOL_NAMES.includes(toolName as typeof LEGACY_FILE_MUTATION_TOOL_NAMES[number]);
}

/** Matches OpenCode's current apply_patch routing policy by model id. */
export function isApplyPatchPreferredModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.trim().toLowerCase();
  return normalized.includes("gpt-")
    && !normalized.includes("oss")
    && !normalized.includes("gpt-4");
}

export function projectFileMutationTools(
  toolNames: readonly string[],
  modelId: string | undefined,
  selection: FileMutationToolSelection,
): string[] {
  const preferApplyPatch = isApplyPatchPreferredModelId(modelId);
  const hasApplyPatch = toolNames.includes(APPLY_PATCH_TOOL_NAME);
  // apply_patch subsumes edit and write. They are mutually exclusive: when
  // apply_patch is present the legacy tools are removed before any projection.
  const effective = hasApplyPatch
    ? toolNames.filter((name) => name !== "edit" && name !== "write")
    : [...toolNames];
  const hasEdit = effective.includes("edit");
  const hasWrite = effective.includes("write");
  if (!hasApplyPatch && !hasEdit && !hasWrite) return effective;

  // apply_patch can Add, Update, and Delete. Replacing only `edit` or only `write`
  // with it would broaden an explicit allowlist or a user's manually reduced tool
  // set. A declared apply_patch already carries the full capability; otherwise both
  // legacy tools must be present before they can be projected to apply_patch.
  const canProjectToApplyPatch = hasApplyPatch || (hasEdit && hasWrite);
  if (preferApplyPatch) {
    if (!canProjectToApplyPatch) return effective;
  } else if (selection === "explicit" || !hasApplyPatch) {
    return effective;
  }

  const projected: string[] = [];
  let insertedFileMutationTools = false;
  for (const toolName of effective) {
    if (!isFileMutationTool(toolName)) {
      projected.push(toolName);
      continue;
    }
    if (insertedFileMutationTools) continue;
    if (preferApplyPatch) projected.push(APPLY_PATCH_TOOL_NAME);
    else projected.push(...LEGACY_FILE_MUTATION_TOOL_NAMES);
    insertedFileMutationTools = true;
  }
  return projected;
}
