# Codex × Gemini Workspace

Local single-user orchestration: Codex plans and reviews, Gemini workers implement in isolated worktrees, the user gates every step. The web dashboard and the VS Code extension are two UIs over the same Orchestrator Core.

## Language

### Workflow

**Gate**:
A point where the workflow stops until the user acts. There are two: Plan Approval (creates the Run) and Review (Run stops at `awaiting_review`; merging to main is the user's decision).
_Avoid_: checkpoint, confirmation step

**Cycle**:
One pass from user request through Plan Approval, Run, Review to the user's merge decision. The extension's UI goal is to complete one Cycle without leaving the extension.
_Avoid_: session (that is the conversation container), flow

**Run**:
The unit created by exactly one Plan Approval; owns workers, integration branch, and evidence.
_Avoid_: job, execution

**Evidence**:
The Run's review material: changed files per node, test results, diagnostics, sanitized CLI output. Produced by Core, only rendered by UI.
_Avoid_: report, summary
