import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { join } from "node:path";

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      const isDoubleQuoted =
        value.length >= 2 &&
        value[0] === '"' &&
        value[value.length - 1] === '"';
      const isSingleQuoted =
        value.length >= 2 &&
        value[0] === "'" &&
        value[value.length - 1] === "'";
      if (isDoubleQuoted || isSingleQuoted) {
        value = value.slice(1, -1);
      }
      if (isDoubleQuoted) {
        value = value.replace(/\\([nrt\\])/g, (_, ch: string) => {
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
          };
          return escapes[ch] ?? ch;
        });
      }
      vars[key] = value;
    }
    return vars;
  });

/**
 * Report whether `relPath` is git-tracked (committed) in the repo at `repoDir`.
 *
 * Used to tell a user's own *local* `.sandcastle/.env` (the honest path — the
 * shipped template gitignores it) apart from a `.sandcastle/.env` a hostile repo
 * has *committed*. Never fails: outside a git repo, or if git is unavailable, it
 * resolves `false` (treat as local/honest), preserving the existing fallback.
 */
const isGitTracked = (
  repoDir: string,
  relPath: string,
): Effect.Effect<boolean, never> =>
  Effect.async<boolean>((resume) => {
    execFile(
      "git",
      ["-C", repoDir, "ls-files", "--error-unmatch", relPath],
      (error) => resume(Effect.succeed(!error)),
    );
  });

/**
 * Resolve all env vars from .env files, with a host-`process.env` fallback for
 * keys declared with an empty value.
 *
 * Precedence: .sandcastle/.env > process.env
 * Only keys declared in .sandcastle/.env are resolved from process.env.
 * Repo root .env is not part of the resolution chain.
 *
 * Host-env siphon guard (h04): the `process.env` fallback lets a key named with
 * an empty value import the host's value for that key. That is the intended
 * honest path for a user's *local* (gitignored) `.sandcastle/.env`, but it is a
 * host-env exfiltration vector when a hostile repo *commits* a `.sandcastle/.env`
 * merely naming host keys. When the file is git-tracked we therefore disable the
 * fallback and warn, so a committed `.env` cannot pull undeclared host values
 * into the container. Explicit values in the file carry no host data and still
 * pass through.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sandcastleEnv = yield* parseEnvFile(
      join(repoDir, ".sandcastle", ".env"),
    );
    const isCommitted = yield* isGitTracked(repoDir, ".sandcastle/.env");

    const result: Record<string, string> = {};
    const blockedSiphonKeys: string[] = [];
    for (const key of Object.keys(sandcastleEnv)) {
      const fileValue = sandcastleEnv[key];
      if (fileValue) {
        // Explicit value in the file — carries no host data, always passes.
        result[key] = fileValue;
        continue;
      }
      // Empty value → would fall back to the host's process.env[key].
      if (isCommitted) {
        // A committed .env naming a host key is the siphon vector: drop it, and
        // record the attempt so the operator can detect it.
        blockedSiphonKeys.push(key);
        continue;
      }
      const hostValue = process.env[key];
      if (hostValue) {
        result[key] = hostValue;
      }
    }

    if (blockedSiphonKeys.length > 0) {
      yield* Effect.sync(() =>
        console.warn(
          `[sandcastle] Warning: ignored ${blockedSiphonKeys.length} key(s) named in a committed ` +
            `.sandcastle/.env that would import host environment values: ${blockedSiphonKeys.join(", ")}. ` +
            `A committed .sandcastle/.env is abnormal — the shipped template gitignores it. Declare env ` +
            `in your own config (provider \`env\`, or a local, untracked .sandcastle/.env) instead.`,
        ),
      );
    }

    return result;
  });
