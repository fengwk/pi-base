import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { taskSchema } from "../schemas/task.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";
import { executeSubagent } from "./runner.js";
import { createTaskTool } from "./task-tool-core.js";

export function registerTaskTool(
  pi: ExtensionAPI,
  options: {
    executor?: typeof executeSubagent;
  } = {},
) {
  const tool = createTaskTool(pi, options.executor ?? executeSubagent, {
    description: loadToolDescription("task"),
    promptSnippet: loadToolPromptSnippet("task"),
    parameters: taskSchema,
  });
  pi.registerTool(tool as any);
  return tool;
}
