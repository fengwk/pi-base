import { describe, expect, it } from "vitest";
import { analyzeBashSurfaceCommand, buildBashSurfaceCandidates, tokenizeBashSurfaceSegment } from "../src/bash-command-analyzer.js";

function segments(command: string): string[] {
  const analysis = analyzeBashSurfaceCommand(command);
  expect(analysis.kind).toBe("supported");
  return analysis.segments;
}

describe("bash command analyzer", () => {
  it("keeps simple commands as one static surface segment", () => {
    expect(segments("git status --short")).toEqual(["git status --short"]);
  });

  it("splits top-level command chains and pipelines", () => {
    expect(segments("git status && npm test || cat test.log; echo done")).toEqual([
      "git status",
      "npm test",
      "cat test.log",
      "echo done",
    ]);
    expect(segments("cat package.json | grep scripts |& tee out.log")).toEqual([
      "cat package.json",
      "grep scripts",
      "tee out.log",
    ]);
  });
  it("splits background command separators without splitting fd redirections", () => {
    expect(segments("sleep 1 & echo done")).toEqual(["sleep 1", "echo done"]);
    expect(segments("echo hi >out 2>&1 && echo done")).toEqual([
      "echo hi >out 2>&1",
      "echo done",
    ]);
    expect(segments("echo hi &> out && echo done")).toEqual([
      "echo hi &> out",
      "echo done",
    ]);
    expect(segments("echo hi >| out && echo done")).toEqual([
      "echo hi >| out",
      "echo done",
    ]);
  });

  it("does not split separators inside single or double quotes", () => {
    expect(segments("printf 'a && b; c | d' && echo ok")).toEqual([
      "printf 'a && b; c | d'",
      "echo ok",
    ]);
    expect(segments('printf "a && b | c; d" | grep a')).toEqual([
      'printf "a && b | c; d"',
      "grep a",
    ]);
  });

  it("does not split escaped separators", () => {
    expect(segments("echo a\\;b && echo c\\|d && echo e\\&\\&f")).toEqual([
      "echo a\\;b",
      "echo c\\|d",
      "echo e\\&\\&f",
    ]);
  });

  it("marks command substitutions as unsupported instead of trusting their static wrapper", () => {
    // Intent: runtime-generated commands cannot be safely reduced to the visible outer command.
    expect(analyzeBashSurfaceCommand("echo `git status && npm test` && echo done")).toEqual({
      kind: "unsupported",
      reason: "command_substitution",
      segments: [],
    });
    expect(analyzeBashSurfaceCommand('echo "$(git status && npm test | cat)" && echo done')).toEqual({
      kind: "unsupported",
      reason: "command_substitution",
      segments: [],
    });
  });

  it("keeps quoted or escaped command-substitution markers literal", () => {
    // Intent: conservative detection must not turn data protected by single quotes or escaping
    // into a false dynamic-execution finding.
    expect(segments("printf '%s' '$(rm -rf tmp)' '`whoami`'")).toEqual(["printf '%s' '$(rm -rf tmp)' '`whoami`'"]);
    expect(segments("echo \\$(date)")).toEqual(["echo \\$(date)"]);
    expect(segments('echo \\`date\\`')).toEqual(['echo \\`date\\`']);
    expect(segments('echo "$((1 + 2))"')).toEqual(['echo "$((1 + 2))"']);
  });

  it("marks process substitutions as unsupported but preserves literal markers", () => {
    // Intent: nested commands hidden in process-substitution arguments must not inherit the outer
    // command's allow rule, while single-quoted or escaped text stays literal.
    expect(analyzeBashSurfaceCommand("diff <(sort a | uniq) >(cat) | cat")).toEqual({
      kind: "unsupported",
      reason: "process_substitution",
      segments: [],
    });
    expect(segments("printf '%s' '<(rm -rf tmp)' '>(rm -rf tmp)'")).toEqual([
      "printf '%s' '<(rm -rf tmp)' '>(rm -rf tmp)'",
    ]);
    expect(segments(`printf '%s' "<(rm -rf tmp)" ">(rm -rf tmp)"`)).toEqual([
      `printf '%s' "<(rm -rf tmp)" ">(rm -rf tmp)"`,
    ]);
    expect(segments("echo \\<(date)")).toEqual(["echo \\<(date)"]);
  });

  it("marks compound shell syntax unsupported instead of trusting its outer segment", () => {
    // Intent: commands inside subshells, brace groups, functions, and control-flow clauses must not
    // bypass a deny rule merely because the compound syntax hides the real executable prefix.
    for (const command of [
      "(cd app && rm -rf tmp) && echo done",
      "{ rm -rf tmp; echo done; }",
      "cleanup() { rm -rf tmp; }; cleanup",
      "cleanup () { rm -rf tmp; }; cleanup",
      "if test -d tmp; then rm -rf tmp; fi",
      "! rm -rf tmp",
    ]) {
      expect(analyzeBashSurfaceCommand(command)).toMatchObject({ kind: "unsupported", reason: "compound_shell_syntax" });
    }
    expect(segments("echo $((1 + 2))")).toEqual(["echo $((1 + 2))"]);
  });

  it("does not split separators inside double-bracket tests", () => {
    expect(segments('[[ "$x" == "a && b" || "$y" == z ]] && echo ok')).toEqual([
      '[[ "$x" == "a && b" || "$y" == z ]]',
      "echo ok",
    ]);
  });

  it("ignores comments and treats non-comment hashes as ordinary characters", () => {
    expect(segments("git status # && rm -rf tmp\nnpm test")).toEqual(["git status", "npm test"]);
    expect(segments("echo foo#bar && echo done")).toEqual(["echo foo#bar", "echo done"]);
  });

  it("handles line continuations and CRLF newlines", () => {
    expect(segments("npm test \\\n  && npm run build")).toEqual(["npm test", "npm run build"]);
    expect(segments("git status\r\nnpm test")).toEqual(["git status", "npm test"]);
  });
  it("keeps heredoc bodies with the command that owns them", () => {
    expect(segments("cat <<EOF\nhello\nEOF\necho done")).toEqual([
      "cat <<EOF\nhello\nEOF",
      "echo done",
    ]);
    expect(segments("cat <<'EOF'\nrm -rf tmp\nEOF")).toEqual([
      "cat <<'EOF'\nrm -rf tmp\nEOF",
    ]);
    expect(segments("cat <<-EOF\n\tindented\n\tEOF\necho done")).toEqual([
      "cat <<-EOF\n\tindented\n\tEOF",
      "echo done",
    ]);
    expect(segments("cat <<A <<B\na\nA\nb\nB\necho done")).toEqual([
      "cat <<A <<B\na\nA\nb\nB",
      "echo done",
    ]);
    expect(segments("cat <<EOF | grep x\nabc\nEOF\necho done")).toEqual([
      "cat <<EOF\nabc\nEOF",
      "grep x",
      "echo done",
    ]);
    expect(segments("cat <<EOF && echo after\nabc\nEOF\necho done")).toEqual([
      "cat <<EOF\nabc\nEOF",
      "echo after",
      "echo done",
    ]);
  });

  it("rejects command substitution in expanding heredocs but preserves quoted delimiters", () => {
    // Intent: only heredocs whose delimiter permits expansion execute `$()`/backticks; quote or
    // backslash removal on the delimiter must keep the same body literal.
    expect(analyzeBashSurfaceCommand("cat <<EOF\n$(rm -rf tmp)\nEOF")).toEqual({
      kind: "unsupported",
      reason: "command_substitution",
      segments: ["cat <<EOF"],
    });
    expect(segments("cat <<'EOF'\n$(rm -rf tmp)\nEOF")).toEqual(["cat <<'EOF'\n$(rm -rf tmp)\nEOF"]);
    expect(segments("cat <<\\EOF\n`rm -rf tmp`\nEOF")).toEqual(["cat <<\\EOF\n`rm -rf tmp`\nEOF"]);
    expect(segments("cat <<\"E\\OF\"\n$(rm -rf tmp)\nE\\OF")).toEqual(["cat <<\"E\\OF\"\n$(rm -rf tmp)\nE\\OF"]);
    expect(segments("cat <<EOF\n$((1 + 2))\nEOF")).toEqual(["cat <<EOF\n$((1 + 2))\nEOF"]);
  });

  it("rejects nested command substitutions before interpreting their inner comments", () => {
    // Intent: once runtime substitution is present, inner lexical details must not restore allow.
    expect(analyzeBashSurfaceCommand("echo $(git status # comment\n && npm test) && echo done")).toEqual({
      kind: "unsupported",
      reason: "command_substitution",
      segments: [],
    });
  });

  it("reports unterminated heredocs instead of treating the body as commands", () => {
    expect(analyzeBashSurfaceCommand("cat <<EOF\nbody without delimiter")).toEqual({ kind: "unsupported", reason: "unterminated_heredoc", segments: ["cat <<EOF"] });
  });

  it("marks executable names with runtime expansion as unsupported", () => {
    // Intent: `$CMD`, concatenated expansions, and expanded absolute paths choose the executable at
    // runtime; visible argument prefixes cannot safely stand in for that command.
    for (const command of [
      '$CMD -rf tmp',
      'PREFIX=x "${CMD}" -rf tmp',
      'tool${SUFFIX} --flag',
      '"$HOME/bin/tool" --flag',
      '"\'$CMD\'" --flag',
    ]) {
      expect(analyzeBashSurfaceCommand(command)).toMatchObject({ kind: "unsupported", reason: "dynamic_command_name" });
    }
    expect(segments("'literal-command' --flag")).toEqual(["'literal-command' --flag"]);
    expect(segments("\\$literal-command --flag")).toEqual(["\\$literal-command --flag"]);
  });

  it("marks redirections attached to or preceding the executable as unsupported", () => {
    // Intent: without a full redirection parser, `bash<<<...` and `>/dev/null rm ...` must not hide
    // the executable from shell-wrapper or deny-rule checks.
    for (const command of [
      "bash<<<'echo hidden'",
      "bash</tmp/script.sh",
      ">/dev/null rm -rf tmp",
      "2>/dev/null rm -rf tmp",
    ]) {
      expect(analyzeBashSurfaceCommand(command)).toMatchObject({ kind: "unsupported", reason: "command_redirection" });
    }
    expect(segments("'literal>command' --flag")).toEqual(["'literal>command' --flag"]);
    expect(segments("literal\\>command --flag")).toEqual(["literal\\>command --flag"]);
  });

  it("marks shells, launchers, eval, and source wrappers as unsupported", () => {
    // Intent: commands that defer execution to runtime text or another executable must fall back
    // to permission confirmation without trying to parse launcher-specific option grammars.
    for (const command of [
      'bash -c "$REAL_BASH"',
      'b\'a\'sh -c "$REAL_BASH"',
      '\'ba\'\'sh\' -c "$REAL_BASH"',
      '/bin/b"a"sh -c "$REAL_BASH"',
      'env -u X bash -c "$CMD"',
      "command git status",
      "exec npm test",
      "nohup sleep 1",
      'eval "$NEXT_COMMAND"',
      "source ./setup.sh",
      ". ./setup.sh",
    ]) {
      expect(analyzeBashSurfaceCommand(command)).toMatchObject({ kind: "unsupported", reason: "dynamic_shell_wrapper" });
    }
    expect(segments("echo 'bash -c rm -rf tmp'")).toEqual(["echo 'bash -c rm -rf tmp'"]);
  });

  it("reports unsupported malformed surface syntax instead of guessing", () => {
    expect(analyzeBashSurfaceCommand("echo 'unterminated")).toEqual({ kind: "unsupported", reason: "unclosed_single_quote", segments: [] });
    expect(analyzeBashSurfaceCommand("echo (unterminated")).toEqual({ kind: "unsupported", reason: "unclosed_paren", segments: [] });
    expect(analyzeBashSurfaceCommand("echo )")).toEqual({ kind: "unsupported", reason: "unmatched_closing_paren", segments: [] });
  });

  it("tokenizes quoted and nested surface words without expanding them", () => {
    expect(tokenizeBashSurfaceSegment('bash -c "$REAL_BASH"')).toEqual(["bash", "-c", '"$REAL_BASH"']);
    expect(tokenizeBashSurfaceSegment('echo "$(rm -rf tmp)"')).toEqual(["echo", '"$(rm -rf tmp)"']);
    expect(tokenizeBashSurfaceSegment("echo $(rm -rf tmp)")).toEqual(["echo", "$(rm -rf tmp)"]);
  });

  it("builds prefix candidates for ordinary commands", () => {
    expect(buildBashSurfaceCandidates("git status --short")).toEqual([
      "git status --short",
      "git",
      "git *",
      "git status",
      "git status *",
      "git status --short *",
    ]);
  });

  it("builds executable candidates after environment assignment prefixes", () => {
    const candidates = buildBashSurfaceCandidates('NODE_ENV=test DEBUG="pi base" npm test');
    expect(candidates).toContain('NODE_ENV=test DEBUG="pi base" npm test');
    expect(candidates).toContain("NODE_ENV=test *");
    expect(candidates).toContain('NODE_ENV=test DEBUG="pi base" npm *');
    expect(candidates).toContain("npm test");
    expect(candidates).toContain("npm *");
  });

  it("adds normalized executable candidates for static quoting, escaping, and paths", () => {
    // Intent: ordinary shell quoting or an absolute executable path must not bypass a rule written
    // for the command basename, while no runtime expansion is performed.
    for (const command of [
      "r'm' -rf tmp",
      "'r''m' -rf tmp",
      "r\\m -rf tmp",
      "/bin/rm -rf tmp",
    ]) {
      const candidates = buildBashSurfaceCandidates(command);
      expect(candidates).toContain("rm *");
      expect(candidates).toContain("rm -rf tmp");
    }
  });

  it("keeps direct candidate generation lexical without expanding runtime content", () => {
    const bashCandidates = buildBashSurfaceCandidates('bash -c "$REAL_BASH"');
    expect(bashCandidates).toContain("bash *");
    expect(bashCandidates).toContain("bash -c *");
    expect(bashCandidates).not.toContain("rm *");

    const echoCandidates = buildBashSurfaceCandidates('echo "$(rm -rf tmp)"');
    expect(echoCandidates).toContain("echo *");
    expect(echoCandidates).not.toContain("rm *");
  });
});
