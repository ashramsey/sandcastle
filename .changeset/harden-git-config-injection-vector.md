---
"@ai-hero/sandcastle": minor
---

Close the writable `.git/config` injection vector in the bind-mount sandbox provider (follow-up to the git-hook hardening). A prompt-injected agent could previously write code-executing entries into the bind-mounted repo's `.git/config` — `core.hooksPath`, `core.fsmonitor`, an executable `alias.* = !cmd`, an external diff/merge/filter driver, `credential.helper`, `core.pager`, `sequence.editor`, or the `extensions.worktreeConfig` escalation — which then execute as the developer when they later run `git` manually on the host. `.git/config` is now mounted read-only, mirroring the read-only `.git/hooks`, so the write is rejected. Commits are unaffected (they touch objects/refs, not config; identity comes from `--global` config in the sandbox home).

This blocks in-sandbox repo-local config writes (`git remote add`, `git config --local`, tracking-branch creation via `git push -u` / `git checkout --track`). Trusted workflows that need those can opt out by setting `SANDCASTLE_ALLOW_GIT_CONFIG_WRITES=1` (also accepts `true`/`yes`/`on`), which restores a writable `.git/config`.
