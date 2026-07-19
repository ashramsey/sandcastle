---
"@ai-hero/sandcastle": patch
---

Redact known secret values from run logs and captured agent session transcripts. Injected credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`) and user-declared secrets (env keys matching a conservative name heuristic — `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*API_KEY*`, etc.) are now masked with `[redacted]` before they are written to the verbose run log or to the `.jsonl` session files persisted on the host. Redaction runs on the already-rewritten transcript, so masking a quoted secret leaves the JSON valid, and short values (< 8 chars) are left alone to avoid corrupting unrelated output. This is defense-in-depth for on-disk artifacts — it is not a substitute for scoping tokens down to short-lived, least-privilege credentials.
