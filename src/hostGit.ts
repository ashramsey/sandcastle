/**
 * Neutralization flags for host-side git invocations.
 *
 * Threat (ticket harden/git-hook-host-execution, F1): a prompt-injected agent
 * can write into the bind-mounted `.git` — dropping a `.git/hooks/*` script or a
 * `core.hooksPath` / `core.fsmonitor = <cmd>` entry in `.git/config`. When
 * sandcastle later runs git *on the host* (notably `git merge`, which fires
 * `post-merge`, but also `rev-parse` / `config` / `rev-list`, which read
 * `.git/config`), the host would execute that agent-planted code as the
 * developer — a sandbox-to-host code-execution path that needs no container
 * escape.
 *
 * Prepending these flags to every host-side git call neutralizes the vector
 * regardless of what the agent planted:
 * - `core.hooksPath=/dev/null` makes git look for hooks under `/dev/null/<name>`,
 *   which never exists, so no repository hook (post-merge, post-checkout, …) runs.
 * - `core.fsmonitor=` disables any planted fsmonitor command.
 *
 * They are read-only overrides that are harmless for read commands, so they can
 * be applied uniformly at every host-git chokepoint.
 */
export const HOOK_NEUTRALIZE_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=",
];

/**
 * Build a host-side git command string with hooks/fsmonitor neutralized.
 * `gitArgs` is everything that would follow `git ` (e.g. `merge "topic"`).
 *
 * For the array-argument form (e.g. `execFile("git", args)`), spread
 * {@link HOOK_NEUTRALIZE_FLAGS} ahead of the args instead.
 */
export const neutralizeHostGitCommand = (gitArgs: string): string =>
  `git ${HOOK_NEUTRALIZE_FLAGS.join(" ")} ${gitArgs}`;
