---
"@ai-hero/sandcastle": minor
---

Gate the host-access escape hatches on the Docker and Podman providers behind an explicit acknowledgment. The options that deliberately punch a hole in the container boundary — `network: "host"`, `groups` (`--group-add`), `devices` (`--device`), and mounting the Docker/Podman socket via `mounts` — now throw at construction unless `allowDangerousHostAccess: true` is also set, so a prompt-injected agent can no longer reach the host through an option the operator enabled by accident. These remain legitimate opt-in features (GPU access, Docker-outside-of-Docker); they are gated, not removed. Mounting the container-runtime socket additionally logs a runtime warning on every run, and the JSDoc/README now carry host-root warnings and recommend a read-only socket-proxy over the raw socket. Custom/proxy networks and `network: "none"` are **not** gated — restricting egress is not a host-access hatch.

**Breaking:** existing `docker()`/`podman()` calls that pass `network: "host"`, `groups`, `devices`, or a socket mount must add `allowDangerousHostAccess: true` to keep working.
