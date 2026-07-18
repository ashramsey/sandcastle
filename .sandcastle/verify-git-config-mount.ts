/**
 * Docker/Podman verification for ticket 08 — harden/git-config-injection-vector.
 * ============================================================================
 *
 * WHAT THIS PROVES
 * ----------------
 * The read-only `.git/config` mount is enforced by a bind *mountpoint*, which
 * can only be verified against a real container runtime (file permissions do
 * NOT suffice — git rewrites config via `config.lock` + rename(), which needs
 * only directory write permission). This script drives a real bind-mount
 * sandbox against a THROWAWAY repo and asserts the ticket's acceptance criteria:
 *
 *   HARDENED (default):
 *     - `git config --local core.hooksPath ...`  is REJECTED (read-only config)
 *     - `git remote add ...`                      is REJECTED
 *     - a normal `git commit`                     SUCCEEDS (HEAD advances)
 *
 *   OPT-OUT (SANDCASTLE_ALLOW_GIT_CONFIG_WRITES=1):
 *     - the same repo-local config writes now     SUCCEED (gate is overridable)
 *
 * It uses `createSandbox().exec()` directly, so it needs NO agent and NO API
 * key. `exec()` returns the full ExecResult (non-zero exitCode is surfaced, not
 * thrown), which is what lets us assert on failures.
 *
 * NOTE ON THE MOUNT PATH: `createSandbox` always uses explicit-branch mode, so
 * the worktree's `.git` is a *file* pointing at the parent repo, and the config
 * mount hardens the PARENT `.git/config`. That exercises the worktree branch of
 * `resolveGitMounts` end-to-end — the more important of the two cases.
 *
 * ----------------------------------------------------------------------------
 * PREREQUISITES (run once, from the sandcastle repo root, ON A DOCKER HOST)
 * ----------------------------------------------------------------------------
 *   npm ci
 *   npm run build                                    # build @ai-hero/sandcastle → dist/
 *   node dist/main.js docker build-image --image-name sandcastle-verify
 *
 * The `docker()` provider does NOT auto-build; the image must exist first. The
 * build context is `.sandcastle/Dockerfile`. The `--image-name` you build here
 * must match the IMAGE you pass below (the default name is derived from the repo
 * directory, so pass it explicitly to keep the two in sync).
 *
 * ----------------------------------------------------------------------------
 * RUN
 * ----------------------------------------------------------------------------
 *   # 1. HARDENED (default) — writes must FAIL, commit must SUCCEED:
 *   IMAGE=sandcastle-verify npx tsx .sandcastle/verify-git-config-mount.ts
 *
 *   # 2. OPT-OUT — writes must now SUCCEED:
 *   IMAGE=sandcastle-verify SANDCASTLE_ALLOW_GIT_CONFIG_WRITES=1 \
 *     npx tsx .sandcastle/verify-git-config-mount.ts
 *
 * The script prints PASS/FAIL per check and exits non-zero if any check fails,
 * so it can gate CI. A full pass in BOTH modes closes the ticket's remaining
 * "Docker + Podman covered" acceptance criterion.
 *
 * ----------------------------------------------------------------------------
 * PODMAN
 * ----------------------------------------------------------------------------
 * Build with `node dist/main.js podman build-image --image-name sandcastle-verify`
 * and swap the two lines marked `PODMAN:` below (import `podman`, call it
 * instead of `docker`). Everything else is identical.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
// PODMAN: import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error(
    "Set IMAGE=<prebuilt sandbox image name>, e.g. IMAGE=sandcastle-verify",
  );
}

// The gate is read on the HOST at mount-resolution time, so it is controlled by
// this process's env — set SANDCASTLE_ALLOW_GIT_CONFIG_WRITES here, not inside.
const hardened = process.env.SANDCASTLE_ALLOW_GIT_CONFIG_WRITES == null;
console.log(
  `Image: ${IMAGE}\nMode:  ${
    hardened
      ? "HARDENED (.git/config read-only)"
      : "OPT-OUT (.git/config writable)"
  }\n`,
);

// --- throwaway repo with a single seed commit ---
const repo = mkdtempSync(join(tmpdir(), "sc-verify-"));
const hostGit = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
hostGit(["init", "-q", "-b", "main"]);
hostGit(["config", "user.email", "verify@example.com"]);
hostGit(["config", "user.name", "Verify"]);
writeFileSync(join(repo, "README.md"), "seed\n");
hostGit(["add", "-A"]);
hostGit(["commit", "-qm", "seed"]);

let pass = true;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) pass = false;
};

const sandbox = await createSandbox({
  sandbox: docker({ imageName: IMAGE }),
  // PODMAN: sandbox: podman({ imageName: IMAGE }),
  cwd: repo,
  branch: "verify-config",
});

try {
  // Silence dubious-ownership and give the container a commit identity. These
  // are --global writes (container home, always writable) — never touch the
  // hardened repo-local .git/config.
  await sandbox.exec(
    'git config --global --add safe.directory "$(pwd)" && ' +
      "git config --global user.email a@b.c && git config --global user.name A",
  );

  // (1) repo-local config writes — the injection surface.
  const hooksWrite = await sandbox.exec(
    "git config --local core.hooksPath /tmp/evil",
  );
  const remoteAdd = await sandbox.exec(
    "git remote add evil https://example.com/x.git",
  );
  if (hardened) {
    check("core.hooksPath write is rejected", hooksWrite.exitCode !== 0);
    check("git remote add is rejected", remoteAdd.exitCode !== 0);
  } else {
    check("core.hooksPath write succeeds (opt-out)", hooksWrite.exitCode === 0);
    check("git remote add succeeds (opt-out)", remoteAdd.exitCode === 0);
  }

  // (2) a normal commit must still work regardless of mode.
  await sandbox.exec("echo change > work.txt && git add -A");
  const commit = await sandbox.exec('git commit -qm "agent change"');
  check("commit succeeds", commit.exitCode === 0, commit.stderr.trim());
  const head = await sandbox.exec("git rev-list --count HEAD");
  check(
    "HEAD advanced to 2 commits",
    head.stdout.trim() === "2",
    head.stdout.trim(),
  );
} finally {
  await sandbox.close();
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${pass ? "✅ ALL CHECKS PASSED" : "❌ CHECKS FAILED"}`);
process.exit(pass ? 0 : 1);
