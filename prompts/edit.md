Apply an explicit-range hashline patch to one or more existing text files.

Top-level parameters:
- `workdir` (optional): base directory used to resolve relative paths inside section headers. Defaults to the agent's current working directory.
- `input` (required): the complete hashline patch text.

Hashline sections:
- Every file section starts with `[PATH#TAG]`.
- `PATH` is the target file path copied from the latest `read`, `write`, or successful `edit` result.
- `TAG` is the 4-hex snapshot tag from that same result.
- Tags are mandatory. `edit` only updates existing files; use `write` to create new files.
- Use one section per target file. If multiple hunks touch the same file, keep them under the same `[PATH#TAG]` header.

Operations:
- `SWAP N.=M:` — replace original lines `N..M` inclusive with the body rows below.
- `DEL N` / `DEL N.=M` — delete original lines.
- `INS.PRE N:` — insert body rows before original line `N`.
- `INS.POST N:` — insert body rows after original line `N`.
- `INS.HEAD:` — insert body rows at the start of the file.
- `INS.TAIL:` — insert body rows at the end of the file.

Body rows:
- Every body row is `+TEXT`.
- A lone `+` inserts one empty line.
- To insert a literal line beginning with `+`, write `++...`.
- To insert a literal line beginning with `-`, write `+-...`.
- The body is only final file content. Never write bare context rows or unified-diff `-old` rows.

Rules:
- Numbers always refer to the ORIGINAL file that `TAG` names. They never shift as earlier hunks in the same patch apply.
- After every successful `edit` or `write`, copy the fresh `[PATH#TAG]` header from the newest result before issuing another patch.
- `SWAP` / `DEL` ranges must be tight. Cover only lines whose content changes.
- If you touch a line, that exact line must have been displayed by the `read` result that minted `TAG`.
- For insertions adjacent to a replacement, either include the inserted rows inside the `SWAP` body or anchor at the explicit boundary with `INS.PRE start` / `INS.POST end`.
- Indent every `+TEXT` row exactly as it should land in the file.
- Do not use block-level operations. Always read the full target range and state the exact line range yourself.

Canonical examples:

```text
[src/app.ts#A1B2]
SWAP 10.=12:
+function greet(name: string) {
+  return `Hello, ${name}`;
+}
```

```text
[src/app.ts#A1B2]
INS.POST 24:
+const enabled = true;
+log(enabled);
```

```text
[src/app.ts#A1B2]
DEL 48.=50
```

```text
[src/app.ts#A1B2]
INS.PRE 24:
+const enabled = true;
```

```text
[src/app.ts#A1B2]
INS.TAIL:
+export default app;
```

```text
[src/app.ts#A1B2]
SWAP 10.=12:
+function greet(name: string) {
+  return `Hello, ${name}`;
+}
INS.POST 12:
+log("ready");
DEL 40
```

Anti-patterns:
- WRONG: empty `SWAP` body to delete a line. RIGHT: `DEL`.
- WRONG: widened `SWAP` just to insert one line. RIGHT: `INS.PRE` / `INS.POST`.
- WRONG: body rows without a leading `+`. RIGHT: every literal body row is `+TEXT`.
- WRONG: reusing a stale `[PATH#OLD]` header after a prior edit changed the file. RIGHT: copy the fresh header from the newest result.

Critical reminders:
1. Re-ground after every edit: new file state, new tag.
2. Ranges are explicit and tight.
3. The body is final content: only `+TEXT` rows.
