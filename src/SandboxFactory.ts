import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { join, resolve } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import {
  AgentError,
  AgentIdleTimeoutError,
  CopyError,
  ExecError,
  SyncError,
  WorktreeError,
  type DockerError,
  type SandboxError,
} from "./errors.js";
import type { Timeouts } from "./run.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { runHostHooks, type SandboxHooks } from "./SandboxLifecycle.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import { patchGitMountsForWindows } from "./mountUtils.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

const getCopyIn = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService["copyIn"] => {
  if ("copyIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as IsolatedSandboxHandle).copyIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  if ("copyFileIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as BindMountSandboxHandle).copyFileIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyFileIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  return () =>
    Effect.fail(
      new CopyError({
        message: "copyIn is not supported for this sandbox provider",
      }),
    );
};

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService.
 * Delegates copyIn/copyFileOut to the handle when available.
 */
export const makeSandboxFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: getCopyIn(handle),
  copyFileOut:
    "copyFileOut" in handle
      ? (sandboxPath, hostPath) =>
          Effect.tryPromise({
            try: () =>
              (
                handle as IsolatedSandboxHandle | BindMountSandboxHandle
              ).copyFileOut(sandboxPath, hostPath),
            catch: (e) =>
              new CopyError({
                message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
      : () =>
          Effect.fail(
            new CopyError({
              message: "copyFileOut is not supported for this sandbox provider",
            }),
          ),
});

/** The mount point inside the sandbox where the project worktree is bound. */
export const SANDBOX_REPO_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree/branch mode only). */
  readonly hostWorktreePath?: string;
  /** Absolute path to the worktree inside the sandbox, as reported by the provider. */
  readonly sandboxRepoPath: string;
  /** Sync changes from the sandbox to the host worktree (isolated providers only). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
  /** The bind-mount sandbox handle, available when the provider is a bind-mount provider. Used for session capture. */
  readonly bindMountHandle?: BindMountSandboxHandle;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<WithSandboxResult<A>, E | SandboxError, R>;
  }
>() {}

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** AbortSignal threaded to lifecycle hooks so they can cooperatively cancel. */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. */
    readonly timeouts?: Timeouts;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and cleanup instructions.
 */
const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<string | undefined, WorktreeError> =>
  WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      return WorktreeManager.remove(worktreePath).pipe(
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );

/**
 * Attach the preserved worktree path to AgentIdleTimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree.
 */
