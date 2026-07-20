import { describe, expect, it } from "vitest";
import {
  resolveHardeningFlags,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_TMPFS,
} from "./runHardening.js";

/** Read the value following `flag` in a flat arg array (undefined if absent). */
const valueAfter = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
};

/** All values following each occurrence of `flag` in a flat arg array. */
const valuesAfter = (args: string[], flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]!);
  }
  return out;
};

describe("resolveHardeningFlags", () => {
  describe("defaults (hardened)", () => {
    const flags = resolveHardeningFlags();

    it("drops all capabilities by default", () => {
      expect(valueAfter(flags, "--cap-drop")).toBe("ALL");
    });

    it("adds back no capabilities by default", () => {
      expect(flags).not.toContain("--cap-add");
    });

    it("sets no-new-privileges by default", () => {
      const idx = flags.indexOf("--security-opt");
      expect(idx).toBeGreaterThan(-1);
      expect(flags[idx + 1]).toBe("no-new-privileges");
    });

    it("sets the default pids-limit", () => {
      expect(valueAfter(flags, "--pids-limit")).toBe(
        String(DEFAULT_PIDS_LIMIT),
      );
    });

    it("does not set a memory limit by default", () => {
      expect(flags).not.toContain("--memory");
    });

    it("mounts the rootfs read-only by default", () => {
      expect(flags).toContain("--read-only");
    });

    it("emits a --tmpfs for each default writable path", () => {
      expect(valuesAfter(flags, "--tmpfs")).toEqual([...DEFAULT_TMPFS]);
    });

    it("does not shadow the home dir (CLI baked into ~/.local)", () => {
      expect(valuesAfter(flags, "--tmpfs")).not.toContain("/home/agent");
    });
  });

  describe("read-only rootfs override", () => {
    it("omits --read-only and the default tmpfs when disabled", () => {
      const flags = resolveHardeningFlags({ readOnlyRootfs: false });
      expect(flags).not.toContain("--read-only");
      expect(flags).not.toContain("--tmpfs");
    });

    it("honors an explicit tmpfs even when read-only is disabled", () => {
      const flags = resolveHardeningFlags({
        readOnlyRootfs: false,
        tmpfs: ["/scratch"],
      });
      expect(flags).not.toContain("--read-only");
      expect(valuesAfter(flags, "--tmpfs")).toEqual(["/scratch"]);
    });
  });

  describe("tmpfs override", () => {
    it("replaces the default set, preserving order and raw specs", () => {
      const flags = resolveHardeningFlags({
        tmpfs: ["/tmp:exec", "/home/agent/.cache"],
      });
      expect(flags).toContain("--read-only");
      expect(valuesAfter(flags, "--tmpfs")).toEqual([
        "/tmp:exec",
        "/home/agent/.cache",
      ]);
    });

    it("mounts no tmpfs when set to an empty array", () => {
      const flags = resolveHardeningFlags({ tmpfs: [] });
      expect(flags).toContain("--read-only");
      expect(flags).not.toContain("--tmpfs");
    });
  });

  describe("cap-drop override", () => {
    it("replaces the default set when capDrop is provided", () => {
      const flags = resolveHardeningFlags({
        capDrop: ["NET_ADMIN", "SYS_TIME"],
      });
      const first = flags.indexOf("--cap-drop");
      expect(flags[first + 1]).toBe("NET_ADMIN");
      const second = flags.indexOf("--cap-drop", first + 1);
      expect(flags[second + 1]).toBe("SYS_TIME");
      expect(flags).not.toContain("ALL");
    });

    it("drops nothing when capDrop is an empty array", () => {
      const flags = resolveHardeningFlags({ capDrop: [] });
      expect(flags).not.toContain("--cap-drop");
    });
  });

  describe("cap-add", () => {
    it("adds back capabilities while keeping the default drop", () => {
      const flags = resolveHardeningFlags({ capAdd: ["NET_BIND_SERVICE"] });
      expect(valueAfter(flags, "--cap-drop")).toBe("ALL");
      expect(valueAfter(flags, "--cap-add")).toBe("NET_BIND_SERVICE");
    });
  });

  describe("no-new-privileges override", () => {
    it("omits the flag when disabled", () => {
      const flags = resolveHardeningFlags({ noNewPrivileges: false });
      expect(flags).not.toContain("--security-opt");
    });
  });

  describe("pids-limit override", () => {
    it("uses the provided limit", () => {
      const flags = resolveHardeningFlags({ pidsLimit: 512 });
      expect(valueAfter(flags, "--pids-limit")).toBe("512");
    });

    it("omits the limit when set to false", () => {
      const flags = resolveHardeningFlags({ pidsLimit: false });
      expect(flags).not.toContain("--pids-limit");
    });
  });

  describe("memory (opt-in)", () => {
    it("sets the memory limit when provided", () => {
      const flags = resolveHardeningFlags({ memory: "8g" });
      expect(valueAfter(flags, "--memory")).toBe("8g");
    });
  });
});
