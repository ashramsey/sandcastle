/**
 * Privilege- and resource-hardening flags for the bind-mount container run line
 * (Docker and Podman), applied by default so a subverted agent cannot escalate
 * privilege or DoS the host — without breaking a normal agent run.
 *
 * Every field defaults to a hardened value and is overridable through provider
 * config (mirroring the existing `--cpus` option). The resolver is a pure
 * function so both providers share one source of truth and one test seam.
 */

/** Default set of Linux capabilities dropped at container start. */
export const DEFAULT_CAP_DROP = ["ALL"] as const;

/**
 * Default `--pids-limit`. Generous enough not to throttle parallel builds while
 * still bounding a fork bomb. Overridable per provider; `false` disables it.
 */
export const DEFAULT_PIDS_LIMIT = 2048;

/**
 * Default writable `--tmpfs` mounts paired with the read-only rootfs — exactly
 * the paths a real agent run writes, confirmed against a live Claude Code run.
 *
 * `/tmp` is scratch; `~/.cache`, `~/.config`, `~/.npm` are tool/package-manager
 * state; `~/.claude` holds the agent's own session state (and, via the
 * providers' default `CLAUDE_CONFIG_DIR`, the config that would otherwise be
 * written to the read-only `~/.claude.json`).
 *
 * A blanket `--tmpfs /home/agent` is deliberately avoided: it would shadow the
 * Claude CLI baked into `~/.local` and break `PATH`.
 *
 * Each entry carries `mode=1777` (world-writable + sticky, like `/tmp`). Docker
 * mounts a bare `--tmpfs` root-owned and not writable by the non-root `agent`
 * user (uid 1000), so a real agent run would fail with `mkdir … Permission
 * denied` inside these dirs; `1777` lets uid 1000 create its subtree while the
 * sticky bit and the files' own restrictive modes (e.g. `.credentials.json` at
 * `0600`) keep the state protected in the single-user container.
 */
export const DEFAULT_TMPFS = [
  "/tmp:mode=1777",
  "/home/agent/.cache:mode=1777",
  "/home/agent/.config:mode=1777",
  "/home/agent/.npm:mode=1777",
  "/home/agent/.claude:mode=1777",
] as const;

/**
 * Config FILES that live at the read-only home-dir root and so can't be covered
 * by a directory `--tmpfs`. Each is relocated onto a writable tmpfs via an env
 * var — but only when the tmpfs mount it depends on is actually present (see
 * {@link resolveReadOnlyConfigEnv}).
 */
const READ_ONLY_CONFIG_RELOCATIONS = [
  {
    // Claude writes `~/.claude.json` at the home root; point its config dir at
    // the `~/.claude` tmpfs so the config (incl. `.credentials.json`) lands on a
    // writable mount.
    env: "CLAUDE_CONFIG_DIR",
    value: "/home/agent/.claude",
    tmpfsDir: "/home/agent/.claude",
  },
  {
    // git's `~/.gitconfig` (written by Sandcastle's own `git config --global`
    // for safe.directory + user.name/email). GIT_CONFIG_GLOBAL must name a FILE
    // inside an existing tmpfs mount ROOT because `git config` won't create
    // missing parent dirs.
    env: "GIT_CONFIG_GLOBAL",
    value: "/home/agent/.config/gitconfig",
    tmpfsDir: "/home/agent/.config",
  },
] as const;

/** Directory a `--tmpfs` spec mounts, i.e. the spec with any `:options` suffix stripped. */
const tmpfsMountDir = (spec: string): string => {
  const colon = spec.indexOf(":");
  return colon === -1 ? spec : spec.slice(0, colon);
};

