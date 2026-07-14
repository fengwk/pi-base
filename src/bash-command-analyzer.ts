export type BashSurfaceAnalysis =
  | { kind: "supported"; segments: string[] }
  | { kind: "unsupported"; reason: string; segments: string[] };

function normalizeCommandInput(command: string): string {
  return command.replace(/\r\n?/g, "\n").replace(/\\\n/g, " ");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function pushSegment(segments: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) segments.push(trimmed);
}

function isCommentStart(currentSegment: string): boolean {
  return currentSegment.length === 0 || /\s$/.test(currentSegment);
}

function topLevelOperatorLength(input: string, index: number): number {
  const char = input[index];
  const next = input[index + 1];
  if (char === "&" && next === "&") return 2;
  if (char === "&" && next !== ">" && input[index - 1] !== ">" && input[index - 1] !== "<") return 1;
  if (char === "|" && input[index - 1] === ">") return 0;
  if (char === "|" && next === "|") return 2;
  if (char === "|" && next === "&") return 2;
  if (char === "|") return 1;
  if (char === ";") return 1;
  if (char === "\n") return 1;
  return 0;
}
interface HeredocDelimiter {
  value: string;
  stripLeadingTabs: boolean;
  allowExpansion: boolean;
}
interface PendingHeredoc {
  segmentIndex: number;
  delimiters: HeredocDelimiter[];
}

function parseHeredocDelimiter(token: string): { value: string; allowExpansion: boolean } {
  let value = "";
  let quote: "single" | "double" | undefined;
  let allowExpansion = true;
  for (let i = 0; i < token.length; i++) {
    const char = token[i]!;
    const next = token[i + 1];
    if (char === "\\" && next !== undefined && quote !== "single") {
      allowExpansion = false;
      if (quote === "double" && !["$", "`", '"', "\\", "\n"].includes(next)) {
        value += char;
        continue;
      }
      value += next;
      i += 1;
      continue;
    }
    if (char === "'" && quote !== "double") {
      allowExpansion = false;
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (char === '"' && quote !== "single") {
      allowExpansion = false;
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    value += char;
  }
  return { value, allowExpansion };
}

function extractHeredocDelimiters(commandLine: string): HeredocDelimiter[] {
  const tokens = tokenizeBashSurfaceSegment(commandLine);
  const delimiters: HeredocDelimiter[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let rawDelimiter: string | undefined;
    let stripLeadingTabs = false;

    if (token === "<<" || token === "<<-") {
      rawDelimiter = tokens[++i];
      stripLeadingTabs = token === "<<-";
    } else if (token.startsWith("<<-") && !token.startsWith("<<<")) {
      rawDelimiter = token.slice(3);
      stripLeadingTabs = true;
    } else if (token.startsWith("<<") && !token.startsWith("<<<")) {
      rawDelimiter = token.slice(2);
    }

    if (rawDelimiter === undefined) continue;
    const parsed = parseHeredocDelimiter(rawDelimiter);
    if (parsed.value.length === 0) continue;
    delimiters.push({ ...parsed, stripLeadingTabs });
  }
  return delimiters;
}

function isCommandSubstitutionStart(value: string, index: number): boolean {
  return value[index] === "$" && value[index + 1] === "(" && value[index + 2] !== "(";
}

function hasExpandableCommandSubstitution(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    const next = value[i + 1];
    if (char === "\\" && next !== undefined) {
      i += 1;
      continue;
    }
    if (isCommandSubstitutionStart(value, i) || char === "`") return true;
  }
  return false;
}

function consumeHeredocBodies(input: string, newlineIndex: number, delimiters: HeredocDelimiter[]): { text: string; nextIndex: number } | { reason: string } {
  let cursor = newlineIndex + 1;
  let text = "\n";
  for (const delimiter of delimiters) {
    let found = false;
    while (cursor <= input.length) {
      const lineEnd = input.indexOf("\n", cursor);
      const hasNewline = lineEnd !== -1;
      const end = hasNewline ? lineEnd : input.length;
      const line = input.slice(cursor, end);
      text += input.slice(cursor, hasNewline ? lineEnd + 1 : end);
      cursor = hasNewline ? lineEnd + 1 : end;

      const comparable = delimiter.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === delimiter.value) {
        found = true;
        break;
      }
      if (delimiter.allowExpansion && hasExpandableCommandSubstitution(line)) {
        return { reason: "command_substitution" };
      }
      if (!hasNewline) break;
    }
    if (!found) return { reason: "unterminated_heredoc" };
  }
  return { text, nextIndex: cursor };
}

/**
 * Split a bash command into static, top-level surface segments.
 *
 * This intentionally does not expand variables, inspect scripts, or recursively analyze dynamic
 * shell constructs. Command/process substitutions, expanding heredocs, runtime command names,
 * executable-position redirections, compound syntax, and dynamic wrappers are marked unsupported;
 * the remaining parser keeps top-level separators out of quoted, escaped, commented, heredoc, or
 * nested grouping syntax.
 */
