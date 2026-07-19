---
"@ai-hero/sandcastle": minor
---

**Breaking:** `interactive()` and `wt.interactive()` now require an explicit `sandbox` provider. Previously they silently fell back to `noSandbox()`, running the agent directly on the host when no provider was passed — so an accidentally-omitted `sandbox` meant *no isolation at all*. They now throw when neither a provider nor an explicit `noSandbox()` is given, matching how `run()` / `createSandbox()` (and `wt.run()` / `wt.createSandbox()`) already behave. Running unsandboxed is preserved, but must be a deliberate choice: pass `sandbox: noSandbox()`. Update any call that relied on the implicit host-direct fallback to pass `noSandbox()` explicitly.
