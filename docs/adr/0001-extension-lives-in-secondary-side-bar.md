---
status: accepted
date: 2026-09-17
---

# Extension views live in the Secondary Side Bar

The roadmap placed the extension in the Activity Bar / Primary Side Bar because, at VS Code 1.90, extensions could not contribute views to the Secondary Side Bar. Since 1.106 `contributes.viewsContainers` accepts a secondary-side-bar location without a proposed API, so we contribute one container there, drop the Activity Bar icon, and raise `engines.vscode` to `^1.106.0`. This gives the three-column layout the review Cycle needs (chat and Run state on the right, diff in the centre, Explorer/Git untouched on the left) and matches where Copilot Chat and other assistants sit.

## Considered options

- Primary Side Bar single view with phase tabs: keeps 1.90 support, but every Cycle needs an extra switch and the chat competes with Explorer.
- Two containers with a "drag me to the right" hint: works on older VS Code, but the hint is awkward and the layout is not guaranteed.

## Consequences

- Users on VS Code < 1.106 cannot install the extension. Declaring the secondary-side-bar key on older versions is also reported to disturb other extensions' view positions, so the engine bump is not optional.
- The manifest key is `contributes.viewsContainers.secondarySidebar` (lower-case `b`), verified against `src/vs/workbench/api/browser/viewsExtensionPoint.ts` on 2026-09-17.
