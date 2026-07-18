import { exec } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_GIT_CONFIG_WRITES_ENV,
  gitConfigHardeningEnabled,
} from "./SandboxFactory.js";

const execAsync = promisify(exec);

describe("gitConfigHardeningEnabled", () => {
  it("is hardened by default (env unset)", () => {
    expect(gitConfigHardeningEnabled({})).toBe(true);
  });

  it.each(["1", "true", "yes", "on", "TRUE", " on "])(
    "opts out when %s is set to a truthy value",
    (value) => {
      expect(
        gitConfigHardeningEnabled({ [ALLOW_GIT_CONFIG_WRITES_ENV]: value }),
      ).toBe(false);
    },
  );

  it.each(["0", "false", "no", "", "off", "nope"])(
    "stays hardened for non-truthy value %s",
    (value) => {
      expect(
        gitConfigHardeningEnabled({ [ALLOW_GIT_CONFIG_WRITES_ENV]: value }),
      ).toBe(true);
    },
  );
});

/**
 * Behavioral proof against real git in a temp repo (no Docker). Ticket
 * harden/git-config-injection-vector (F1 follow-up) closes a host-code-execution
 * vector: an agent that can write the bind-mounted `.git/config` can plant
 * entries (`core.hooksPath`, an executable `alias.* = !cmd`, …) that execute as
 * the developer when they later run git *manually* on the host. The fix mounts
 * `.git/config` read-only.
 *
 * The read-only *enforcement* is a bind mount and can only be verified under
 * Docker/Podman (see the ticket's end-to-end criterion). What these tests lock
 * down without Docker is (a) that the vector is REAL — planted config entries
 * genuinely execute under a plain host `git` — so the mitigation is not vacuous;
 * (b) that a normal commit does NOT write `.git/config`, so the read-only mount
 * preserves the agent's ability to commit; and (c) that file permissions alone
 * are insufficient (justifying the mount over a `chmod`).
 */
describe("git .git/config injection vector (behavioral)", () => {
  const dirs: string[] = [];

  const makeRepo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-config-inject-test-"));
    dirs.push(dir);
    // Pin global config to /dev/null so only the repo-local .git/config is in
    // play — the whole point of the vector.
    const git = (args: string) =>
      execAsync(`git ${args}`, {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    await git("init -b main");
    await git('config user.email "test@example.com"');
    await git('config user.name "Test"');
    await writeFile(join(dir, "a.txt"), "a\n");
    await git("add -A");
    await git('commit -m "base"');
    return { dir, git };
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
  // full-suite parallel load, can be CPU-starved well past vitest's 5s default.
  it(
    "an executable alias planted in .git/config runs under plain host git (positive control)",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      const sentinel = join(dir, "PWNED");

      // The agent writes an executable alias into .git/config.
      await git(`config alias.pwned "!touch '${sentinel}'"`);

      // The developer later runs the aliased command manually on the host: it
      // executes the planted command as the developer. This is the vector the
      // read-only mount closes by preventing the write in the first place.
      await git("pwned");
      expect(await fired(sentinel)).toBe(true);
    },
  );

  it(
    "a core.hooksPath planted in .git/config fires a hook under plain host git (positive control)",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      const sentinel = join(dir, "HOOK_FIRED");

      // Point hooks at an agent-controlled dir and drop a post-commit hook there.
      const evilHooks = join(dir, "evil-hooks");
      await mkdir(evilHooks);
      const hook = join(evilHooks, "post-commit");
      await writeFile(hook, `#!/bin/sh\ntouch '${sentinel}'\n`);
      await chmod(hook, 0o755);
      await git(`config core.hooksPath "${evilHooks}"`);

      // A later manual commit on the host fires the planted hook.
      await writeFile(join(dir, "b.txt"), "b\n");
      await git("add -A");
      await git('commit -m "second"');
      expect(await fired(sentinel)).toBe(true);
    },
  );

  it(
    "a normal commit does not write .git/config, so a read-only config preserves commits",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      const configPath = join(dir, ".git", "config");
      const before = await readFile(configPath);

      // Identity lives in the (here repo-local) config, which is only READ; the
      // commit writes objects/refs, not config.
      await writeFile(join(dir, "c.txt"), "c\n");
      await git("add -A");
      await git('commit -m "third"');

      const after = await readFile(configPath);
      expect(after.equals(before)).toBe(true);
    },
  );

  it(
    "chmod 0444 does NOT stop a config write — git renames config.lock over it (mount, not perms, is required)",
    { timeout: 60_000 },
    async () => {
      const { dir, git } = await makeRepo();
      const configPath = join(dir, ".git", "config");

      // Make the file itself read-only. git writes config atomically via a
      // `config.lock` sibling + rename(), which needs only *directory* write
      // permission — so the write still lands. This is exactly why the fix uses
      // a bind mountpoint (rename onto it fails) rather than file permissions.
      await chmod(configPath, 0o444);
      await git('config alias.pwned "!true"');

      const { stdout } = await git("config --get alias.pwned");
      expect(stdout.trim()).toBe("!true");
    },
  );
});