export function analyzeBashSurfaceCommand(command: string): BashSurfaceAnalysis {
  const input = normalizeCommandInput(command);
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let parenDepth = 0;
  let braceDepth = 0;
  let doubleBracketDepth = 0;
  let inComment = false;
  const pendingHeredocs: PendingHeredoc[] = [];

  const pushCurrentSegment = () => {
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      current = "";
      return;
    }
    const delimiters = extractHeredocDelimiters(trimmed);
    const segmentIndex = segments.length;
    segments.push(trimmed);
    if (delimiters.length > 0) pendingHeredocs.push({ segmentIndex, delimiters });
    current = "";
  };

  const consumePendingHeredocs = (newlineIndex: number): { nextIndex: number } | { reason: string } => {
    let currentNewlineIndex = newlineIndex;
    for (const pending of pendingHeredocs) {
      const consumed = consumeHeredocBodies(input, currentNewlineIndex, pending.delimiters);
      if ("reason" in consumed) return consumed;
      segments[pending.segmentIndex] = `${segments[pending.segmentIndex]}${consumed.text}`.trim();
      currentNewlineIndex = consumed.nextIndex - 1;
    }
    pendingHeredocs.length = 0;
    return { nextIndex: currentNewlineIndex + 1 };
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inComment) {
      if (char === "\n") {
        inComment = false;
        if (parenDepth === 0 && braceDepth === 0 && doubleBracketDepth === 0) {
          pushCurrentSegment();
          if (pendingHeredocs.length > 0) {
            const consumed = consumePendingHeredocs(i);
            if ("reason" in consumed) return { kind: "unsupported", reason: consumed.reason, segments };
            i = consumed.nextIndex - 1;
          }
        } else {
          current += "\n";
        }
      }
      continue;
    }

    if (quote === "single") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      current += char;
      if (char === "\\" && next !== undefined) {
        current += next;
        i++;
        continue;
      }
      if (isCommandSubstitutionStart(input, i)) return { kind: "unsupported", reason: "command_substitution", segments };
      if (char === "`") return { kind: "unsupported", reason: "command_substitution", segments };
      if (char === "\"") quote = undefined;
      continue;
    }

    if (char === "#" && isCommentStart(current)) {
      inComment = true;
      continue;
    }

    if (char === "\\" && next !== undefined) {
      current += char;
      current += next;
      i++;
      continue;
    }

    if (char === "'") {
      quote = "single";
      current += char;
      continue;
    }

    if (char === "\"") {
      quote = "double";
      current += char;
      continue;
    }

    if (isCommandSubstitutionStart(input, i)) return { kind: "unsupported", reason: "command_substitution", segments };
    if (char === "`") return { kind: "unsupported", reason: "command_substitution", segments };
    if ((char === "<" || char === ">") && next === "(") {
      return { kind: "unsupported", reason: "process_substitution", segments };
    }

    if (char === "[" && next === "[") {
      doubleBracketDepth++;
      current += "[[";
      i++;
      continue;
    }

    if (doubleBracketDepth > 0 && char === "]" && next === "]") {
      doubleBracketDepth--;
      current += "]]";
      i++;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      current += char;
      continue;
    }

    if (char === ")") {
      if (parenDepth === 0) return { kind: "unsupported", reason: "unmatched_closing_paren", segments };
      parenDepth--;
      current += char;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      current += char;
      continue;
    }

    if (char === "}") {
      if (braceDepth === 0) return { kind: "unsupported", reason: "unmatched_closing_brace", segments };
      braceDepth--;
      current += char;
      continue;
    }

    if (parenDepth === 0 && braceDepth === 0 && doubleBracketDepth === 0) {
      const operatorLength = topLevelOperatorLength(input, i);
      if (operatorLength > 0) {
        pushCurrentSegment();
        if (char === "\n" && pendingHeredocs.length > 0) {
          const consumed = consumePendingHeredocs(i);
          if ("reason" in consumed) return { kind: "unsupported", reason: consumed.reason, segments };
          i = consumed.nextIndex - 1;
          continue;
        }
        i += operatorLength - 1;
        continue;
      }
    }

    current += char;
  }

  if (quote) return { kind: "unsupported", reason: `unclosed_${quote}_quote`, segments };
  if (parenDepth > 0) return { kind: "unsupported", reason: "unclosed_paren", segments };
  if (braceDepth > 0) return { kind: "unsupported", reason: "unclosed_brace", segments };
  if (doubleBracketDepth > 0) return { kind: "unsupported", reason: "unclosed_double_bracket", segments };

  pushSegment(segments, current);
  for (const segment of segments) {
    const reason = unsupportedSurfaceReason(segment);
    if (reason) return { kind: "unsupported", reason, segments };
  }
  return { kind: "supported", segments };
}

