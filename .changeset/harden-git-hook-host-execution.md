---
"@ai-hero/sandcastle": minor
---

Harden the bind-mount sandbox provider against the git-hook host-execution vector. The bind-mounted repo's `.git/hooks` directory is now mounted read-only, so a sandboxed (potentially prompt-injected) agent can no longer plant a hook script there; the parent `.git` stays writable so the agent can still commit. In addition, the git commands sandcastle runs on the host during its worktree and merge lifecycle now neutralize repository hooks and fsmonitor (`core.hooksPath=/dev/null`, `core.fsmonitor=`), so an agent-planted hook cannot execute on the host during those operations.
