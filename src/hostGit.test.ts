import { exec } from "node:child_process";
import { mkdtemp, writeFile, rm, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_NEUTRALIZE_FLAGS, neutralizeHostGitCommand } from "./hostGit.js";

const execAsync = promisify(exec);

describe("neutralizeHostGitCommand", () => {
  it("prepends hook/fsmonitor neutralization flags after `git`", () => {
    expect(neutralizeHostGitCommand('merge "topic"')).toBe(
      'git -c core.hooksPath=/dev/null -c core.fsmonitor= merge "topic"',
    );
  });

  it("HOOK_NEUTRALIZE_FLAGS disables hooks and fsmonitor", () => {
    expect(HOOK_NEUTRALIZE_FLAGS).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=",
    ]);
  });
});

/**
 * Behavioral proof against real git in a temp repo (no Docker). Each case runs
 * the *same* git operation twice: once through plain git (the positive control,
 * which MUST fire the planted hook — otherwise the test is vacuous) and once
 * through the neutralized command (which must NOT fire it).
 */
describe("host-side git hook neutralization (behavioral)", () => {
  const dirs: string[] = [];

  const makeRepo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-git-hook-test-"));
    dirs.push(dir);
    const git = (args: string) =>
      execAsync(`git ${args}`, {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    await git("init -b main");
    await git('config user.email "test@example.com"');
    await git('config user.name "Test"');
    return { dir, git };
  };

  /** Plant an executable repo hook that touches `sentinel` when it fires. */
  const plantHook = async (dir: string, hook: string, sentinel: string) => {
    const hookPath = join(dir, ".git", "hooks", hook);
    await writeFile(hookPath, `#!/bin/sh\ntouch '${sentinel}'\n`);
    await chmod(hookPath, 0o755);
  };

  const fired = async (sentinel: string) =>
    access(sentinel).then(
      () => true,
      () => false,
    );

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  // Generous timeout: these spawn several real git subprocesses and, under
  // full-suite parallel load, can be CPU-starved to ~20s+ — well past vitest's
  // 5s default. The assertions are deterministic; only the wall-clock varies.
  it(
    "post-merge fires under plain git but NOT under neutralized git",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      await writeFile(join(dir, "a.txt"), "a\n");
      await git("add -A");
      await git('commit -m "base"');
      await git("checkout -b topic");
      await writeFile(join(dir, "b.txt"), "b\n");
      await git("add -A");
      await git('commit -m "topic"');
      await git("checkout main");

      const sentinel = join(dir, "HOOK_FIRED");
      await plantHook(dir, "post-merge", sentinel);

      // Positive control: plain git must fire the hook.
      await execAsync("git merge --no-ff topic --no-edit", {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(await fired(sentinel)).toBe(true);

      // Reset and prove the neutralized command does NOT fire it.
      await rm(sentinel, { force: true });
      await git("reset --hard HEAD~1");
      await execAsync(
        neutralizeHostGitCommand("merge --no-ff topic --no-edit"),
        {
          cwd: dir,
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
        },
      );
      expect(await fired(sentinel)).toBe(false);
    },
  );

  it(
    "post-checkout fires under plain git but NOT under neutralized git",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      await writeFile(join(dir, "a.txt"), "a\n");
      await git("add -A");
      await git('commit -m "base"');
      await git("branch other");

      const sentinel = join(dir, "HOOK_FIRED");
      await plantHook(dir, "post-checkout", sentinel);

      // Positive control.
      await execAsync("git checkout other", {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(await fired(sentinel)).toBe(true);

      await rm(sentinel, { force: true });
      await execAsync(neutralizeHostGitCommand("checkout main"), {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(await fired(sentinel)).toBe(false);
    },
  );
});