export interface RunHardeningOptions {
  /**
   * Linux capabilities to drop, via `--cap-drop`.
   *
   * Defaults to `["ALL"]` — the stock image needs none. Pass a different set to
   * replace the default, or `[]` to drop nothing (add back only what a real run
   * needs via {@link capAdd}).
   */
  readonly capDrop?: readonly string[];
  /**
   * Linux capabilities to add back after the drop, via `--cap-add`.
   *
   * Defaults to none. Use to grant back a specific capability a workload needs
   * (e.g. `["NET_BIND_SERVICE"]`) while keeping `--cap-drop=ALL`.
   */
  readonly capAdd?: readonly string[];
  /**
   * Set `--security-opt no-new-privileges`, blocking setuid-based privilege
   * escalation inside the container. Defaults to `true`; pass `false` to omit.
   */
  readonly noNewPrivileges?: boolean;
  /**
   * Bound the number of PIDs (tasks) via `--pids-limit`, protecting the host
   * from fork bombs. Defaults to {@link DEFAULT_PIDS_LIMIT}. Pass a number to
   * override, or `false` to remove the limit entirely.
   */
  readonly pidsLimit?: number | false;
  /**
   * Cap container memory via `--memory` (e.g. `"8g"`, `"512m"`).
   *
   * No default — omitted unless set — so a legitimate heavy build is never
   * OOM-killed by a fixed limit that can't fit every host. Opt in when you want
   * a ceiling.
   */
  readonly memory?: string;
  /**
   * Mount the container root filesystem read-only via `--read-only`, so a
   * subverted agent cannot tamper with the baked-in tooling/binaries (the
   * Claude CLI, system libraries) mid-run. Writable scratch space is supplied
   * by {@link tmpfs} and by the bind-mounted worktree, which stay writable.
   *
   * Defaults to `true`; pass `false` to omit the flag (and, unless {@link tmpfs}
   * is set explicitly, the default tmpfs mounts too — they exist only to make a
   * read-only rootfs usable).
   */
  readonly readOnlyRootfs?: boolean;
  /**
   * Writable in-memory scratch paths mounted via `--tmpfs`, needed because the
   * root filesystem is read-only (see {@link readOnlyRootfs}). Each entry is a
   * raw `--tmpfs` spec — `"/path"` or `"/path:opts"` (e.g. `"/tmp:exec"`).
   *
   * Defaults to {@link DEFAULT_TMPFS} when the rootfs is read-only. Pass a
   * different array to replace the set, or `[]` to mount no tmpfs. When
   * `readOnlyRootfs` is `false` and this is unset, no tmpfs is emitted.
   *
   * NOTE: `--tmpfs` mounts directories only, so config FILES at the home-dir
   * root (which a read-only rootfs blocks) can't be covered this way. The
   * Docker/Podman providers therefore relocate them via env: `CLAUDE_CONFIG_DIR`
   * -> `~/.claude` (for `~/.claude.json`) and `GIT_CONFIG_GLOBAL` -> a file in
   * `~/.config` (for `~/.gitconfig`, written by Sandcastle's `git config
   * --global` setup) — both landing on a writable tmpfs mount. That relocation
   * follows this set: it is only applied for a file whose backing tmpfs dir
   * (`~/.claude`, `~/.config`) is actually mounted here, so if you replace this
   * array you must keep those dirs (or point the agent's config elsewhere via
   * env) or the agent's config/git writes will hit the read-only rootfs.
   */
  readonly tmpfs?: readonly string[];
}

/**
 * The effective `--tmpfs` set for these options: the caller's explicit `tmpfs`
 * when set, otherwise {@link DEFAULT_TMPFS} under a read-only rootfs (and
 * nothing when the rootfs is writable, since the default set exists only to make
 * a read-only rootfs usable). Single source of truth shared by
 * {@link resolveHardeningFlags} and {@link resolveReadOnlyConfigEnv}.
 */
export const resolveTmpfs = (
  options?: RunHardeningOptions,
): readonly string[] => {
  const readOnlyRootfs = options?.readOnlyRootfs ?? true;
  return options?.tmpfs ?? (readOnlyRootfs ? DEFAULT_TMPFS : []);
};

/**
 * Env that relocates the home-root config FILES onto writable tmpfs under a
 * read-only rootfs. Emitted per file ONLY when the tmpfs mount that file depends
 * on is actually in the resolved {@link resolveTmpfs} set — so a caller who
 * replaces `tmpfs` and drops `~/.claude` / `~/.config` does not get an env var
 * left pointing config at a now-read-only path (the relocation follows the
 * tmpfs, instead of being keyed on `readOnlyRootfs` alone). Empty when the
 * rootfs is writable.
 *
 * The Docker/Podman providers spread this BEFORE the caller's `env`, so a
 * caller-set `CLAUDE_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` always wins.
 */
export const resolveReadOnlyConfigEnv = (
  options?: RunHardeningOptions,
): Record<string, string> => {
  const readOnlyRootfs = options?.readOnlyRootfs ?? true;
  if (!readOnlyRootfs) return {};
  const mountDirs = new Set(resolveTmpfs(options).map(tmpfsMountDir));
  const env: Record<string, string> = {};
  for (const { env: key, value, tmpfsDir } of READ_ONLY_CONFIG_RELOCATIONS) {
    if (mountDirs.has(tmpfsDir)) env[key] = value;
  }
  return env;
};

/**
 * Resolve the hardened run-line flags into a flat `run` argument array,
 * applying the hardened default for every unset field.
 */
export const resolveHardeningFlags = (
  options?: RunHardeningOptions,
): string[] => {
  const capDrop = options?.capDrop ?? DEFAULT_CAP_DROP;
  const capAdd = options?.capAdd ?? [];
  const noNewPrivileges = options?.noNewPrivileges ?? true;
  const pidsLimit = options?.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const readOnlyRootfs = options?.readOnlyRootfs ?? true;
  const tmpfs = resolveTmpfs(options);

  const flags: string[] = [];
  for (const cap of capDrop) flags.push("--cap-drop", cap);
  for (const cap of capAdd) flags.push("--cap-add", cap);
  if (noNewPrivileges) flags.push("--security-opt", "no-new-privileges");
  if (pidsLimit !== false) flags.push("--pids-limit", String(pidsLimit));
  if (options?.memory !== undefined) flags.push("--memory", options.memory);
  if (readOnlyRootfs) flags.push("--read-only");
  for (const path of tmpfs) flags.push("--tmpfs", path);
  return flags;
};
