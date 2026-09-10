# Codex + Gemini routing

When the user asks to implement, build, fix, or change repository code in natural language, first decide whether the request should use the Gemini worker router.

- Use `codex-route -Request "<the user's complete request>" -Repository .` for implementation work that can be verified with deterministic commands.
- Do not use the router for explanation-only requests, code review, destructive operations, secrets, production deployment, or a change requiring an unresolved user decision.
- The router creates isolated worker branches and an `integration/<run-id>` branch.
- If the prompt contains `ROUTER_PLANNING_SUBCALL`, this is the router's read-only planning subprocess. Never invoke `codex-route` or edit files; return only the requested structured plan.
- Keep trivial tasks at level 0 or 1 with one worker. Use two workers only for genuinely independent file ownership.

## Dashboard-first asynchronous execution

- For Gemini worker implementation, launch `codex-route` as a detached/background process and return control to the user after confirming that the process started. The user monitors progress directly at `http://localhost:3000/`.
- Do not poll the worker process, read incremental NDJSON events, repeatedly inspect worker state, or relay progress into the Codex conversation. Those events are written by the workers and consumed directly by the dashboard without Codex involvement.
- Do not wait in the Codex turn for worker completion. Inspect worker output only when the user explicitly asks for a review/status, or when the user reports that the dashboard shows `requiresCodex`, `HIGH_MODEL_FAILED`, `POLICY_VIOLATION`, or another terminal escalation.
- On review, read only the compact terminal result, integration diff, and test summary. Avoid loading the full live event stream unless the compact failure record is insufficient to diagnose an escalation.

## Standing authorization & automatic delivery

- When automatic delivery is configured via `worker-settings.json` (`autoDeliver: true`) or the `-AutoDeliver` CLI switch, routed natural-language implementation runs have standing authorization to automatically complete review and deliver verified changes to `main` and push to the configured remote.
- If automatic delivery is disabled (`-AutoDeliver:$false`), the run stops at `awaiting_review` / `awaiting_human_approval` for manual review and approval.
- Existing historical runs and this initial bootstrap implementation run remain at `awaiting_review` and require manual Codex bootstrap review.

## Safety gates & delivery pipeline

Automatic delivery proceeds strictly through the following non-bypassable gates:
1. **Compact Codex / Integration Review**: Structured verdict must be `PASS`, integration diff must be non-empty and clean, expected-file policy must be satisfied (no modifications outside `allowed_files`), and all worker and integration test summaries must pass.
2. **Remote & Branch Validation**: Fetches the configured remote (`origin`), verifies target `main` and integration branch identities and ancestry (`baseCommit` must be an ancestor of candidate commit), checks that working trees are clean, and ensures no divergence between local and remote target branches. Overwriting unrelated local or remote commits is strictly prevented.
3. **Candidate Commit Verification**: Runs all plan and task verification commands on the exact candidate commit to be delivered.
4. **Non-Destructive Integration**: Integrates candidate commit into `main` using fast-forward only (`git merge --ff-only`). Never uses force, `--force`, `--force-with-lease`, destructive reset, or unsafe overwrite.
5. **Post-Integration Verification**: Re-runs all verification commands in the main repository after integration.
6. **Normal Remote Push**: Pushes to the configured remote (`git push origin main`) normally without force.

## Terminal escalation & diagnostics

- On any failure (conflict, divergence, failed review/policy, unexpected files, verification failure, missing upstream/authentication, or push rejection), all merge/push operations stop immediately.
- An atomic terminal failure state (`escalated` or `failed`) is recorded in `run.json`.
- A compact, redacted diagnostic artifact (`delivery-diagnostic.json` and `delivery-diagnostic.md`) is recorded for consumption by the dashboard.
- Secrets, credential-bearing URLs, Authorization headers, API keys, and personal access tokens are strictly redacted from logs and artifacts.

## Idempotency & recovery

- Every delivery gate is idempotent and recoverable.
- Re-running `review-integration -RunId <run-id>` or `codex-route` recognizes already-completed gates, candidate commits, and pushes without duplicating merge commits or pushing redundantly.
- Failed review or network steps can be safely retried with `review-integration -RunId <run-id>` once the underlying issue is addressed.

