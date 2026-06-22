Edit an existing text file using fresh `LINE#HASH` anchors.

Usage:
- Use `edit` only with fresh anchors from `read`, `write`, or a prior successful `edit` result for the same region.
- `edit` has three top-level parameters: `path`, optional `workdir`, and `edits`. `workdir` defaults to the agent's current working directory. If `workdir` is provided, path resolution uses that directory.
- Each `edits` item must contain exactly one operation: `replace_lines`, `delete_lines`, `insert_before_lines`, or `insert_after_lines`.
- Anchor values are copied exactly from tool output, for example `45#2574`. Never include `LINE#HASH|` prefixes in `new_text`.
- `replace_lines.start_anchor` and `replace_lines.end_anchor` define an inclusive line range: both the start and end lines are replaced. Use the same anchor for a single-line replacement.
- `delete_lines.start_anchor` and `delete_lines.end_anchor` define an inclusive line range: both the start and end lines are deleted. Use the same anchor for a single-line deletion.
- `replace_lines.new_text` is raw replacement file content for the inclusive line range. Use `\n` inside the string when the replacement contains multiple lines.
- `insert_before_lines.new_text` and `insert_after_lines.new_text` are complete line(s) to insert before/after the anchor. `new_text: ""` inserts one empty line.
- For every `replace_lines.new_text`, `insert_before_lines.new_text`, and `insert_after_lines.new_text`, provide the complete intended content for that operation. Do not use placeholders such as `...` or omitted sections.
- After a successful edit, only lines prefixed with `+` or `|` carry current reusable anchors. Lines prefixed with `-` are old/deleted content and are not reusable anchors.
- Hashes below are computed examples, but you must always copy the actual `LINE#HASH` anchors from the latest tool output.
- Examples use pseudo-code tool calls like `edit({ ... })`. When making an actual tool call, pass exactly the object inside the parentheses as the tool arguments.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `edits` (required array; each item must contain exactly one of `replace_lines`, `delete_lines`, `insert_before_lines`, or `insert_after_lines`)
- `replace_lines` requires `start_anchor`, `end_anchor`, and `new_text`
- `delete_lines` requires `start_anchor` and `end_anchor`
- `insert_before_lines` requires `anchor` and `new_text`
- `insert_after_lines` requires `anchor` and `new_text`

Examples:
Example: replace one anchored line with multiple output lines

Suppose `read` returned:

```
44#bb18|}
45#2574|export function buildOldDirectory(): UserDirectory {
46#fb24|  const users: User[] = [];
47#0f8d|  return { users };
```

Use this pseudo-code `edit({ ... })` call. `new_text` may contain `\n` to produce multiple file lines:

```
edit({ path: "src/example.ts", workdir: "packages/app", edits: [{ replace_lines: { start_anchor: "45#2574", end_anchor: "45#2574", new_text: "export function buildDemoDirectory(): UserDirectory {\n  const enabled = true;" } }] })
```

A successful result looks like this. Reuse only `|` and `+` anchors for follow-up edits:

```
| 44#bb18|}
- 45#----|export function buildOldDirectory(): UserDirectory {
+ 45#ed50|export function buildDemoDirectory(): UserDirectory {
+ 46#0ec6|  const enabled = true;
| 47#fb24|  const users: User[] = [];
```

Example: apply multiple non-overlapping operations in one edit call

Use one `edit` call when several changes target the same file and all anchors are fresh for the target file's current content. Prefer several small, non-overlapping operations over one broad replacement range; range edits must not overlap. The anchors may come from multiple `read`, `write`, or prior successful `edit` outputs, as long as the target file has not changed in a way that makes them stale.

Suppose `read` returned:

```
10#e687|const title = "Old";
11#c8dd|const enabled = false;
12#2221|debug(title);
13#5bf3|return title;
```

Replace line 10, delete line 12, and insert a line after line 11 in one call:

```
edit({ path: "src/example.ts", workdir: "packages/app", edits: [{ replace_lines: { start_anchor: "10#e687", end_anchor: "10#e687", new_text: "const title = \"New\";" } }, { delete_lines: { start_anchor: "12#2221", end_anchor: "12#2221" } }, { insert_after_lines: { anchor: "11#c8dd", new_text: "log(title);" } }] })
```

