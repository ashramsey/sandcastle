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
}

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

  const flags: string[] = [];
  for (const cap of capDrop) flags.push("--cap-drop", cap);
  for (const cap of capAdd) flags.push("--cap-add", cap);
  if (noNewPrivileges) flags.push("--security-opt", "no-new-privileges");
  if (pidsLimit !== false) flags.push("--pids-limit", String(pidsLimit));
  if (options?.memory !== undefined) flags.push("--memory", options.memory);
  return flags;
};
