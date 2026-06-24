Hashline is an explicit-range patch language.

Every section starts with `[PATH#TAG]`.
- `PATH` is the file path copied from the latest `read`, `write`, or successful `edit` result.
- `TAG` is the 4-hex file snapshot tag from that same result.
- Tags are mandatory. Hashline only edits existing files; create new files with `write`.

Operations:
- `SWAP N.=M:` — replace original lines `N..M` with the `+TEXT` body rows below.
- `DEL N` / `DEL N.=M` — delete original lines.
- `INS.PRE N:` — insert body rows before original line `N`.
- `INS.POST N:` — insert body rows after original line `N`.
- `INS.HEAD:` / `INS.TAIL:` — insert at the start / end of the file.

Body rows:
- Every body row is `+TEXT`.
- A lone `+` inserts one empty line.
- The body is only final file content. Never write `-old` rows or bare context rows.

Rules:
- Numbers always refer to the original file named by `TAG`.
- After every successful edit or write, re-read or reuse the fresh `[PATH#TAG]` header from the newest result.
- `SWAP` / `DEL` ranges must be tight and explicit. Cover only lines whose content changes.
- If you need to touch a line, that exact line must have been displayed by the read result that minted the tag.
- For insertions adjacent to a replacement, either include the new rows in the `SWAP` body or anchor at the explicit boundary with `INS.PRE start` / `INS.POST end`.
- Indent every `+TEXT` row exactly as it should land in the file.

Examples:
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
DEL 48
```