Expected diff shape:

```
- 10#----|const title = "Old";
+ 10#c05a|const title = "New";
| 11#c8dd|const enabled = false;
+ 12#1aab|log(title);
- 12#----|debug(title);
| 13#5bf3|return title;
```

Example: replace an inclusive line range

Suppose `read` returned:

```
45#2574|export function buildOldDirectory(): UserDirectory {
46#fb24|  const users: User[] = [];
47#0f8d|  return { users };
48#bb18|}
```

Replace lines 45 through 47 with three new lines:

```
edit({ path: "src/example.ts", workdir: "services/api", edits: [{ replace_lines: { start_anchor: "45#2574", end_anchor: "47#0f8d", new_text: "export function createDemoDirectory(): UserDirectory {\n  return { users: [] };\n}" } }] })
```

Expected diff shape:

```
- 45#----|export function buildOldDirectory(): UserDirectory {
- 46#----|  const users: User[] = [];
- 47#----|  return { users };
+ 45#b8bd|export function createDemoDirectory(): UserDirectory {
+ 46#e56f|  return { users: [] };
+ 47#bb18|}
| 48#bb18|}
```

Example: delete one line

Suppose `read` returned:

```
59#58e0|const value = compute();
60#f318|debug(value);
61#6518|return value;
```

Delete line 60:

```
edit({ path: "src/example.ts", workdir: "services/api", edits: [{ delete_lines: { start_anchor: "60#f318", end_anchor: "60#f318" } }] })
```

Expected diff shape:

```
| 59#58e0|const value = compute();
- 60#----|debug(value);
| 60#6518|return value;
```

Example: delete an inclusive line range

Suppose `read` returned:

```
60#f318|debug(value);
61#7f3c|track(value);
62#6518|return value;
```

Delete lines 60 through 61:

```
edit({ path: "src/example.ts", workdir: "packages/web", edits: [{ delete_lines: { start_anchor: "60#f318", end_anchor: "61#7f3c" } }] })
```

Expected diff shape:

```
- 60#----|debug(value);
- 61#----|track(value);
| 60#6518|return value;
```

Example: insert complete line(s) before an anchored line

Suppose `read` returned:

```
19#8f31|const input = loadInput();
20#ee88|return render(input);
21#bb18|}
```

Insert two complete lines before line 20:

```
edit({ path: "src/example.ts", workdir: "packages/web", edits: [{ insert_before_lines: { anchor: "20#ee88", new_text: "const enabled = true;\nlog(enabled);" } }] })
```

Expected diff shape:

```
| 19#8f31|const input = loadInput();
+ 20#859b|const enabled = true;
+ 21#ad38|log(enabled);
| 22#ee88|return render(input);
| 23#bb18|}
```

Example: insert complete line(s) after an anchored line

Suppose `read` returned:

```
20#859b|const enabled = true;
21#ee88|return render(input);
```

Insert two complete lines after line 20:

```
edit({ path: "src/example.ts", edits: [{ insert_after_lines: { anchor: "20#859b", new_text: "log(enabled);\nrun();" } }] })
```

Expected diff shape:

```
| 20#859b|const enabled = true;
+ 21#ad38|log(enabled);
+ 22#2a33|run();
| 23#ee88|return render(input);
```

Example: insert one empty line

Suppose `read` returned:

```
28#3005|- Insert new line(s) after an anchored line:
29#5056|  - example text
```

`new_text: ""` inserts one empty line after line 29:

```
edit({ path: "src/example.ts", workdir: "packages/docs", edits: [{ insert_after_lines: { anchor: "29#5056", new_text: "" } }] })
```

Expected file effect:

```
28#3005|- Insert new line(s) after an anchored line:
29#5056|  - example text
30#5d05|
```

Example: add a missing EOF newline

Suppose the file is one unterminated line and `read` returned:

```
1#7936|export const value = 1;
```

When the final line has no trailing newline, `new_text: ""` inserts the missing line separator after it. This turns `export const value = 1;` into `export const value = 1;\n`:

```
edit({ path: "src/example.ts", workdir: "packages/app", edits: [{ insert_after_lines: { anchor: "1#7936", new_text: "" } }] })
```
