---
"@ai-hero/sandcastle": minor
---

Harden the default `docker`/`podman` run line so a subverted agent cannot escalate privilege or DoS the host, without breaking a normal agent run. The bind-mount providers now start containers with `--cap-drop=ALL`, `--security-opt no-new-privileges`, and a generous `--pids-limit 2048` by default. Each is overridable via the new `hardening` provider option: `capDrop` (replace the dropped set, or `[]` to drop none), `capAdd` (add specific capabilities back), `noNewPrivileges` (`false` to omit), and `pidsLimit` (a number, or `false` to remove the limit). A `--memory` ceiling is supported via `hardening.memory` (e.g. `"8g"`) but has no default, so a legitimate heavy build is never OOM-killed by a fixed limit that can't fit every host. Commits, agent session state, and package-manager caches are unaffected.
