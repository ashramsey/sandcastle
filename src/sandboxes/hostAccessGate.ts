/**
 * Gate for the opt-in escape hatches that can grant a sandboxed agent
 * host-level access (h06, F2).
 *
 * The bind-mount providers expose a few options that, by design, punch a hole
 * in the container boundary — host networking (`network: "host"`), extra host
 * groups (`--group-add`), host devices (`--device`), and mounting the
 * container-runtime socket (Docker-outside-of-Docker). These are legitimate
 * features (GPU access, DooD), so they are **gated, not removed**: enabling one
 * is a deliberate two-key action requiring `allowDangerousHostAccess: true`.
 * Without the acknowledgment the provider throws at construction, so a
 * prompt-injected agent can never reach the host through an option the operator
 * set by accident.
 */

import type { MountConfig } from "../MountConfig.js";

/** The subset of provider options this gate inspects. */
export interface HostAccessOptions {
  readonly network?: string | readonly string[];
  readonly groups?: readonly (string | number)[];
  readonly devices?: readonly string[];
  readonly mounts?: readonly MountConfig[];
  /**
   * Explicit acknowledgment that the configured escape hatch(es) grant the
   * agent host-level access. Required for any dangerous option to take effect.
   */
  readonly allowDangerousHostAccess?: boolean;
}

/** Basenames of the container-runtime control sockets. Mounting either in
 * hands the agent control of the host daemon — equivalent to host root. */
const RUNTIME_SOCKET_BASENAMES = new Set(["docker.sock", "podman.sock"]);

const basename = (p: string): string => p.split("/").pop() ?? p;

/** Whether a mount targets a container-runtime control socket on either side. */
const isRuntimeSocketMount = (m: MountConfig): boolean =>
  RUNTIME_SOCKET_BASENAMES.has(basename(m.hostPath)) ||
  RUNTIME_SOCKET_BASENAMES.has(basename(m.sandboxPath));

/** Whether `network` shares the host's network namespace (`network: "host"`). */
const networkSharesHost = (network: HostAccessOptions["network"]): boolean => {
  const nets =
    network === undefined ? [] : Array.isArray(network) ? network : [network];
  return nets.includes("host");
};

/** Mounts in `options` that target a container-runtime socket. */
const socketMountsOf = (options: HostAccessOptions): readonly MountConfig[] =>
  (options.mounts ?? []).filter(isRuntimeSocketMount);

/**
 * Human-readable descriptions of every host-access escape hatch configured in
 * `options`. Empty when the options are benign. Only `network: "host"` counts —
 * a custom/proxy network or `network: "none"` is not a host-access hatch (it is
 * the very lever used to *restrict* egress, see h03).
 */
export const collectHostAccessHatches = (
  options: HostAccessOptions,
): string[] => {
  const hatches: string[] = [];
  if (networkSharesHost(options.network)) {
    hatches.push('network: "host" — shares the host network namespace');
  }
  if ((options.groups ?? []).length > 0) {
    hatches.push("groups — adds the agent to host groups via --group-add");
  }
  if ((options.devices ?? []).length > 0) {
    hatches.push("devices — exposes host devices via --device");
  }
  if (socketMountsOf(options).length > 0) {
    hatches.push(
      "a container-runtime socket mount — Docker/Podman socket, host-root-equivalent control",
    );
  }
  return hatches;
};

/**
 * Enforce the host-access gate for a provider's options.
 *
 * Throws when a dangerous option is configured without
 * `allowDangerousHostAccess: true`. When the hatches are acknowledged (or none
 * are set), returns normally — but still emits a loud runtime warning if the
 * container-runtime socket is mounted, since that is the most dangerous hatch
 * and worth flagging on every run even when deliberate.
 *
 * @param providerLabel provider name for error/warning prefixes, e.g. `"docker"`.
 */
export const assertHostAccessAcknowledged = (
  providerLabel: string,
  options: HostAccessOptions,
): void => {
  const hatches = collectHostAccessHatches(options);

  if (hatches.length > 0 && options.allowDangerousHostAccess !== true) {
    throw new Error(
      `${providerLabel}(): the following option(s) grant the agent host-level access:\n` +
        hatches.map((h) => `  - ${h}`).join("\n") +
        `\n\nThese are deliberate escape hatches (GPU via devices, ` +
        `Docker-outside-of-Docker via the socket/groups, host networking). To ` +
        `enable them you must also pass allowDangerousHostAccess: true, ` +
        `acknowledging that a subverted agent could use them to reach or take ` +
        `over the host. If you did not intend host access, remove the option.`,
    );
  }

  const socketMounts = socketMountsOf(options);
  if (socketMounts.length > 0) {
    console.warn(
      `sandcastle: ${providerLabel}() is mounting the container-runtime socket ` +
        `(${socketMounts.map((m) => m.hostPath).join(", ")}). This grants the ` +
        `agent control of the host container runtime — equivalent to host root. ` +
        `Prefer a read-only socket-proxy, and only do this for fully trusted work.`,
    );
  }
};
