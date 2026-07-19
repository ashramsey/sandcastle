/**
 * REAL-AGENT end-to-end verification for the Docker hardening work.
 * ============================================================================
 *
 * WHAT THIS PROVES
 * ----------------
 * A real Claude Code agent run completes successfully inside a bind-mount
 * sandbox under ALL the hardening defaults shipped so far:
 *
 *   - ticket 01/08 — `.git/hooks` + `.git/config` mounted read-only
 *   - ticket 02    — `--cap-drop=ALL`, `--security-opt no-new-privileges`,
 *                    `--pids-limit 2048`
 *
 * The no-agent runners (`verify-git-config-mount.ts`, `verify-run-hardening.ts`)
 * prove the mounts/flags are applied and that scripted writes behave. This
 * runner closes the one criterion they cannot: that a *real agent* — editing
 * files, committing in the worktree, and writing its own session state — still
 * succeeds under the hardened posture. It needs an API key.
 *
 * ----------------------------------------------------------------------------
 * PREREQUISITES (from the repo root, ON A DOCKER HOST)
 * ----------------------------------------------------------------------------
 *   npm ci
 *   npm run build
 *   node dist/main.js docker build-image --image-name sandcastle-verify
 *   export ANTHROPIC_API_KEY=sk-ant-...      # a real key
 *
 * ----------------------------------------------------------------------------
 * RUN
 * ----------------------------------------------------------------------------
 *   IMAGE=sandcastle-verify npx tsx .sandcastle/verify-agent-e2e.ts
 *
 * Exits non-zero if the agent fails to produce the expected commit.
 *
 * NOTE ON THE API KEY: this runs against a THROWAWAY repo, which has no
 * `.sandcastle/.env`, so the env resolver won't forward the key. We inject it
 * explicitly via `docker({ env: { ANTHROPIC_API_KEY } })` so it reaches the
 * container regardless of cwd.
 *
 * PODMAN: swap the two `PODMAN:`-marked lines.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
// PODMAN: import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error(
    "Set IMAGE=<prebuilt sandbox image name>, e.g. IMAGE=sandcastle-verify",
  );
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error(
    "Set ANTHROPIC_API_KEY to a real key — this runner drives a live agent.",
  );
}

const REPO_BASE =
  process.env.VERIFY_REPO_BASE ??
  (process.platform === "darwin" ? "/tmp" : tmpdir());

let pass = true;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) pass = false;
};

// --- throwaway repo with a single seed commit ---
const repo = realpathSync(mkdtempSync(join(REPO_BASE, "sc-agent-e2e-")));
const hostGit = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
hostGit(["init", "-q", "-b", "main"]);
hostGit(["config", "user.email", "verify@example.com"]);
hostGit(["config", "user.name", "Verify"]);
writeFileSync(join(repo, "README.md"), "seed\n");
hostGit(["add", "-A"]);
hostGit(["commit", "-qm", "seed"]);

console.log(`Image: ${IMAGE}\nRepo:  ${repo}\n`);

const sandbox = await sandcastle.createSandbox({
  sandbox: docker({ imageName: IMAGE, env: { ANTHROPIC_API_KEY } }),
  // PODMAN: sandbox: podman({ imageName: IMAGE, env: { ANTHROPIC_API_KEY } }),
  cwd: repo,
  branch: "agent-e2e",
});

try {
  const result = await sandbox.run({
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    prompt:
      "Create a file named GREETING.txt whose entire contents are the line " +
      "'hello from the sandbox', then commit it with the message " +
      "'agent e2e change'. Do nothing else.",
  });

  check(
    "agent produced at least one commit under the hardened posture",
    result.commits.length > 0,
    `${result.commits.length} commit(s)`,
  );

  // Confirm the file the agent was asked to create landed in the worktree.
  const show = execFileSync(
    "git",
    ["-C", sandbox.worktreePath, "show", "HEAD:GREETING.txt"],
    { stdio: "pipe" },
  )
    .toString()
    .trim();
  check(
    "committed GREETING.txt has the expected contents",
    show === "hello from the sandbox",
    JSON.stringify(show),
  );
} finally {
  await sandbox.close();
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${pass ? "✅ AGENT E2E PASSED" : "❌ AGENT E2E FAILED"}`);
process.exit(pass ? 0 : 1);
