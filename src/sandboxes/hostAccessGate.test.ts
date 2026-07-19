import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHostAccessAcknowledged,
  collectHostAccessHatches,
} from "./hostAccessGate.js";

describe("collectHostAccessHatches", () => {
  it("reports no hatches for benign options", () => {
    expect(collectHostAccessHatches({})).toEqual([]);
    expect(collectHostAccessHatches({ network: "my-proxy-net" })).toEqual([]);
    expect(collectHostAccessHatches({ network: "none" })).toEqual([]);
    expect(collectHostAccessHatches({ network: ["net-a", "net-b"] })).toEqual(
      [],
    );
    expect(
      collectHostAccessHatches({
        mounts: [{ hostPath: "/data", sandboxPath: "/data" }],
      }),
    ).toEqual([]);
  });

  it("flags network: 'host' (string and array forms)", () => {
    expect(collectHostAccessHatches({ network: "host" })).toHaveLength(1);
    expect(
      collectHostAccessHatches({ network: ["bridge", "host"] }),
    ).toHaveLength(1);
  });

  it("flags groups, devices, and runtime-socket mounts", () => {
    expect(collectHostAccessHatches({ groups: ["docker"] })).toHaveLength(1);
    expect(collectHostAccessHatches({ devices: ["/dev/kvm"] })).toHaveLength(1);
    expect(
      collectHostAccessHatches({
        mounts: [
          {
            hostPath: "/var/run/docker.sock",
            sandboxPath: "/var/run/docker.sock",
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      collectHostAccessHatches({
        mounts: [{ hostPath: "/run/podman/podman.sock", sandboxPath: "/x" }],
      }),
    ).toHaveLength(1);
  });

  it("accumulates multiple hatches", () => {
    expect(
      collectHostAccessHatches({
        network: "host",
        groups: ["docker"],
        devices: ["/dev/kvm"],
      }),
    ).toHaveLength(3);
  });
});

describe("assertHostAccessAcknowledged", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("passes for benign options (no throw, no warn)", () => {
    expect(() =>
      assertHostAccessAcknowledged("docker", { network: "my-proxy-net" }),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws when a hatch is set without the acknowledgment", () => {
    expect(() =>
      assertHostAccessAcknowledged("docker", { groups: ["docker"] }),
    ).toThrow(/allowDangerousHostAccess: true/);
  });

  it("lists every offending hatch and the provider label in the message", () => {
    let message = "";
    try {
      assertHostAccessAcknowledged("podman", {
        network: "host",
        devices: ["/dev/kvm"],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("podman()");
    expect(message).toContain('network: "host"');
    expect(message).toContain("devices");
  });

  it("passes when the acknowledgment is set", () => {
    expect(() =>
      assertHostAccessAcknowledged("docker", {
        groups: ["docker"],
        devices: ["/dev/kvm"],
        network: "host",
        allowDangerousHostAccess: true,
      }),
    ).not.toThrow();
  });

  it("does not warn on a socket mount that is blocked by the throw", () => {
    expect(() =>
      assertHostAccessAcknowledged("docker", {
        mounts: [
          {
            hostPath: "/var/run/docker.sock",
            sandboxPath: "/var/run/docker.sock",
          },
        ],
      }),
    ).toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns on an acknowledged socket mount", () => {
    assertHostAccessAcknowledged("docker", {
      mounts: [
        {
          hostPath: "/var/run/docker.sock",
          sandboxPath: "/var/run/docker.sock",
        },
      ],
      allowDangerousHostAccess: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("container-runtime socket");
  });
});
