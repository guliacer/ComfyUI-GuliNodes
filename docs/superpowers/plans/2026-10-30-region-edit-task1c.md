# Task1c — Safe isolated local LLM worker

User-authorized usable portrait/background workflow. Actual local PE probe (pwsh-039f4298b10a4af7) loaded qwen35+clip but native process aborted: OMP Error15 libomp140 vs already-loaded torch libiomp5md. Do NOT set KMP_DUPLICATE_LIB_OK or replace DLLs/install packages. We need subprocess isolation, not a new node/UI.

## Allowed files
- guli_nodes/prompt_enhancer.py (only localLLM storage/request/factory glue, parent existing TDD changes already there; read first)
- new guli_nodes/local_llm_worker.py (stdlib-only top-level, script execution by FILE with -I, never imports guli_nodes or torch)
- new guli_nodes/local_llm_bridge.py (stdlib subprocess/JSON/thread/queue transport; no models in parent)
- tests/test_prompt_enhancer_local_compat.py (adapt existing14 real-helper tests to moved worker factory and mocked transport startup; keep all coverage)
- new tests/test_local_llm_worker.py
- docs/superpowers/plans/2026-10-30-region-edit-task1c-report.md
No other source/docs/registry/workflow files, no inference, no new agents/commits/services/downloads.

## Exact retained contracts
Existing localLLM model selection/paths/three Qwen-family handler mapping/enable_thinkingFalse forqwen35/cachekey(model,mmproj,ctx)/auto_unload remain. No new widgets; keep all current V3/legacy ports. Current tests14 pass with mocked Llama. Actual Llama.close also closes chat_handler; current helper detaches first, then closes projector/model once, retain this.

## Design
1 Move current native `Llama` construction + metadata handler selection + cleanup into standalone worker's pure `load_llm_model`/`close_llm_model` functions. Imports llama_cpp only inside these functions, no torch/numpy explicit imports at top (llama_cpp itself may import numpy). Worker launched `[sys.executable, '-I', str(worker_script)]`, not `-m guli_nodes...` (package init would import torch). Child uses only its own file and installed environment. Sys.stdout JSONUTF8 protocol marker; native diagnostics stderr.
2 Persistent bridge owns only its exact child Popen. JSON-line requests: load (paths/context), generate(kwargs as existing create_chat_completion), close. Worker ready reports metadata and torch_loaded=false; refuse readiness if torch is unexpectedly imported. Parent class proxy supports metadata, create_chat_completion(**kwargs), close; load timeout and query timeout≤600s, stdout response queue thread + stderr draining thread prevent deadlocks. Filter explicit marker to avoid native nonJSONstdout. Parent failure/EOF includes actionable Chinese prefix and bounded stderr, releases child. Close idempotent; graceful close with bounded wait then terminate only its child if needed; close stream handles, no worker leaks.
3 `_LocalLLMStorage.load` keeps cache semantics but starts bridge proxy instead of native Llama. Only startup imports bridge. Parent no llama_cpp native import on production path. `_request_local_llm` can retain existing messages/result parsing. Before starting a native worker, release Comfy-owned model VRAM via comfy.model_management unload_all_models + soft_empty_cache (lazy import, within actual runtime only) so person-stage PE can fit after background diffusion. Default auto_unloadTrue exits worker; False retains cached child (warn docs later). No environment-wide modifications.
4 Test factory logic by mocking llama_cpp inside worker module (existing14 coverage), test storage with mocked worker factory. Real subprocess tests use a tiny temporary stdlib-only fake protocol worker, not real GGUF; cover launch isolation flags/filepath, roundtrip, cache reuse/close, childerror/EOF, stderr draining, timeout/forcedcleanup, no shared model-registry changes. Verify worker source/import path contains no torch/guli_nodes imports. Temporary paths only tests' own dirs; no deletes/moves of user files.

## TDD
Write/run new tests RED before production bridge exists; report actual failure. Then minimal code, GREEN existing14+new transport tests. Parent owns actual tiny local PE inference test after handoff; do not run it yourself, to avoid parallelGPU allocations. Keep parent tests/test_region_* untouched. Use portable Python -B unittest. Finish with concise status+counts+concerns; full report to named file. Budget scope: small worker/bridge only, no generic service framework, no speculative architecture support.
