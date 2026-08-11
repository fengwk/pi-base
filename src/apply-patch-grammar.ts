/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025 OpenAI
 * Modified by pi-base contributors in 2026.
 * See LICENSES/Apache-2.0.txt.
 */

/**
 * Freeform grammar for the apply_patch protocol.
 *
 * Base grammar: codex-rs/core/src/tools/handlers/apply_patch.lark
 * The generated subset matches runtime semantics: optional Workdir, empty Add,
 * explicit non-empty @@ hunks, and Move with optional content changes.
 */
export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch workdir? hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

workdir: "*** Workdir: " filename LF

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line*
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF (change_move change? | change)

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context change_line+)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
