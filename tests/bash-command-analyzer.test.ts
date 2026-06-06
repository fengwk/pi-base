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

  it("does not split separators inside backticks or command substitutions", () => {
    expect(segments("echo `git status && npm test` && echo done")).toEqual([
      "echo `git status && npm test`",
      "echo done",
    ]);
    expect(segments("echo $(git status && npm test | cat) && echo done")).toEqual([
      "echo $(git status && npm test | cat)",
      "echo done",
    ]);
  });

  it("does not split separators inside process substitutions or parenthesized groups", () => {
    expect(segments("diff <(sort a | uniq) <(sort b | uniq) | cat")).toEqual([
      "diff <(sort a | uniq) <(sort b | uniq)",
      "cat",
    ]);
    expect(segments("(cd app && npm test) && echo done")).toEqual([
      "(cd app && npm test)",
      "echo done",
    ]);
  });

  it("does not split separators inside brace groups or double-bracket tests", () => {
    expect(segments("{ git status; npm test; } && echo done")).toEqual([
      "{ git status; npm test; }",
      "echo done",
    ]);
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

  it("does not split comments inside nested command substitutions as top-level commands", () => {
    expect(segments("echo $(git status # comment\n && npm test) && echo done")).toEqual([
      "echo $(git status \n && npm test)",
      "echo done",
    ]);
  });

  it("reports unterminated heredocs instead of treating the body as commands", () => {
    expect(analyzeBashSurfaceCommand("cat <<EOF\nbody without delimiter")).toEqual({ kind: "unsupported", reason: "unterminated_heredoc", segments: ["cat <<EOF"] });
  });

  it("reports unsupported malformed surface syntax instead of guessing", () => {
    expect(analyzeBashSurfaceCommand("echo 'unterminated")).toEqual({ kind: "unsupported", reason: "unclosed_single_quote", segments: [] });
    expect(analyzeBashSurfaceCommand("echo $(unterminated")).toEqual({ kind: "unsupported", reason: "unclosed_paren", segments: [] });
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

  it("matches static shell wrappers without inspecting runtime content", () => {
    const bashCandidates = buildBashSurfaceCandidates('bash -c "$REAL_BASH"');
    expect(bashCandidates).toContain("bash *");
    expect(bashCandidates).toContain("bash -c *");
    expect(bashCandidates).not.toContain("rm *");

    const echoCandidates = buildBashSurfaceCandidates('echo "$(rm -rf tmp)"');
    expect(echoCandidates).toContain("echo *");
    expect(echoCandidates).not.toContain("rm *");
  });
});
