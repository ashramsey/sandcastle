---
"@ai-hero/sandcastle": minor
---

Harden the Docker and Podman bind-mount providers with a **read-only root filesystem** by default, so a subverted agent cannot tamper with the baked-in tooling/binaries (the Claude CLI, system libraries) mid-run. `--read-only` is paired with `--tmpfs` mounts for exactly the paths a real agent writes — `/tmp`, `~/.cache`, `~/.config`, `~/.npm`, and `~/.claude` — while the bind-mounted worktree stays writable. Two new `hardening` fields, `readOnlyRootfs` (default `true`) and `tmpfs` (default: the writable set above), make it overridable via the same `resolveHardeningFlags` seam as the existing run-line flags.

Two config **files** at the home-dir root — Claude's `~/.claude.json` and git's `~/.gitconfig` (written by Sandcastle's own `git config --global` setup for `safe.directory` + `user.name`/`user.email`) — that `--tmpfs` (directory mounts only) can't cover and a read-only rootfs blocks, so under the default read-only rootfs both providers point `CLAUDE_CONFIG_DIR` at the `~/.claude` tmpfs and `GIT_CONFIG_GLOBAL` at a file in the `~/.config` tmpfs, keeping both on a writable mount. The default `--tmpfs` mounts are mode `1777` so the non-root `agent` user can write to them. A blanket `--tmpfs /home/agent` is deliberately avoided because it would shadow the CLI baked into `~/.local`. Set your own `CLAUDE_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` via the provider `env`, or `readOnlyRootfs: false`, to opt out. The isolated (Vercel) provider is unaffected.

Session capture now reads the agent's transcript out of the sandbox via `base64` over `exec` (inside the container's mount namespace) instead of `docker cp`, because `docker cp` cannot read files from a `tmpfs` mount — where the read-only rootfs places the agent's session state.
