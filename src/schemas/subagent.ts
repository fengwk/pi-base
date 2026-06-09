import { Type } from "@sinclair/typebox";

export const subagentSchema = Type.Object({
  name: Type.String({ description: "Registered subagent name from markdown frontmatter `name`." }),
  prompt: Type.String({ description: "Complete task prompt for the subagent. Keep all necessary context in this prompt." }),
  session_id: Type.Optional(Type.String({ description: "Resume an existing subagent session by Pi session id. Omit to create a new child session." })),
});
