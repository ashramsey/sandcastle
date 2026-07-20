import { describe, expect, it } from "vitest";
import {
  collectSecretValues,
  createEnvSecretRedactor,
  createSecretRedactor,
  isSensitiveEnvKey,
  REDACTION_PLACEHOLDER,
} from "./redactSecrets.js";

describe("isSensitiveEnvKey", () => {
  it("flags the always-sensitive injected credentials", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ]) {
      expect(isSensitiveEnvKey(key)).toBe(true);
    }
  });

  it("flags user-declared secrets by name heuristic", () => {
    expect(isSensitiveEnvKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSensitiveEnvKey("NPM_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("DB_PASSWORD")).toBe(true);
  });

  it("does not flag plainly non-secret names", () => {
    expect(isSensitiveEnvKey("HOME")).toBe(false);
    expect(isSensitiveEnvKey("NODE_ENV")).toBe(false);
    expect(isSensitiveEnvKey("KEYBOARD_LAYOUT")).toBe(false);
  });
});

describe("collectSecretValues", () => {
  it("collects long values of sensitive keys only", () => {
    const values = collectSecretValues({
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdef",
      HOME: "/home/agent",
      NODE_ENV: "production",
      NPM_TOKEN: "npm_verylongtokenvalue",
    });
    expect(values.sort()).toEqual(
      ["npm_verylongtokenvalue", "sk-ant-api03-abcdef"].sort(),
    );
  });

  it("skips short secret values that would corrupt output", () => {
    // A too-short value is not collected even from a sensitive key.
    expect(collectSecretValues({ GH_TOKEN: "abc" })).toEqual([]);
  });
});

describe("createSecretRedactor", () => {
  it("masks a known secret value wherever it appears", () => {
    const redact = createSecretRedactor(["sk-ant-api03-secretvalue"]);
    expect(redact("using key sk-ant-api03-secretvalue now")).toBe(
      `using key ${REDACTION_PLACEHOLDER} now`,
    );
  });

  it("is an identity function when there are no secrets", () => {
    const redact = createSecretRedactor([]);
    const text = "nothing to see here";
    expect(redact(text)).toBe(text);
  });

  it("does not corrupt non-secret content", () => {
    const redact = createSecretRedactor(["sk-ant-topsecretvalue"]);
    const line = "INFO ran npm install; PATH=/usr/bin ok";
    expect(redact(line)).toBe(line);
  });

  it("keeps a redacted JSON transcript valid", () => {
    const secret = "sk-ant-api03-embeddedintranscript";
    const redact = createSecretRedactor([secret]);
    const line = JSON.stringify({
      role: "assistant",
      text: `here is the key ${secret} do not share`,
    });
    const out = redact(line);
    expect(out).not.toContain(secret);
    // Still parseable JSON.
    const parsed = JSON.parse(out) as { role: string; text: string };
    expect(parsed.role).toBe("assistant");
    expect(parsed.text).toContain(REDACTION_PLACEHOLDER);
  });

  it("masks the longest overlapping secret whole", () => {
    const redact = createSecretRedactor([
      "secretprefix",
      "secretprefix-with-suffix",
    ]);
    expect(redact("token secretprefix-with-suffix end")).toBe(
      `token ${REDACTION_PLACEHOLDER} end`,
    );
  });
});

describe("createEnvSecretRedactor", () => {
  it("redacts injected + user secrets but leaves ordinary env values", () => {
    const redact = createEnvSecretRedactor({
      ANTHROPIC_API_KEY: "sk-ant-injectedsecret",
      GH_TOKEN: "ghp_userdeclaredtoken",
      HOME: "/home/agent",
    });
    const line =
      "auth sk-ant-injectedsecret and ghp_userdeclaredtoken under /home/agent";
    const out = redact(line);
    expect(out).not.toContain("sk-ant-injectedsecret");
    expect(out).not.toContain("ghp_userdeclaredtoken");
    expect(out).toContain("/home/agent");
  });
});
