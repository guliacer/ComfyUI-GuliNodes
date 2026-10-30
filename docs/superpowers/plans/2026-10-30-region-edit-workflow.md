# 人像与背景分区编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付无需 SAM3 或孤海节点运行依赖的 GG 手绘人像/背景编辑工作流，先背景后人像，保留构图、位置和外轮廓，并提供可验证的区域保护与懒求值跳过。

**Architecture:** 复用原生 LoadImage 画蒙版、原生 If/Else 懒求值、GG 遮罩裁剪/裁剪恢复/图像合并、GG Qwen 条件编码和提示词增强、原生 VAEEncode/SetLatentNoiseMask/KSampler。只新增 GGRegionEditPrepare：验证原始人像蒙版，生成当前区域的请求/锁定约束，以及基于原始需求的是否编辑信号。背景完成的全图是人物阶段的输入和恢复底图；每阶段最后以原始区域蒙版再次限域。

**Tech Stack:** ComfyUI、Python 3.10+、现有 torch；节点 V3 与 legacy 双路；UTF-8 JSON；Python unittest。

## Global Constraints

- 用户明确要求在当前安装的 ComfyUI-GuliNodes 中补齐缺失节点，生成可用工作流；人物姿态、位置、外轮廓基本保持不变。
- 当前安装目录已有用户未提交的遮罩模块、前端遮罩合并、注册和文档改动；保留这些修改，按当前文件内容定点编辑，不重置、不覆盖、不提交无关内容。
- 不创建未经用户同意的 worktree，不复制一个脱离当前安装的插件；本任务在用户指定安装目录工作，不自动提交或升级版本。
- 主插件零额外强制 Python 依赖；不引入 cv2/scipy/kornia，不复制分割模型或重新实现已有裁剪恢复。
- 新增节点显示名、参数、输出、错误与 tooltip 全中文（IMAGE/MASK 等技术类型除外），分类为 GuliNodes/图像。
- 输出固定且始终声明、显示；不写输出隐藏补丁，不改已有节点ID或输出下标。
- 两种API分支都测：导入前 sys.modules['comfy_api.latest']=None 强制 legacy。
- 空白编辑需求只看原始字符串 strip；不得根据追加固定约束后的文本判断是否编辑。
- 有编辑需求时，单张 IMAGE/MASK 同尺寸、有限值；人像白区与当前目标白区按 MASK>0.1 的有效像素占比至少0.002；全白人像拒绝，防已有裁剪的整图回退。
- 不宣称提示词可数学保证人物内部姿态/身份；区域保护和原画幅则由合成测试证明。
- 不启动替代GUI/服务，不下载模型，不写API密钥；实测仅使用已存在的 ComfyUI http://127.0.0.1:8188。
- README 改动写在“未发布”，补完整来源URL/引用关系；pyproject.node_count以真实映射数为准，version保持现值。

## Task 1: 单一分区准备节点

**Files:**
- Create: `guli_nodes/region_edit.py`
- Create: `tests/test_region_edit.py`
- Modify by controller after tests: `guli_nodes/__init__.py`（只给 `_NODE_MODULES` 增加 `region_edit`）

**Interfaces:**
- `prepare_region(图像, 人像遮罩, 处理区域='人像', 编辑需求='', 全局要求='') -> tuple[IMAGE, MASK, str, str, bool]`
- Registered ID: `GGRegionEditPrepare`; display: `GG 分区编辑准备`.
- Inputs in fixed order: 图像 IMAGE、 人像遮罩 MASK、处理区域 COMBO[人像,背景]、编辑需求 multiline STRING、全局要求 multiline STRING。
- Outputs in fixed order: 图像 IMAGE、区域遮罩 MASK、区域请求 STRING、锁定约束 STRING、是否编辑 BOOLEAN。
- Empty request: return original RGB image, correctly-sized zero mask, empty request, region constraint, False; no mask required to validate a no-op.
- Active request: accept MASK HW/BHW and singleton B1HW; require single-image BHWC (RGB or RGBA). Preserve underlying RGB when stripping alpha; do not replace masked original RGB by white. Reject non-finite, invalid mask range, mismatch, empty/tiny human mask, all-white human mask, and tiny active target mask with actionable Chinese errors. Return person M or background 1-M, preserve soft weights, never mutate inputs. Use exact counts to compare cutoff to avoid float32 boundary rounding.
- Region request includes trimmed user text, target description, and trimmed shared rules. Fixed constraint explicitly keeps identity, pose, position, proportions, outer silhouette, canvas/camera/perspective, and excludes the other region. Workflow appends this constraint after optional enhancement.
- No new UI extension and no DynamicCombo needed: all parameters are effective in both region choices.

- [ ] Write tests first. Load new module in isolation; if absent, tests fail with explicit assertion rather than a typo/import-path failure.
- [ ] Run RED:
  ```powershell
  & 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_edit.py -v
  ```
  Expected: failures because `GGRegionEditPrepare` is not implemented.
