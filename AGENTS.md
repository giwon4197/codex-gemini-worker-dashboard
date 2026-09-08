# Codex + Gemini routing

When the user asks to implement, build, fix, or change repository code in natural language, first decide whether the request should use the Gemini worker router.

- Use `codex-route -Request "<the user's complete request>" -Repository .` for implementation work that can be verified with deterministic commands.
- Do not use the router for explanation-only requests, code review, destructive operations, secrets, production deployment, or a change requiring an unresolved user decision.
- The router creates isolated worker branches and an `integration/<run-id>` branch. It must stop at `awaiting_review`; never merge that branch into `main` without explicit user approval.
- After the router finishes, review `.agent/runs/<run-id>/integration-review.md`, the integration diff, and test results. Report the integration branch and ask for approval before merging main.
- If the prompt contains `ROUTER_PLANNING_SUBCALL`, this is the router's read-only planning subprocess. Never invoke `codex-route` or edit files; return only the requested structured plan.
- Keep trivial tasks at level 0 or 1 with one worker. Use two workers only for genuinely independent file ownership.

## Dashboard-first asynchronous execution

- For Gemini worker implementation, launch `codex-route` as a detached/background process and return control to the user after confirming that the process started. The user monitors progress directly at `http://localhost:3000/`.
- Do not poll the worker process, read incremental NDJSON events, repeatedly inspect worker state, or relay progress into the Codex conversation. Those events are written by the workers and consumed directly by the dashboard without Codex involvement.
- Do not wait in the Codex turn for worker completion. Inspect worker output only when the user explicitly asks for a review/status, or when the user reports that the dashboard shows `requiresCodex`, `HIGH_MODEL_FAILED`, `POLICY_VIOLATION`, or another terminal escalation.
- On review, read only the compact terminal result, integration diff, and test summary. Avoid loading the full live event stream unless the compact failure record is insufficient to diagnose an escalation.
- A successful background run stops at `awaiting_review`; Codex review and main merge happen only after the user requests them.
