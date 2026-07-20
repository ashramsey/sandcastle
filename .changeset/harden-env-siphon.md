---
"@ai-hero/sandcastle": minor
---

Close the committed-`.sandcastle/.env` host-env siphon. The env resolver's `process.env` fallback — which lets a key declared with an empty value import the host's value for that key — is now disabled when `.sandcastle/.env` is **git-tracked (committed)**. A hostile repo can no longer ship a `.sandcastle/.env` that merely *names* host keys (e.g. `AWS_SECRET_ACCESS_KEY=`) to siphon those host environment values into the container; each blocked key is reported with a warning so the operator can detect the attempt. A user's own *local* (untracked, as the shipped template gitignores it) `.sandcastle/.env` is unaffected — the honest fallback path still works — and explicit values committed in a `.env` (which carry no host data) still pass through.
