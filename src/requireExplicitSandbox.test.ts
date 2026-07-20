import { describe, expect, it } from "vitest";
import { requireExplicitSandbox } from "./requireExplicitSandbox.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";

describe("requireExplicitSandbox", () => {
  it("throws when no provider is given", () => {
    expect(() => requireExplicitSandbox(undefined, "interactive()")).toThrow(
      /interactive\(\) requires an explicit sandbox provider/,
    );
  });

  it("error names both the sandbox and noSandbox escape routes", () => {
    try {
      requireExplicitSandbox(undefined, "wt.interactive()");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("wt.interactive()");
      expect(msg).toContain("docker()");
      expect(msg).toContain("noSandbox()");
    }
  });

  it("returns an explicit noSandbox() unchanged (host-direct stays opt-in)", () => {
    const provider = noSandbox();
    expect(requireExplicitSandbox(provider, "interactive()")).toBe(provider);
  });

  it("returns a real provider unchanged", () => {
    const provider = createBindMountSandboxProvider({
      name: "test",
      create: async (options) => ({
        worktreePath: options.worktreePath,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });
    expect(requireExplicitSandbox(provider, "interactive()")).toBe(provider);
  });
});
