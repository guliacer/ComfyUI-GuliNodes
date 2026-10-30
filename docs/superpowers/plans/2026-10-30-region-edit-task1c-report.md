# Task1c report — isolated local LLM worker

## Status

**DONE — scoped implementation and mocked/real-subprocess verification.** Final result: **43/43 tests passed (14 retained + 29 new)**, plus **2/2 negative controls caught deliberately broken safety rules**. Syntax verification passed for all five Python files; scoped `git diff --check` passed.

**Real local PE/model inference is NOT verified by this subagent.** The parent owns the real probe and whole workflow. No real weights were loaded, inference/services/downloads/installations/commits/other agents were started, or environment-wide settings changed.

The task contract [2026-10-30-region-edit-task1c.md](<docs/superpowers/plans/2026-10-30-region-edit-task1c.md>) was read first. Its reported native abort (OMP Error15: `libomp140` vs torch's already-loaded `libiomp5md`, probe `pwsh-039f4298b10a4af7`) is the motivation; that abort was not reproduced here. No `KMP_DUPLICATE_LIB_OK`, DLL replacement, or other unsafe workaround was used.

## Exact scope

| File | This task's change |
| --- | --- |
| [prompt_enhancer.py](<guli_nodes/prompt_enhancer.py#L578-L640>) | Only existing localLLM storage/startup/unload/request glue: use proxy, free Comfy-owned VRAM before a new worker, clear a failed proxy for retry. |
| [local_llm_worker.py](<guli_nodes/local_llm_worker.py>) | New standalone file worker; moved native model/handler construction and detach-before-close cleanup. 128 lines. |
| [local_llm_bridge.py](<guli_nodes/local_llm_bridge.py>) | New bounded persistent JSON transport/proxy. 192 lines. |
| [test_prompt_enhancer_local_compat.py](<tests/test_prompt_enhancer_local_compat.py>) | Retain all 14 tests; invoke the moved real worker factory/cleanup with mocked `llama_cpp` and mocked transport startup/VRAM calls. |
| [test_local_llm_worker.py](<tests/test_local_llm_worker.py>) | 29 new tests: 16 transport, 8 worker/helper, 5 storage integration. |
| [Task1c report](<docs/superpowers/plans/2026-10-30-region-edit-task1c-report.md>) | Full scoped evidence and handoff. |

Existing path discovery, traversal protection, registry behavior, prompts, API/localPE routes, and V3/legacy ports were not changed. Parent/user family/path/cache work was read before editing and retained rather than replaced with the older Git HEAD implementation. The shared working tree was already dirty; no task1/region/node/front-end/registry/workflow files were edited by this task. Documentation/version updates outside this allowed report remain with the parent.

## Implementation / interfaces

### Worker

[The model factory](<guli_nodes/local_llm_worker.py#L24-L63>) imports `llama_cpp` only inside the function; the worker's top-level imports are only `json`, `os`, and `sys`. No `guli_nodes`, torch, numpy, Comfy, or folder-path import exists anywhere in the worker source. Importing the worker by file does not load `llama_cpp`.

[The file entry point](<guli_nodes/local_llm_worker.py#L117-L128>) duplicates the original stdout pipe for UTF-8 JSON, then redirects Python stdout and native fd 1 diagnostics to stderr. An actual subprocess test using the real worker entry point and a stdlib-only fake Llama confirmed both `print(...)` and `os.write(1, ...)` diagnostics arrive on stderr while JSON roundtrips remain valid. This is not native inference.

[The request loop](<guli_nodes/local_llm_worker.py#L74-L114>) serves only `load`, `generate`, and `close`, serially, with one model. It refuses a load if torch is already imported, and refuses readiness/cleans the loaded model if a dependency imports torch during construction. Successful load readiness reports model metadata and `torch_loaded: false`. EOF/error/close releases the model. [Cleanup](<guli_nodes/local_llm_worker.py#L10-L21>) detaches `chat_handler` before closing handler and model, preventing Llama.close from closing the projector twice.

### Bridge

[Startup](<guli_nodes/local_llm_bridge.py#L21-L52>) is exactly:

```python
[sys.executable, "-I", str(WORKER_SCRIPT)]
```

The worker is launched **by file**, never `-m guli_nodes...`; no replacement server, service, model registry, or generic daemon is introduced. No worker-path/timeout/new node options were added. The internal script constant and timeout constants are patched only in tests.

The proxy interface is:

```python
LocalLLMProxy(model_path, mmproj_path, context_length)
proxy.metadata
proxy.create_chat_completion(**kwargs)
proxy.close()  # idempotent
```

Wire format (UTF-8 JSON lines; requests are plain JSON, responses require the explicit stdout marker):

```text
{"id":1,"op":"load","model_path":"...","mmproj_path":"...","context_length":4096}
GG_LOCAL_LLM_JSON:{"id":1,"ok":true,"result":{"ready":true,"metadata":{...},"torch_loaded":false}}
{"id":2,"op":"generate","kwargs":{"messages":[...],"max_tokens":256,"temperature":0.7}}
GG_LOCAL_LLM_JSON:{"id":2,"ok":true,"result":{"choices":[...]}}
{"id":3,"op":"close"}
GG_LOCAL_LLM_JSON:{"id":3,"ok":true,"result":{"closed":true}}
```

Bounds/ownership:

- Fixed **600-second load and generation deadlines**. A per-request writer thread puts blocked stdin writes inside the deadline too; a fake worker that stops reading stdin and a 2 MB request verified forced cleanup, not an indefinite parent write.
- Two persistent reader threads: marked stdout responses into a **4-entry queue**, stderr continuously drained into a **4096-byte tail**. Unmarked native/non-JSON stdout is filtered. Request/response frames are capped at **64 MiB**.
- Request IDs must match. Invalid marked JSON, EOF, child error, timeout, oversized request, or unsafe readiness gets an actionable Chinese error, includes bounded stderr where available, and disposes the exact owned child.
- `close` first requests graceful shutdown; fixed **2-second** close/wait windows bound it. A hung worker, including one that ACKs but does not exit, is terminated/killed through its own Popen only. Pipes are closed and transport threads joined. Normal cached proxies register exact-child cleanup at interpreter exit and unregister on close.

### Existing localLLM glue

[Storage startup](<guli_nodes/prompt_enhancer.py#L583-L604>) retains the key `(model_name, normalized_mmproj_name, int(context_length))`. A hit reuses the exact cached proxy/child and does not unload Comfy models again. A miss closes the old worker, resolves paths through the existing resolver, lazily imports bridge/Comfy model management, and calls `unload_all_models()` followed by `soft_empty_cache(force=True)` **before** worker startup. These Comfy calls were mocked during tests; no real VRAM release/inference was performed here.

[Request parsing](<guli_nodes/prompt_enhancer.py#L613-L640>) retains messages, image data URLs, max_tokens, temperature, and result parsing. It now clears storage after transport failure: the bridge already disposed the child, and the same selected key can start a fresh worker instead of indefinitely reusing a dead proxy.

`auto_unload=True` still closes storage after successful enhancement and now exits the worker. `False` intentionally retains the cached worker until explicit unload/key change/interpreter exit.

## Retained contracts

| Contract | Evidence |
| --- | --- |
| `qwen35` -> `Qwen35ChatHandler`, `enable_thinking=False` | Retained compatibility test, moved factory. |
| `qwen3vl` -> `Qwen3VLChatHandler`, not Qwen2.5 template | Retained compatibility test. |
| `qwen2vl` -> `Qwen25VLChatHandler`, fallback `Qwen2VLChatHandler` | Two retained compatibility tests. |
| Missing handler / unknown visual architecture are actionable, not silent fallback | Two retained compatibility tests. |
| Text-only needs no visual handler | Retained test, plus real-worker fake-native text-only subprocess. |
| Model/projector cleanup on unload and failed handler construction | Retained tests + single-close helper assertion + negative control. |
| Cache key/reuse/unload state | Retained tests + real fake-worker storage integration. |
| `n_ctx=max(512, int(context_length))`, `n_gpu_layers=-1`, constructor handler initially None | Worker helper constructor-argument test. |
| Existing standalone `models/LLM` discovery/resolution and traversal guard | All four retained directory tests unchanged. |
| No global folder/model-category registration changes | Retained directory test + real cache/key-switch transport integration. |
| Default unload vs retained worker | Real transport through existing `_run` with False, then omitted/default True. |
| No V3/legacy parameter/port changes | All edits restricted to the existing localLLM block; final source diff reviewed. |

## TDD sequence and actual outputs

All Python commands used the existing portable interpreter, `-B`, in the shared plugin workspace. Tests used their own verified temporary directories only; dummy GGUF filenames contain test bytes, never weights.

### 1. Existing baseline — GREEN before changes

```powershell
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p 'test_prompt_enhancer_local_compat.py' -v
```

Job `pwsh-f1219927c64f432c`, collected after completion:

```text
Ran 14 tests in 0.044s
OK
exit code: 0
```

### 2. New tests — RED before worker/bridge production files existed

```powershell
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p 'test_local_llm_worker.py' -v
```

Actual missing-feature assertions (not import/syntax errors):

```text
AssertionError: 缺少隔离实现：local_llm_bridge.py
AssertionError: 缺少隔离实现：local_llm_worker.py
Ran 28 tests in 0.013s
FAILED (failures=28)
exit code: 1
```

Only after observing this RED were the two production files created and storage changed.

### 3. First implementation run — 41 passed, one fixture error investigated

Combined command below, job `pwsh-34ec549011cb4bf0`:

```text
Ran 42 tests in 3.015s
FAILED (errors=1)
exit code: 1
```

The failing real-worker diagnostic fixture supplied a nonempty projector path to a text-only fake Llama that deliberately provided no `llama_chat_format`. The child correctly reported `ImportError: cannot import name 'llama_chat_format'`. The stderr evidence already contained both native and Python diagnostics. The fixture was corrected to supply an empty projector path; no production rule/assertion was weakened.

### 4. Dead-proxy retry regression — additional RED before request-glue change

Added `test_failed_query_clears_dead_cached_proxy_for_same_key_retry` after identifying that child disposal alone left storage holding the dead proxy. Job `pwsh-467c2000fca14b39`:

```text
AssertionError: <guli_nodes.local_llm_bridge.LocalLLMProxy object ...> is not None
Ran 43 tests in 3.139s
FAILED (failures=1)
exit code: 1
```

The other 42 tests passed, including the corrected real worker stdout diagnostic test. Only then was exception cleanup added to the existing localLLM request glue.

### 5. Final GREEN — source frozen after this result

```powershell
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -c "import sys, unittest; loader=unittest.TestLoader(); suite=unittest.TestSuite([loader.discover('tests', pattern='test_prompt_enhancer_local_compat.py'), loader.discover('tests', pattern='test_local_llm_worker.py')]); result=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(not result.wasSuccessful())"
```

Job `pwsh-96e128fd437f4628`, complete output collected:

```text
Ran 43 tests in 3.155s
OK
exit code: 0
```

Test inventory from that GREEN run:

**Retained compatibility/directory — 14/14**

```text
test_failed_handler_construction_closes_loaded_model
test_missing_qwen35_handler_is_actionable_not_silent_fallback
test_qwen2vl_has_qwen2_fallback
test_qwen2vl_legacy_handler_still_works
test_qwen35_uses_its_own_visual_handler
test_qwen3vl_does_not_reuse_qwen25_template
test_same_key_reuses_model
test_text_only_load_does_not_require_any_visual_handler
test_unknown_visual_architecture_is_rejected
test_unload_closes_visual_projector_and_model
test_fallback_does_not_modify_global_model_categories
test_fallback_resolves_own_local_model
test_models_llm_is_discoverable_without_other_plugin_registration
test_path_traversal_cannot_escape_local_model_directory
```

**Real subprocess transport — 16/16**

```text
test_blocked_stdin_write_is_inside_query_deadline
test_close_ack_without_exit_forces_cleanup
test_close_is_idempotent_and_releases_streams_and_threads
test_close_timeout_forces_cleanup
test_launch_isolated_file_and_utf8_roundtrip
test_load_eof_includes_stderr_and_releases_child
test_load_error_is_actionable_and_releases_child
test_load_timeout_forces_cleanup
test_malformed_marked_json_releases_child
test_query_eof_includes_stderr_and_releases_child
test_query_timeout_does_not_terminate_unrelated_process
test_queue_message_and_timeout_bounds
test_real_worker_redirects_python_and_native_stdout
test_repeat_queries_reuse_exact_child
test_stderr_flood_is_drained_and_failure_tail_is_bounded
test_torch_or_missing_isolation_readiness_is_refused
```

**Worker/helper — 8/8**

```text
test_cleanup_detaches_projector_and_closes_each_once
test_factory_retains_context_and_gpu_constructor_arguments
test_import_does_not_load_llama_cpp
test_json_serve_roundtrip_and_eof_close_model
test_missing_llama_cpp_is_actionable
test_top_level_imports_are_stdlib_and_no_package_or_torch_imports
test_torch_imported_by_dependency_refuses_ready_and_closes_model
test_torch_present_before_load_is_rejected_without_construction
```

**Storage through real fake-worker transport — 5/5**

```text
test_auto_unload_false_retains_child_and_default_true_exits_it
test_comfy_vram_is_released_before_worker_startup_not_on_cache_hit
test_failed_query_clears_dead_cached_proxy_for_same_key_retry
test_failed_startup_leaves_storage_empty
test_same_key_reuses_real_worker_and_new_key_closes_it_without_registry_change
```

### 6. Negative controls — 2/2 expected assertion failures

Separate portable `-B` process, no production-file edits: invoke the actual transport test with its Popen intercepted to omit `-I`; invoke the actual cleanup helper test with an in-memory unsafe helper that closes the projector before model.close and detaches too late. Actual output:

```text
Expected assertion failure when -I is removed: Lists differ ... '-I' ...
Expected assertion failure for duplicate projector close: Tuples differ: (2, 1) != (1, 1)
Negative controls OK: 2/2 expected assertion failures; production files unchanged
exit code: 0
```

The transport control closes its own fake child/temp directory. Cleanup control uses only in-memory fake objects. This additionally proves those key assertions are not empty green checks.

### 7. Final syntax / diff verification

```powershell
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -c "from pathlib import Path; files=['guli_nodes/prompt_enhancer.py','guli_nodes/local_llm_worker.py','guli_nodes/local_llm_bridge.py','tests/test_prompt_enhancer_local_compat.py','tests/test_local_llm_worker.py']; [compile(Path(p).read_text(encoding='utf-8'), p, 'exec') for p in files]; print('Syntax OK: 5 files; no bytecode written')"
git diff --check -- guli_nodes/prompt_enhancer.py guli_nodes/local_llm_worker.py guli_nodes/local_llm_bridge.py tests/test_prompt_enhancer_local_compat.py tests/test_local_llm_worker.py
```

```text
Syntax OK: 5 files; no bytecode written
exit code: 0
```

The final source diff was read. Scoped Git whitespace check covers tracked changes; new/untracked Python files were also compiled in memory. All four background job IDs above were collected; none remains running.

## Concerns / parent handoff

1. **Real PE/native model probe still belongs to the parent.** These tests establish isolation/transport/family glue behavior, not installed native handler compatibility, model fit, performance, or generated PE quality. Use a fresh process/module state for that probe; no real Llama import happened on this task's production parent path.
2. **Keep default auto-unload True for the staged diffusion workflow.** False intentionally holds a separate worker's GPU memory; Comfy model management cannot reclaim that worker's allocations. No automatic idle daemon/cache eviction/options were added.
3. Native load/generation is bounded to 600 seconds; pathological close/native abort is converted to an exact-child failure/cleanup rather than allowed to hang/abort the Comfy host. The real installation may still fail inside the isolated child; the parent must inspect the Chinese error and stderr tail rather than enable duplicate OpenMP runtimes.
4. Baseline and final plugin-import runs both emitted the existing `pynvml` deprecation and requests dependency-version warnings. They are not introduced by this fix. Git also emitted the existing LF->CRLF policy warning. No dependencies or line-ending policy were changed.
5. The full plugin import printed `成功导入 45 个节点` in baseline and final runs due to existing shared parent/user work. This task did not add/register a node and did not run or modify the separately reviewed task1/region tests/sources.

**Handoff:** source is ready for the parent's authorized real PE probe; keep the shared working tree as-is, without commit/merge/service start. Reported DONE is Task1c implementation/test completion, not whole-workflow or real-inference completion.
