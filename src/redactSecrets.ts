/**
 * Redact known secret values from Sandcastle's run logs and captured agent
 * session transcripts (h07, F4 companion).
 *
 * Injected credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
 * `GITHUB_TOKEN`, `GH_TOKEN`) and user-declared secrets can leak into an agent's
 * stdout or session `.jsonl`. Persisting them in plaintext on disk widens the
 * blast radius of a single leaked line. This module masks such values before
 * they are written. It is defense-in-depth, not a substitute for scoping tokens
 * down to short-lived, least-privilege credentials.
 */

/** The literal string substituted in place of a redacted secret value. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Minimum length of a value to redact. Short values (a port, a `1`/`true` flag)
 * would appear all over unrelated output; masking them would corrupt logs far
 * more than it protects. Real credentials are comfortably longer than this.
 */
export const MIN_REDACTABLE_LENGTH = 8;

/** Credential keys always treated as secret regardless of the name heuristic. */
const ALWAYS_SENSITIVE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

/**
 * Name heuristic for user-declared secrets. Deliberately conservative — it
 * matches the substrings that reliably denote a credential and avoids bare
 * `KEY` (which would catch names like `KEYBOARD_LAYOUT`).
 */
const SENSITIVE_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|AUTH)/i;

/** Whether an env var name denotes a secret whose value should be redacted. */
export const isSensitiveEnvKey = (key: string): boolean =>
  ALWAYS_SENSITIVE_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key);

/**
 * Collect the secret values from a resolved environment map: the values of
 * keys that look sensitive by name and are long enough to redact safely.
 */
export const collectSecretValues = (env: Record<string, string>): string[] =>
  Object.entries(env)
    .filter(
      ([key, value]) =>
        value.length >= MIN_REDACTABLE_LENGTH && isSensitiveEnvKey(key),
    )
    .map(([, value]) => value);

/** Masks known secret values in arbitrary text. */
export type Redactor = (text: string) => string;

/**
 * Build a {@link Redactor} that masks each of `secretValues` wherever it appears
 * in a string. Values are matched literally (not as regex) and longest-first, so
 * a secret that contains a shorter secret is masked whole. Returns an identity
 * function when there is nothing to redact, so callers pay nothing on the honest
 * path.
 *
 * Redaction is length-preserving-agnostic and quote-safe: a value embedded in a
 * JSON string (`"sk-ant-…"`) becomes `"[redacted]"`, which is still valid JSON.
 */
export const createSecretRedactor = (
  secretValues: Iterable<string>,
): Redactor => {
  const values = Array.from(new Set(secretValues))
    .filter((value) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of values) {
      out = out.split(value).join(REDACTION_PLACEHOLDER);
    }
    return out;
  };
};

/** Convenience: build a redactor directly from a resolved environment map. */
export const createEnvSecretRedactor = (
  env: Record<string, string>,
): Redactor => createSecretRedactor(collectSecretValues(env));
