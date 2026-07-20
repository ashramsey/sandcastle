/**
 * Docker/Podman verification for ticket 02 — harden/docker-run-line-hardening.
 * ============================================================================
 *
 * WHAT THIS PROVES
 * ----------------
 * The default run line drops privilege and bounds resources WITHOUT breaking a
 * normal agent run. It drives a real bind-mount sandbox via `createSandbox()`
 * (no agent, no API key) and asserts both halves of the ticket:
 *
 *   APPLIED (inspect the running container's HostConfig):
 *     - CapDrop          == ["ALL"]
 *     - SecurityOpt      includes "no-new-privileges"
 *     - PidsLimit        == 2048  (the generous default)
 *     - Memory           == 0     (no default ceiling — opt-in only)
 *     - ReadonlyRootfs   == true  (ticket 10 — read-only rootfs by default)
 *     - Tmpfs            includes /tmp + ~/.claude (ticket 10 — writable set)
 *     with an override sandbox proving Memory / PidsLimit / CapAdd are honored,
 *     plus a `readOnlyRootfs: false` sandbox proving the rootfs opt-out.
 *
 *   FUNCTIONAL (the agent workflow still succeeds under the hardened defaults —
 *   note these writes land on the tmpfs mounts under the read-only rootfs):
 *     - edit a file and `git commit` in the worktree          SUCCEEDS
 *     - write agent session state under ~/.claude             SUCCEEDS
 *     - write a package-manager cache dir (~/.npm)            SUCCEEDS
 *     - `git config --global` write (~/.gitconfig relocation) SUCCEEDS
 *     - a write OUTSIDE the tmpfs set (e.g. ~/probe) is REJECTED by read-only
 *
 * `exec()` returns the full ExecResult (a non-zero exit is surfaced, not
 * thrown), which is what lets us assert on success/failure.
 *
 * ----------------------------------------------------------------------------
 * PREREQUISITES (run once, from the repo root, ON A DOCKER HOST)
 * ----------------------------------------------------------------------------
 *   npm ci
 *   npm run build
 *   node dist/main.js docker build-image --image-name sandcastle-verify
 *
 * ----------------------------------------------------------------------------
 * RUN
 * ----------------------------------------------------------------------------
 *   IMAGE=sandcastle-verify npx tsx .sandcastle/verify-run-hardening.ts
 *
 * Exits non-zero if any check fails, so it can gate CI.
 *
 * ----------------------------------------------------------------------------
 * PODMAN
 * ----------------------------------------------------------------------------
 * Build with `node dist/main.js podman build-image --image-name sandcastle-verify`,
 * swap the two lines marked `PODMAN:` below, and change RUNTIME to "podman".
 * `podman inspect` exposes the same HostConfig fields.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
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
const RUNTIME = "docker"; // PODMAN: "podman"

const REPO_BASE =
  process.env.VERIFY_REPO_BASE ??
  (process.platform === "darwin" ? "/tmp" : tmpdir());

console.log(`Image: ${IMAGE}\nRuntime: ${RUNTIME}\n`);

let pass = true;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) pass = false;
};

// --- throwaway repo with a single seed commit ---
const repo = realpathSync(mkdtempSync(join(REPO_BASE, "sc-verify-")));
const hostGit = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
hostGit(["init", "-q", "-b", "main"]);
hostGit(["config", "user.email", "verify@example.com"]);
hostGit(["config", "user.name", "Verify"]);
writeFileSync(join(repo, "README.md"), "seed\n");
hostGit(["add", "-A"]);
hostGit(["commit", "-qm", "seed"]);

interface HostConfig {
  CapDrop: string[] | null;
  CapAdd: string[] | null;
  SecurityOpt: string[] | null;
  PidsLimit: number | null;
  Memory: number;
  ReadonlyRootfs: boolean;
  Tmpfs: Record<string, string> | null;
}

/** Inspect the single running sandbox container spawned from IMAGE. */
const inspectSandboxHostConfig = (): HostConfig => {
  const ids = execFileSync(RUNTIME, [
    "ps",
    "-q",
    "--filter",
    `ancestor=${IMAGE}`,
    "--filter",
    "status=running",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `Expected exactly 1 running container from ${IMAGE}, found ${ids.length}. ` +
        `Stop stray sandbox containers and retry.`,
    );
  }
  const raw = execFileSync(RUNTIME, [
    "inspect",
    "--format",
    "{{json .HostConfig}}",
    ids[0]!,
  ]).toString();
  return JSON.parse(raw) as HostConfig;
};