- [ ] Implement the helper and V3/legacy wrappers only in new module.
- [ ] Run GREEN, covering empty/whitespace requests, person/complement masks, global text not enabling a branch, original tensor unchanged, valid singleton shapes, single-image restriction, no-alpha 64x64 black mask, range/NaN/Inf checks, exact minimum cutoff, full-white and tiny target rejection, both API schemas/output orders.
- [ ] Controller adds registration, imports plugin and checks zero failed modules.
- [ ] Fresh reviewer checks spec and code quality from the new files and test evidence; fix Important/Critical findings before workflow delivery.

## Task 2: 自包含工作流与使用说明

**Files:**
- Create: `examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json`
- Create: `examples/workflows/GG-人像背景分区编辑_使用说明.md`
- Create: `tools/build_region_edit_workflow.py`
- Create: `tests/test_region_workflow.py`
- Copy deliverable to ComfyUI `user/default/workflows/` without replacing the original reference workflow.

**Graph contract:**
1. LoadImage outputs original IMAGE and painted person MASK.
2. RegionPrepare background → existing GGMaskCrop (填充false、统一扩展1.1、按宽高768×768，32对齐) → condition reference encoding + VAEEncode + SetLatentNoiseMask → KSampler → VAEDecode → GGCropRestore with 0扩展/0羽化/0颜色修正 → GGImageMergeMask with original background mask, opacity1, dilation0, blur0.
3. ComfySwitchNode uses background prepare output4; false uses stage input, true uses the protected background result. No independent Preview/Save output on the unused branch.
4. RegionPrepare person uses selected background full-image as its image input, but the same initial LoadImage person MASK → analogous crop/encode/sample/restore → merge using original person mask → second ComfySwitchNode.
5. Only the final selected image and original image connect to GG image comparison; final selected image connects to PNG save.
6. Each region has GGPromptEnhancer and a STRING ComfySwitchNode controlled by one visible PrimitiveBoolean “启用AI提示词优化”. False uses prepared request; true uses enhanced text. Both append fixed constraints through GGTextConcat after switch. Do not store credentials. Configure a known local model only if its header/handler compatibility is confirmed; otherwise enhancement stays optional and disabled by default, with exact enable instructions rather than a silently broken API.
7. GGPromptOptimizer is condition encoding, not AI rewriting; use resolution0 and crop reference. VAEEncode is original-image latent, never GG empty latent. Core KSampler settings use cfg1/euler/simple, 9steps, denoise person0.25/background0.45 as conservative editable starting points; document that this is not an exact copy of the old ManualSigmas route.
8. Models match verified reference files: Qwen2.1 Turbo int8 diffusion, Qwen3VL int8 CLIP(type qwen_image), Qwen2.1 VAE, optional existing consistency LoRA. No SAM3/Goohai node IDs in graph.
9. All links and widget inputs are built from known object_info schemas. V3 dynamic input API uses prefixed keys (e.g. 输出尺寸.宽度、图像.图像1、图片.图片1), not nested API objects. Validate UI widgets against actual frontend serialization rather than guessing.

- [ ] Write workflow contract tests before builder: missing file, missing type/model, cycles, invalid endpoint/output/input references, absence of MASK gate, wrong sequence input, wrong crop settings, independent unused outputs, absent fixed constraints, invalid dynamic serialization, incompatible dimensions.
- [ ] Run RED:
  ```powershell
  & 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_workflow.py -v
  ```
- [ ] Builder reads live and locally-defined schema metadata, creates groups with Chinese usage labels, emits workflow and API validation fixture. Read any existing destination before replacing it.
- [ ] Run graph tests and ComfyUI prompt validation using local definitions/new node mapping (without queuing a model load for invalid/empty inputs).
- [ ] Document painting method, white/black meaning, regional requests, clear-to-skip behavior, 768/1024 sizes, local optional enhancer limitations, restart requirement, pose limitations, output location.

## Task 3: 文档、验证与交付

**Files:** Modify `README.md`, `pyproject.toml`; Create `docs/superpowers/plans/2026-10-30-region-edit-progress.md` as this task's local ledger.

- [ ] Add new node to main capabilities, node list, counts, compatibility/FAQ and 未发布; extend Goohai workflow credit as 思路参考 with https://github.com/goohai/Goohaitools-comfyui; retain all existing credits and version.
- [ ] Syntax checks and actual plugin mapping count (baseline44) with zero failed modules. New node expected45 before any separately-justified changes.
- [ ] Run full new test suite, including legacy and V3. Test end-to-end synthetic tensor crop/edit/restore/merge against exact unchanged pixels outside region; verify background result remains in person-stage bottom image.
- [ ] Where possible verify import in existing ComfyUI frontend after refresh/restart or explicitly report no restart/model run. Never restart or replace the running service solely to claim GUI verification.
- [ ] Run one controlled actual generation only when current service/new registry availability and model resources permit; report precise scope. Prefer valid failure/no-op runtime tests before any expensive model job.
- [ ] Independent final review checks integration, extra dependencies, graph contracts and docs. Collect every relevant background job.
- [ ] Present the complete JSON and usage document, primary results inline, distinguish automated tests from actual model/GUI tests, leave unrelated user changes intact.
