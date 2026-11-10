# Local LLM GPU bootstrap plan

Goal: Restore GPU inference in the isolated worker without importing torch.

Verified cause: the isolated worker loads CPU and RPC backends only. Adding the existing torch/lib directory to both PATH and AddDllDirectory restores CUDA on RTX 4060 Ti without importing torch.

- [x] Write and run failing bootstrap tests; add a runtime-order mutation check.
- [x] Register existing runtime DLL paths before importing llama_cpp; retain handles.
- [x] Expose native backend diagnostics to the host without changing node fields.
- [x] Compare the identical seeded 64-token baseline: generation 17.44s CPU / 2.15s CUDA; load 1.75s / 5.86s. Full-node execution samples: T2I 35.784s, I2I 16.635s, reverse 15.202s; exclude queue wait.
- [x] Run worker, model compatibility, fusion, V3 and legacy regressions.
- [x] Update README; preserve version, node count, user settings and unrelated changes.
- [x] Restart ComfyUI only while idle, preserving the original launch arguments. Verify post-restart API execution before final delivery.