try {
  // ---- (A) hardened DEFAULTS: applied + functional ----
  const sandboxA = await createSandbox({
    sandbox: docker({ imageName: IMAGE }),
    // PODMAN: sandbox: podman({ imageName: IMAGE }),
    cwd: repo,
    branch: "verify-harden-a",
  });

  try {
    const hc = inspectSandboxHostConfig();
    check(
      "default CapDrop == [ALL]",
      Array.isArray(hc.CapDrop) &&
        hc.CapDrop.length === 1 &&
        hc.CapDrop[0]!.toUpperCase() === "ALL",
      JSON.stringify(hc.CapDrop),
    );
    check(
      "default SecurityOpt includes no-new-privileges",
      (hc.SecurityOpt ?? []).some((o) => o.includes("no-new-privileges")),
      JSON.stringify(hc.SecurityOpt),
    );
    check(
      "default PidsLimit == 2048",
      hc.PidsLimit === 2048,
      String(hc.PidsLimit),
    );
    check(
      "no default Memory ceiling (opt-in)",
      hc.Memory === 0,
      String(hc.Memory),
    );
    check(
      "default ReadonlyRootfs == true",
      hc.ReadonlyRootfs === true,
      String(hc.ReadonlyRootfs),
    );
    const tmpfsPaths = Object.keys(hc.Tmpfs ?? {});
    check(
      "default Tmpfs covers /tmp and ~/.claude (not a blanket /home/agent)",
      tmpfsPaths.includes("/tmp") &&
        tmpfsPaths.includes("/home/agent/.claude") &&
        !tmpfsPaths.includes("/home/agent"),
      JSON.stringify(tmpfsPaths),
    );

    // Functional: a normal agent run must still succeed under the defaults.
    // These writes land on the tmpfs mounts; a write outside them must fail.
    await sandboxA.exec(
      'git config --global --add safe.directory "$(pwd)" && ' +
        "git config --global user.email a@b.c && git config --global user.name A",
    );
    await sandboxA.exec("echo change > work.txt && git add -A");
    const commit = await sandboxA.exec('git commit -qm "agent change"');
    check("commit succeeds", commit.exitCode === 0, commit.stderr.trim());

    const session = await sandboxA.exec(
      'mkdir -p ~/.claude/projects && echo "{}" > ~/.claude/session.json && cat ~/.claude/session.json',
    );
    check(
      "agent session state write (~/.claude) succeeds",
      session.exitCode === 0,
      session.stderr.trim(),
    );

    const npmCache = await sandboxA.exec(
      "mkdir -p ~/.npm/_cacache && echo ok > ~/.npm/_cacache/probe && cat ~/.npm/_cacache/probe",
    );
    check(
      "package-manager cache write (~/.npm) succeeds",
      npmCache.exitCode === 0 && npmCache.stdout.trim() === "ok",
      npmCache.stderr.trim(),
    );

    // `git config --global` writes ~/.gitconfig, a FILE at the read-only home
    // root that no directory tmpfs can cover. Sandcastle runs it at startup
    // (safe.directory + user.name/email), so GIT_CONFIG_GLOBAL must relocate it
    // onto a writable tmpfs. This is exit-checked (unlike the setup above)
    // because a read-only ~/.gitconfig is exactly what broke the live agent run.
    const gitGlobal = await sandboxA.exec(
      "git config --global user.name verify-probe && " +
        "git config --global --get user.name",
    );
    check(
      "git config --global write (~/.gitconfig relocation) succeeds",
      gitGlobal.exitCode === 0 && gitGlobal.stdout.trim() === "verify-probe",
      `exit=${gitGlobal.exitCode} ${gitGlobal.stderr.trim()}`,
    );

    // The read-only rootfs must actually reject a write outside the tmpfs set.
    const rejected = await sandboxA.exec("echo nope > ~/probe-outside-tmpfs");
    check(
      "write outside the tmpfs set is rejected by the read-only rootfs",
      rejected.exitCode !== 0,
      `exit=${rejected.exitCode} ${rejected.stderr.trim()}`,
    );
  } finally {
    await sandboxA.close();
  }

  // ---- (B) OVERRIDES honored ----
  const sandboxB = await createSandbox({
    sandbox: docker({
      imageName: IMAGE,
      hardening: { memory: "6g", pidsLimit: 512, capAdd: ["CHOWN"] },
    }),
    // PODMAN: sandbox: podman({ imageName: IMAGE, hardening: { memory: "6g", pidsLimit: 512, capAdd: ["CHOWN"] } }),
    cwd: repo,
    branch: "verify-harden-b",
  });

  try {
    const hc = inspectSandboxHostConfig();
    check(
      "override Memory == 6g",
      hc.Memory === 6 * 1024 * 1024 * 1024,
      String(hc.Memory),
    );
    check(
      "override PidsLimit == 512",
      hc.PidsLimit === 512,
      String(hc.PidsLimit),
    );
    // The runtime normalizes capability names (e.g. `CHOWN` -> `CAP_CHOWN`);
    // strip the optional `CAP_` prefix before comparing.
    const capName = (c: string) => c.toUpperCase().replace(/^CAP_/, "");
    check(
      "override CapAdd includes CHOWN (drop still ALL)",
      (hc.CapAdd ?? []).some((c) => capName(c) === "CHOWN") &&
        (hc.CapDrop ?? []).some((c) => capName(c) === "ALL"),
      `add=${JSON.stringify(hc.CapAdd)} drop=${JSON.stringify(hc.CapDrop)}`,
    );
  } finally {
    await sandboxB.close();
  }

  // ---- (C) read-only rootfs OPT-OUT ----
  const sandboxC = await createSandbox({
    sandbox: docker({
      imageName: IMAGE,
      hardening: { readOnlyRootfs: false },
    }),
    // PODMAN: sandbox: podman({ imageName: IMAGE, hardening: { readOnlyRootfs: false } }),
    cwd: repo,
    branch: "verify-harden-c",
  });

  try {
    const hc = inspectSandboxHostConfig();
    check(
      "readOnlyRootfs: false → ReadonlyRootfs == false",
      hc.ReadonlyRootfs === false,
      String(hc.ReadonlyRootfs),
    );
    check(
      "readOnlyRootfs: false → no default tmpfs mounts",
      Object.keys(hc.Tmpfs ?? {}).length === 0,
      JSON.stringify(hc.Tmpfs),
    );
    // With the rootfs writable, a write outside the (now absent) tmpfs succeeds.
    const write = await sandboxC.exec(
      "echo ok > ~/probe-writable && cat ~/probe-writable",
    );
    check(
      "with read-only disabled, a home-dir write succeeds",
      write.exitCode === 0 && write.stdout.trim() === "ok",
      write.stderr.trim(),
    );
  } finally {
    await sandboxC.close();
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${pass ? "✅ ALL CHECKS PASSED" : "❌ CHECKS FAILED"}`);
process.exit(pass ? 0 : 1);
