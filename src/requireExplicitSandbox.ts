import type { AnySandboxProvider } from "./SandboxProvider.js";

/**
 * Enforce that a sandbox provider was chosen deliberately (h05, F8).
 *
 * `interactive()` and `wt.interactive()` used to fall through to `noSandbox()`
 * when no provider was passed, silently running the agent directly on the host.
 * Running unsandboxed must be an explicit decision — consistent with how `run()`
 * / `createSandbox()` (and `wt.run()` / `wt.createSandbox()`) already require a
 * provider. This throws when none was given, and returns the provider unchanged
 * when one was — including an explicit `noSandbox()`, so host-direct stays opt-in.
 *
 * @param sandbox    the provider the caller supplied (or `undefined`)
 * @param entrypoint the calling API, for the error message (e.g. `"interactive()"`)
 */
export const requireExplicitSandbox = (
  sandbox: AnySandboxProvider | undefined,
  entrypoint: string,
): AnySandboxProvider => {
  if (sandbox === undefined) {
    throw new Error(
      `${entrypoint} requires an explicit sandbox provider. ` +
        `Pass \`sandbox: docker()\` (or another provider) to sandbox the agent, ` +
        `or \`sandbox: noSandbox()\` to deliberately run the agent directly on the host.`,
    );
  }
  return sandbox;
};