const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | SandboxError,
): E | SandboxError => {
  if (path !== undefined) {
    if (e instanceof AgentIdleTimeoutError) {
      return new AgentIdleTimeoutError({
        message: e.message,
        timeoutMs: e.timeoutMs,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
  }
  return e;
};

export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
  /** Mount as read-only. Defaults to `false`. */
  readonly readonly?: boolean;
}

/**
 * Environment variable that opts a run out of the read-only `.git/config`
 * hardening (ticket harden/git-config-injection-vector, F1 follow-up). Set it to
 * a truthy value (`1`, `true`, `yes`, `on`) for a *trusted* workflow that needs
 * to write repo-local git config from inside the sandbox — `git remote add`,
 * `git config --local`, or tracking-branch creation (`git push -u`,
 * `git checkout --track`). Unset (the default) keeps `.git/config` read-only.
 */
export const ALLOW_GIT_CONFIG_WRITES_ENV = "SANDCASTLE_ALLOW_GIT_CONFIG_WRITES";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the read-only `.git/config` hardening is active for this process.
 * Hardened by default; disabled only when {@link ALLOW_GIT_CONFIG_WRITES_ENV} is
 * set to a truthy value. Exported (and env-injectable) so the mount resolution
 * is unit-testable without mutating `process.env`.
 */
export const gitConfigHardeningEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  !TRUTHY_ENV_VALUES.has(
    (env[ALLOW_GIT_CONFIG_WRITES_ENV] ?? "").trim().toLowerCase(),
  );

/**
 * Resolves the git-related mounts needed for the sandbox.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 *
 * @param hardenGitConfig - When true (the default, gated by
 *   {@link gitConfigHardeningEnabled}), layer a read-only mount over
 *   `<gitDir>/config` so a prompt-injected agent cannot write code-executing
 *   entries there. Trusted workflows opt out via
 *   {@link ALLOW_GIT_CONFIG_WRITES_ENV}.
 */
export const resolveGitMounts = (
  gitPath: string,
  hardenGitConfig: boolean = gitConfigHardeningEnabled(),
): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // A read-only bind mount of `<gitDir>/hooks` layered over the writable git
    // dir, so a prompt-injected agent cannot drop a hook script that later runs
    // on the host (ticket harden/git-hook-host-execution, F1). The parent git
    // dir stays writable so the agent can still commit (objects/refs); only
    // `hooks/` is locked down. Returned only when the hooks dir exists, so a repo
    // without one doesn't fail with a missing bind-mount source.
    const hooksMount = (
      gitDir: string,
    ): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const hooksPath = join(gitDir, "hooks");
        const exists = yield* fs.exists(hooksPath);
        return exists
          ? [{ hostPath: hooksPath, sandboxPath: hooksPath, readonly: true }]
          : [];
      });

    // A read-only bind mount of `<gitDir>/config`, closing the sibling of the
    // hooks vector (ticket harden/git-config-injection-vector, F1 follow-up).
    // Every exec-capable git mechanism's *command* lives in config —
    // `core.hooksPath` / `core.fsmonitor`, an executable `alias.* = !cmd`, an
    // external diff/merge/filter driver, `credential.helper`, `core.pager`,
    // `sequence.editor`, and the `extensions.worktreeConfig` escalation. h01
    // neutralizes these for sandcastle's *own* host git, but the developer's
    // later *manual* `git` still reads `.git/config` and runs them as the
    // developer. Locking the file read-only prevents the write entirely.
    //
    // File permissions alone do NOT suffice: git rewrites config via a
    // `config.lock` + rename() over the file, which needs only *directory* write
    // permission, so a `chmod 0444` config is still replaced. A bind mount makes
    // the path a mountpoint, so the rename() fails (EBUSY/EXDEV) and the write is
    // rejected loudly. Commits are unaffected — they touch objects/refs, not
    // config, and identity comes from `--global` config in the sandbox home.
    // Gated by `hardenGitConfig` so trusted workflows can opt out. Returned only
    // when the config file exists, so a bare git dir doesn't fail with a missing
    // bind-mount source.
    const configMount = (
      gitDir: string,
    ): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        if (!hardenGitConfig) return [];
        const configPath = join(gitDir, "config");
        const exists = yield* fs.exists(configPath);
        return exists
          ? [{ hostPath: configPath, sandboxPath: configPath, readonly: true }]
          : [];
      });

    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [
        { hostPath: gitPath, sandboxPath: gitPath },
        ...(yield* hooksMount(gitPath)),
        ...(yield* configMount(gitPath)),
      ];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      // Unrecognized format — fall back to mounting the file as-is
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    const gitdirPath = match[1]!;
    // gitdirPath is like /path/to/repo/.git/worktrees/<name>
    // Mount both the .git file and the parent .git directory. The shared
    // `config` lives in the parent git dir (worktrees inherit it), so harden it
    // there.
    const parentGitDir = resolve(gitdirPath, "..", "..");
    return [
      { hostPath: gitPath, sandboxPath: gitPath },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
      ...(yield* hooksMount(parentGitDir)),
      ...(yield* configMount(parentGitDir)),
    ];
  });

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        copyToWorktree: copyPaths,
        name,
        sandboxProvider,
        branchStrategy,
        hooks,
        signal,
        timeouts,
      } = yield* SandboxConfig;

      const isHeadMode = branchStrategy.type === "head";
      const branch =
        branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
      const baseBranch =
        branchStrategy.type === "branch"
          ? branchStrategy.baseBranch
          : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;

      /** Prune stale worktrees (best-effort), then create a fresh one. */
      const pruneAndCreate = () =>
        WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                "[sandcastle] Warning: failed to prune stale worktrees:",
                e.message,
              );
            }),
          ),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, { branch, baseBranch })
              : WorktreeManager.create(hostRepoDir, { name }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (
            info: SandboxInfo,
            sandbox: SandboxService,
          ) => Effect.Effect<A, E, R>,
        ): Effect.Effect<WithSandboxResult<A>, E | SandboxError, R> => {
          // No-sandbox providers: run directly on the host, no container or mounts.
          if (sandboxProvider.tag === "none") {
            let preservedPath: string | undefined;

            // Head mode: use hostRepoDir directly, no worktree.
            if (isHeadMode) {
              return (
                hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      hostRepoDir,
                      signal,
                    )
                  : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.acquireUseRelease(
                    startSandbox({
                      provider: sandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: hostRepoDir,
                    }),
                    ({ sandbox, worktreePath }) =>
                      makeEffect(
                        {
                          hostWorktreePath: hostRepoDir,
                          sandboxRepoPath: worktreePath,
                        },
                        sandbox,
                      ) as Effect.Effect<A, E | SandboxError, R>,
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ).pipe(
                    Effect.map((value) => ({
                      value,
                      preservedWorktreePath: undefined,
                    })),
                  ),
                ),
              );
            }

            // Worktree mode (merge-to-head or explicit branch).
            // Nested so the worktree is always cleaned up (outer release) even
            // when copying, hooks, or sandbox start fail. The provider handle is
            // closed by the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              (worktreeInfo) =>
                (copyPaths && copyPaths.length > 0
                  ? display.spinner(
                      "Copying to worktree",
                      copyToWorktree(
                        copyPaths,
                        hostRepoDir,
                        worktreeInfo.path,
                        timeouts?.copyToWorktreeMs,
                      ),
                    )
                  : Effect.succeed(undefined)
                ).pipe(
                  Effect.andThen(
                    hooks?.host?.onWorktreeReady?.length
                      ? runHostHooks(
                          hooks.host.onWorktreeReady,
                          worktreeInfo.path,
                          signal,
                        )
                      : Effect.void,
                  ),
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir,
                        env,
                        worktreeOrRepoPath: worktreeInfo.path,
                      }),
                      ({ sandbox, worktreePath }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              (worktreeInfo, exit) =>
                cleanupWorktree(worktreeInfo.path, exit).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          // Isolated providers: create worktree, sync via git bundle
          if (sandboxProvider.tag === "isolated") {
            let preservedPath: string | undefined;

            // Nested so the worktree is always cleaned up (outer release) even
            // when hooks or sandbox start fail. The provider handle is closed by
            // the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              (worktreeInfo) =>
                (hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      worktreeInfo.path,
                      signal,
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir: worktreeInfo.path,
                        env,
                        copyPaths,
                      }),
                      ({ sandbox, worktreePath, handle }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                            applyToHost: () =>
                              syncOut(
                                worktreeInfo.path,
                                handle as IsolatedSandboxHandle,
                              ),
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              (worktreeInfo, exit) =>
                cleanupWorktree(worktreeInfo.path, exit).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          if (isHeadMode) {
            // Head mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return (
              hooks?.host?.onWorktreeReady?.length
                ? runHostHooks(hooks.host.onWorktreeReady, hostRepoDir, signal)
                : Effect.void
            ).pipe(
              Effect.andThen(resolveGitMounts(gitPath)),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${e}`,
                  }) as E | SandboxError,
              ),
              Effect.flatMap((gitMounts) =>
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                patchGitMountsForWindows(
                  gitMounts,
                  hostRepoDir,
                  SANDBOX_REPO_DIR,
                ),
              ),
              Effect.flatMap((gitMounts) =>
                Effect.acquireUseRelease(
                  startSandbox({
                    provider: sandboxProvider,
                    hostRepoDir,
                    env,
                    worktreeOrRepoPath: hostRepoDir,
                    gitMounts,
                    repoDir: SANDBOX_REPO_DIR,
                  }),
                  // Use
                  ({ sandbox, worktreePath, handle }) =>
                    makeEffect(
                      {
                        hostWorktreePath: hostRepoDir,
                        sandboxRepoPath: worktreePath,
                        bindMountHandle: handle as BindMountSandboxHandle,
                      },
                      sandbox,
                    ) as Effect.Effect<A, E | SandboxError, R>,
                  // Release
                  ({ handle }) =>
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }).pipe(Effect.orDie),
                ).pipe(
                  Effect.map((value) => ({
                    value,
                    preservedWorktreePath: undefined,
                  })),
                ),
              ),
            );
          }

          // Worktree mode (merge-to-head or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          // Worktree creation and sandbox start are nested so the worktree is
          // always cleaned up (outer release) even when a later step — copying,
          // hooks, or sandbox start — fails. The provider handle is closed by the
          // inner release, which only runs once the handle exists.
          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), then create the worktree.
            pruneAndCreate(),
            // Use: copy files, run host hooks, resolve+patch git mounts, then start
            // the sandbox under a nested acquireUseRelease.
            (worktreeInfo) =>
              (copyPaths && copyPaths.length > 0
                ? display.spinner(
                    "Copying to worktree",
                    copyToWorktree(
                      copyPaths,
                      hostRepoDir,
                      worktreeInfo.path,
                      timeouts?.copyToWorktreeMs,
                    ),
                  )
                : Effect.succeed(undefined)
              ).pipe(
                Effect.andThen(
                  hooks?.host?.onWorktreeReady?.length
                    ? runHostHooks(
                        hooks.host.onWorktreeReady,
                        worktreeInfo.path,
                        signal,
                      )
                    : Effect.void,
                ),
                Effect.andThen(
                  resolveGitMounts(join(hostRepoDir, ".git")).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.mapError(
                      (e) =>
                        new WorktreeError({
                          message: `Failed to resolve git mounts: ${e}`,
                        }),
                    ),
                  ),
                ),
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                Effect.flatMap((gitMounts) =>
                  patchGitMountsForWindows(
                    gitMounts,
                    worktreeInfo.path,
                    SANDBOX_REPO_DIR,
                  ),
                ),
                Effect.flatMap((gitMounts) =>
                  Effect.acquireUseRelease(
                    // sandboxProvider is guaranteed bind-mount here
                    // (isolated providers return early above)
                    startSandbox({
                      provider: sandboxProvider as BindMountSandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: worktreeInfo.path,
                      gitMounts,
                      repoDir: SANDBOX_REPO_DIR,
                    }),
                    ({ sandbox, worktreePath, handle }) =>
                      makeEffect(
                        {
                          hostWorktreePath: worktreeInfo.path,
                          sandboxRepoPath: worktreePath,
                          bindMountHandle: handle as BindMountSandboxHandle,
                        },
                        sandbox,
                      ),
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ),
                ),
              ) as Effect.Effect<A, E | SandboxError, R>,
            // Release: remove or preserve the worktree based on dirty state.
            (worktreeInfo, exit) =>
              cleanupWorktree(worktreeInfo.path, exit).pipe(
                Effect.tap((p) => {
                  preservedWorktreePath = p;
                }),
                Effect.asVoid,
                Effect.orDie,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath,
            })),
            Effect.mapError((e: E | SandboxError) =>
              attachPreservedPath(preservedWorktreePath, e),
            ),
          );
        },
      };
    }),
  ),
};
