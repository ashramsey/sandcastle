import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitMounts } from "./SandboxFactory.js";

describe("resolveGitMounts", () => {
  const dirs: string[] = [];

  const makeTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-mount-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  // Default `hardenGitConfig` is env-gated (SANDCASTLE_ALLOW_GIT_CONFIG_WRITES);
  // pass the flag explicitly so these cases are independent of the ambient env.
  const run = (gitPath: string, hardenGitConfig = true) =>
    Effect.runPromise(
      resolveGitMounts(gitPath, hardenGitConfig).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );

  it("returns git dir + read-only hooks and config mounts when .git is a directory", async () => {
    const repoDir = await makeTempDir();
    const gitDir = join(repoDir, ".git");
    await mkdir(gitDir);
    const hooksDir = join(gitDir, "hooks");
    await mkdir(hooksDir);
    const configFile = join(gitDir, "config");
    await writeFile(configFile, "[core]\n");

    const mounts = await run(gitDir);

    expect(mounts).toEqual([
      { hostPath: gitDir, sandboxPath: gitDir },
      { hostPath: hooksDir, sandboxPath: hooksDir, readonly: true },
      { hostPath: configFile, sandboxPath: configFile, readonly: true },
    ]);
  });

  it("omits the config mount when hardenGitConfig is false (trusted opt-out)", async () => {
    const repoDir = await makeTempDir();
    const gitDir = join(repoDir, ".git");
    await mkdir(gitDir);
    const hooksDir = join(gitDir, "hooks");
    await mkdir(hooksDir);
    await writeFile(join(gitDir, "config"), "[core]\n");

    const mounts = await run(gitDir, false);

    expect(mounts).toEqual([
      { hostPath: gitDir, sandboxPath: gitDir },
      { hostPath: hooksDir, sandboxPath: hooksDir, readonly: true },
    ]);
  });

  it("omits the hooks and config mounts when neither exists", async () => {
    const repoDir = await makeTempDir();
    const gitDir = join(repoDir, ".git");
    await mkdir(gitDir);

    const mounts = await run(gitDir);

    expect(mounts).toEqual([{ hostPath: gitDir, sandboxPath: gitDir }]);
  });

  it("returns parent git + read-only hooks and config mounts when .git is a worktree file", async () => {
    const parentRepoDir = await makeTempDir();
    const parentGitDir = join(parentRepoDir, ".git");
    await mkdir(parentGitDir);
    await mkdir(join(parentGitDir, "worktrees", "my-worktree"), {
      recursive: true,
    });

    const hooksDir = join(parentGitDir, "hooks");
    await mkdir(hooksDir);
    const configFile = join(parentGitDir, "config");
    await writeFile(configFile, "[core]\n");

    const worktreeDir = await makeTempDir();
    const gitFile = join(worktreeDir, ".git");
    await writeFile(gitFile, `gitdir: ${parentGitDir}/worktrees/my-worktree\n`);

    const mounts = await run(gitFile);

    expect(mounts).toEqual([
      { hostPath: gitFile, sandboxPath: gitFile },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
      { hostPath: hooksDir, sandboxPath: hooksDir, readonly: true },
      { hostPath: configFile, sandboxPath: configFile, readonly: true },
    ]);
  });

  it("falls back to single mount when .git file has unexpected content", async () => {
    const dir = await makeTempDir();
    const gitFile = join(dir, ".git");
    await writeFile(gitFile, "something unexpected\n");

    const mounts = await run(gitFile);

    expect(mounts).toEqual([{ hostPath: gitFile, sandboxPath: gitFile }]);
  });
});
