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
- Line numbers are the ORIGINAL file for `TAG` (fixed for the whole patch). After success, copy the fresh `[path#TAG]` before the next edit.
- Non-overlap: each original line belongs to at most one `SWAP`/`DEL` range. `INS.PRE`/`INS.POST` only outside those ranges, or at a range edge (`INS.PRE` at range start, `INS.POST` at range end).
- Tight ranges only; anchor lines must have been shown in the `read` that minted `TAG`. Indent `+TEXT` as in the file.

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
- WRONG: two `SWAP`/`DEL` ranges that share a line (e.g. `SWAP 7.=10` + `DEL 10`). RIGHT: one `SWAP` for the final block, or disjoint ranges.
- WRONG: reusing a stale `[PATH#OLD]` header after a prior edit changed the file. RIGHT: copy the fresh header from the newest result.

