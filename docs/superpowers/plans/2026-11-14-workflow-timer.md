# GG 耗时 Implementation Plan

> **For agentic workers:** Use test-driven-development and executing-plans for the focused implementation; independent read-only compatibility research and final code review use subagents. Track steps with checkboxes.

**Goal:** Add GG 耗时 with live total duration and the three slowest nodes, using the existing GG 标题 configuration.

**Architecture:** A pure event reducer owns one prompt's timings. A small extension associates submitted prompts with display nodes and feeds the reducer from native execution events. The existing title renderer accepts registered dynamic text providers; the backend adds a searchable no-op annotation schema using shared style inputs.

**Tech Stack:** ComfyUI V3/legacy Python, ES modules, native execution events, Node test runner, existing Playwright/Chrome.

## Global Constraints

- Display name GG 耗时; stable ID GGWorkflowTimer; Chinese user-facing copy.
- No additional Python dependencies, no model loading, no workflow links, no version change, no commits/pushes.
- Preserve title widget serialization and user-owned sizes. Backups are outside the plugin tree.
- Save only compact completed timing results to workflow properties.

## Steps and interfaces

- [ ] Add `tests/test_workflow_timer.py` and `tests/test_workflow_timer.cjs`; run both and capture failures before implementation.
- [ ] Add `web/gg-workflow-timer-state.js`: `WorkflowTimingRun(promptId, {clock, timestamp, resolveNode})`, `executing(detail)`, `progressState(detail)`, `finish(status, detail)`, `snapshot()` with `{promptId,status,totalMs,topNodes,cachedCount}`; export `formatDuration(ms)` and `timerText(summary, display)`.
- [ ] Extend `guli_nodes/title_node.py` with shared style schemas and `GGWorkflowTimer`; V3 empty NodeOutput and legacy empty tuple. Keep original title fields in the original order.
- [ ] Extend `web/gg-title-node.js` with `registerTitleDisplayNode(type, options)` and `refreshTitleDisplay(node)`. Provider options supply title, dynamic getText, extra fields, defaults and horizontal-layout preference. Reuse existing hooks, placement, toolbars and render paths; dynamic text is read-only and case transforms are hidden.
- [ ] Add `web/gg-workflow-timer.js` to capture queue snapshots, handle progress/terminal events, and update only active display nodes on throttled requestAnimationFrame. Exclude GGWorkflowTimer from `web/gg-node-autofit.js`.
- [ ] Add `tools/verify_workflow_timer.cjs` with isolated browser settings and actual extension/ComfyUI tests; include real resizing, serialization, event sequences, shadowing, themes and both renderers.
- [ ] Update `README.md`, `docs/使用指南.md` and `pyproject.toml` after measuring the actual registration count.
- [ ] Run unit/registration/syntax checks, negative mutation checks, original title regression and size ownership regression; restart ComfyUI only while idle using its original arguments; verify with a tiny native workflow and collect screenshots.

## Deterministic checks

```powershell
node --test tests/test_workflow_timer.cjs
& W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe -m unittest discover -s tests -p test_workflow_timer.py -v
node --check web/gg-title-node.js
node --check web/gg-workflow-timer.js
node --check web/gg-workflow-timer-state.js
node tools/verify_workflow_timer.cjs
node tools/verify_resize_ownership.cjs
```

Expected before implementation: missing GGWorkflowTimer registration and missing reducer assertion failures. Expected after implementation: all new tests pass, timing display paints once in normal/shadow cases, no size changes on timing updates, and original title serialization remains unchanged.