export function tokenizeBashSurfaceSegment(segment: string): string[] {
  const input = normalizeCommandInput(segment);
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | "backtick" | undefined;
  let parenDepth = 0;
  let braceDepth = 0;
  let doubleBracketDepth = 0;
  let inComment = false;

  const pushToken = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }

    if (quote === "single") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      current += char;
      if (char === "\\" && next !== undefined) {
        current += next;
        i++;
        continue;
      }
      if (char === "\"") quote = undefined;
      continue;
    }

    if (quote === "backtick") {
      current += char;
      if (char === "\\" && next !== undefined) {
        current += next;
        i++;
        continue;
      }
      if (char === "`") quote = undefined;
      continue;
    }

    if (char === "#" && current.length === 0) {
      inComment = true;
      continue;
    }

    if (char === "\\" && next !== undefined) {
      current += char;
      current += next;
      i++;
      continue;
    }

    if (char === "'") {
      quote = "single";
      current += char;
      continue;
    }

    if (char === "\"") {
      quote = "double";
      current += char;
      continue;
    }

    if (char === "`") {
      quote = "backtick";
      current += char;
      continue;
    }

    if (char === "[" && next === "[") {
      doubleBracketDepth++;
      current += "[[";
      i++;
      continue;
    }

    if (doubleBracketDepth > 0 && char === "]" && next === "]") {
      doubleBracketDepth--;
      current += "]]";
      i++;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      current += char;
      continue;
    }

    if (char === ")" && parenDepth > 0) {
      parenDepth--;
      current += char;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      current += char;
      continue;
    }

    if (char === "}" && braceDepth > 0) {
      braceDepth--;
      current += char;
      continue;
    }

    if (/\s/.test(char) && parenDepth === 0 && braceDepth === 0 && doubleBracketDepth === 0) {
      pushToken();
      continue;
    }

    current += char;
  }

  pushToken();
  return tokens;
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(token);
}

const DYNAMIC_SHELL_WRAPPERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ksh93", "mksh", "fish"]);
const COMMAND_LAUNCHERS = new Set(["command", "env", "exec", "nohup"]);
const COMPOUND_SHELL_KEYWORDS = new Set([
  "!",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

interface ExecutableTokenSurface {
  name: string;
  hasExpansion: boolean;
  hasRedirection: boolean;
}

function analyzeExecutableToken(token: string): ExecutableTokenSurface {
  let value = "";
  let quote: "single" | "double" | undefined;
  let hasExpansion = false;
  let hasRedirection = false;
  for (let i = 0; i < token.length; i++) {
    const char = token[i]!;
    const next = token[i + 1];
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else value += char;
      continue;
    }
    if (quote === "double") {
      if (char === "\\" && next !== undefined) {
        if (["$", "`", '"', "\\", "\n"].includes(next)) {
          value += next;
          i += 1;
        } else {
          value += char;
        }
        continue;
      }
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === "$") hasExpansion = true;
      value += char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      value += next;
      i += 1;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "$") hasExpansion = true;
    if (char === "<" || char === ">") hasRedirection = true;
    value += char;
  }
  return {
    name: value.split(/[\\/]/).pop() ?? value,
    hasExpansion,
    hasRedirection,
  };
}

function isCompoundShellSyntax(tokens: string[], commandIndex: number, executable: string): boolean {
  const token = tokens[commandIndex]!;
  if (COMPOUND_SHELL_KEYWORDS.has(executable)) return true;
  if (token.startsWith("(") && !token.startsWith("((")) return true;
  if (token.startsWith("{")) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)/.test(token)) return true;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && tokens[commandIndex + 1]?.startsWith("()") === true;
}

function unsupportedSurfaceReason(segment: string): string | undefined {
  const tokens = tokenizeBashSurfaceSegment(segment);
  const index = tokens.findIndex((token) => !isAssignmentToken(token));
  if (index < 0) return undefined;

  const executableToken = tokens[index]!;
  if (executableToken.startsWith("[[") || executableToken.startsWith("((")) return undefined;
  const executable = analyzeExecutableToken(executableToken);
  if (executable.hasRedirection) return "command_redirection";
  if (isCompoundShellSyntax(tokens, index, executable.name)) return "compound_shell_syntax";
  if (executable.hasExpansion) return "dynamic_command_name";
  if (COMMAND_LAUNCHERS.has(executable.name)) return "dynamic_shell_wrapper";
  if (executable.name === "eval" || executable.name === "source" || executable.name === ".") return "dynamic_shell_wrapper";
  if (DYNAMIC_SHELL_WRAPPERS.has(executable.name)) return "dynamic_shell_wrapper";
  return undefined;
}

function addPrefixCandidates(candidates: string[], tokens: string[]): void {
  for (let length = 1; length <= tokens.length; length++) {
    const prefix = tokens.slice(0, length).join(" ");
    candidates.push(prefix);
    candidates.push(`${prefix} *`);
  }
}

export function buildBashSurfaceCandidates(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];

  const tokens = tokenizeBashSurfaceSegment(trimmed);
  const candidates = [trimmed];
  addPrefixCandidates(candidates, tokens);

  const commandStart = tokens.findIndex((token) => !isAssignmentToken(token));
  if (commandStart > 0) {
    addPrefixCandidates(candidates, tokens.slice(commandStart));
  }
  if (commandStart >= 0) {
    const commandTokens = tokens.slice(commandStart);
    const executable = analyzeExecutableToken(commandTokens[0]!).name;
    if (executable && executable !== commandTokens[0]) {
      addPrefixCandidates(candidates, [executable, ...commandTokens.slice(1)]);
    }
  }

  return uniqueStrings(candidates);
}
