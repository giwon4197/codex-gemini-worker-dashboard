# Codex + Gemini routing

When the user asks to implement, build, fix, or change repository code in natural language, first decide whether the request should use the Gemini worker router.

- Use `codex-route -Request "<the user's complete request>" -Repository .` for implementation work that can be verified with deterministic commands.
- Do not use the router for explanation-only requests, code review, destructive operations, secrets, production deployment, or a change requiring an unresolved user decision.
- The router creates isolated worker branches and an `integration/<run-id>` branch. It must stop at `awaiting_review`; never merge that branch into `main` without explicit user approval.
- After the router finishes, review `.agent/runs/<run-id>/integration-review.md`, the integration diff, and test results. Report the integration branch and ask for approval before merging main.
- If the prompt contains `ROUTER_PLANNING_SUBCALL`, this is the router's read-only planning subprocess. Never invoke `codex-route` or edit files; return only the requested structured plan.
- Keep trivial tasks at level 0 or 1 with one worker. Use two workers only for genuinely independent file ownership.
