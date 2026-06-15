import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pexecIn } from "../src/synthesis/provider.js";

const IS_WIN = process.platform === "win32";

// Regression: on Windows the npm `claude` is a .cmd/.ps1 shim. execFile (the old
// impl) only launches *.exe, so it threw ENOENT and the CLI provider looked
// unavailable → synthesis silently fell back to the low-confidence heuristic.
// pexecIn must resolve PATH commands (shell:true on win routes through cmd.exe).
test("pexecIn resolves a PATH command's stdout", async () => {
  const { stdout } = await pexecIn("node", ["--version"]);
  assert.match(stdout.trim(), /^v\d+\./);
});

// Core invariant: untrusted content (the prompt/diff) goes via STDIN, never as
// an argv element — so the shell used for shim resolution can't interpret it.
// The payload below is pure shell-metachar bait; if anyone routes it back
// through argv under shell:true it would break or execute, failing this test.
test("pexecIn feeds untrusted input via stdin, not argv", async () => {
  const script = join(tmpdir(), `hunch-pexec-${process.pid}.mjs`);
  writeFileSync(
    script,
    `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("GOT:"+d));`,
  );
  try {
    const payload = 'diff with "quotes" `backticks` $(subshell) & | metachars';
    // Quote the script path on win (shell:true) so a space in TEMP can't split it.
    const arg = IS_WIN ? `"${script}"` : script;
    const { stdout } = await pexecIn("node", [arg], { input: payload });
    assert.equal(stdout, "GOT:" + payload);
  } finally {
    rmSync(script, { force: true });
  }
});

// A missing command rejects (so ClaudeCliProvider.available() → false and the
// caller degrades to the deterministic provider instead of crashing).
test("pexecIn rejects on a missing command", async () => {
  await assert.rejects(pexecIn("hunch-no-such-cmd-xyz", ["--version"], { timeout: 4000 }));
});
