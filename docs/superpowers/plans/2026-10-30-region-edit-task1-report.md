# Task 1 report — GG 分区编辑准备

## 状态与范围

**DONE_WITH_CONCERNS**：消费端精度复审修复已完成；最新 **节点测试 43/43、真实集成测试 4/4 通过**，本次 2/2 消费端守卫变异被检测，2/2 内存语法编译通过。首次交付 RED40/GREEN41 与 7/7 变异证据保留在历史章节；最新修复证据见末尾追加章节。环境仍有既有 `pynvml` FutureWarning，真实集成导入还提示 requests 依赖版本警告；未更改依赖。

先读了 [Task 1 brief](<docs/superpowers/plans/2026-10-30-region-edit-task1.md>) 和 [AGENTS.md](<AGENTS.md>)，使用继承的当前模型，未调用其他子代理。

本子任务只创建/编辑以下三个文件：

| 文件 | 内容 |
| --- | --- |
| [region_edit.py](<guli_nodes/region_edit.py>) | 单个准备节点、纯 helper、legacy/V3 双路、模块自己的一个节点映射 |
| [test_region_edit.py](<tests/test_region_edit.py>) | 当前 43 个契约测试；真实 torch、本机真实 V3 类型/Schema/NodeOutput、隔离导入 |
| [本报告](<docs/superpowers/plans/2026-10-30-region-edit-task1-report.md>) | TDD、验证、范围与交接证据 |

没有改全局注册器、已有图像/遮罩/提示词模块、现有前端、[README](<README.md>) 或元数据；没有 worktree、提交、下载、服务启动、模型权重加载或推理排队。首次交付仅隔离导入；本次真实集成按父代理明确授权允许已有模型定义模块导入，不调用模型加载/LLM/采样器。父代理并行写入的工作流/工具不属于本子任务修改。

## 设计自检与选择

1. **必要性**：明确授权的准备/安全适配节点，不重复实现分割、遮罩编辑、LLM 或生成。
2. **闭环**：helper、双路执行与 Schema、中文错误/提示及本报告完整；注册、用户文档与工作流按 brief 留给父代理。
3. **更优方案**：比较扩展既有遮罩/提示词模块与独立 helper + 薄包装；选择后者，避免越界和端口下标变化。复用已检查的 [text_tools.py](<guli_nodes/text_tools.py#L127-L150>) 中 `_join_texts`，该模块仅引入标准库与 `folder_paths`，不强制模型导入；未导入插件聚合注册器。
4. **中文**：显示名、参数、选项、输出、约束、错误、tooltip 全部中文，保留 RGB/RGBA、IMAGE、MASK 等技术名称。
5. **简化**：恰好五个输入、五个固定输出，无新增控制器、前端或端口隐藏。
6. **收尾**：证据写入授权报告；[README](<README.md>)、节点计数、注册和工作流由父代理处理，不改版本。

## 精确交付契约

- ID：`GGRegionEditPrepare`；显示名：**GG 分区编辑准备**；分类：`GuliNodes/图像`。
- 五个顺序输入：**图像 IMAGE、人像遮罩 MASK、处理区域 COMBO[人像,背景]（默认人像）、编辑需求 multiline STRING（默认空串）、全局要求 multiline STRING（默认空串）**。
- 五个固定顺序输出：**图像 IMAGE、区域遮罩 MASK、区域请求 STRING、锁定约束 STRING、是否编辑 BOOLEAN**。全部由后端静态声明并保持可见。

```python
prepare_region(图像, 人像遮罩, 处理区域='人像', 编辑需求='', 全局要求='')
# -> (图像, 区域遮罩, 区域请求, 锁定约束, 是否编辑)
```

- 单张 BHWC，C 为 3/4，非空宽高、有限数值、0–1。RGBA 只去 alpha，保留底层 RGB；包括 alpha 在内的非法数值先校验。无原地修改、缩放或白底合成。
- 只有 `编辑需求.strip()` 能启用编辑。空/空白需求返回原 RGB、同尺寸全黑 `[1,H,W]` float32 MASK、空请求、当前区域固定约束、False；不检查 MASK。图像和处理区域仍校验，全局文本不能启用编辑。
- 活跃 MASK 只接受 `[H,W]`、`[1,H,W]`、`[1,1,H,W]`；拒绝批次、错误维度、尺寸不一致、非有限值和越界值。全黑 64×64 占位在通用尺寸错误之前给出 **“请在加载图像的遮罩编辑器涂选人物并保存”**。
- 先验证原人物 `M > 0.1` 像素数，拒绝不足 0.002 或按阈值覆盖全图，并验证人物的消费端 `.float() > 0.1` 像素数；然后计算人像 M/背景 1−M，验证当前目标的原始与消费端表示都至少 0.002。全部使用 **`count * 500 < H * W`** 的整数比较；恰好 0.002 仅在两种表示均有效时接受。
- 保留浮点 MASK 的原始精度与软权重用于最终合成，整数/布尔 MASK 转 float32，输出搬到图像设备；不填洞、不扩张、不二值化。若 float32 转换使消费端有效面积不足，必须拒绝并给出中文精度/阈值建议；不能只靠保留输出精度放行。
- 区域请求包含编辑目标、去首尾空白后的需求与可选全局文本，保留段内换行。固定约束独立于用户需求/全局文本：保持原图人物身份、姿态、位置、比例、外轮廓基本不变，相同画布/镜头/透视，禁止编辑另一区域，并说明另一区域仅作上下文、不是目标。

## 首次交付 TDD 证据（RED40 / GREEN41）

所有主测试阶段都从插件根运行同一命令：

```powershell
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_edit.py -v
```

测试自己将 ComfyUI 根与插件根加进 `sys.path`。初始 RED 在调用前额外确认生产文件不存在：

```powershell
if (Test-Path -LiteralPath guli_nodes\region_edit.py) { throw 'RED requires absent production region module' }
```

| 阶段 | 实测结果 | 原因/处理 |
| --- | --- | --- |
| 初始 RED，生产模块尚不存在 | 40 tests，39 failures，exit 1，0.143s | 每个失败明确为 `AssertionError: Missing region module/feature: guli_nodes/region_edit.py does not exist`；真实安装 V3 API smoke 通过。无错拼导入或宿主错误。 |
| 最小实现后的第一次 GREEN 尝试 | 40 tests，1 error，exit 1，0.526s | 软背景边界测试把整图 M 设为 1，仅 20 像素改为 0.8，因此全部 10000 像素仍 >0.1，契约应判全白人物；不是生产安全规则错误。 |
| 修正测试造景后 GREEN | 40/40，exit 0，0.665s | 数值诊断：M=0.8 造景 human=10000/10000、background=20；其中一个像素设为真背景 0 后 human=9999、background 仍=20。仅修正无效样本，不放松实现规则。 |
| 软权重精度新增 RED | 41 tests，2 failures + 1 error，exit 1，0.519s | 原 float64 MASK 中 2 个像素 `0.1 + 2**-32` 有效；转 float32 后有效像素=0。CPU/CUDA 的浮点精度断言同时失败。 |
| 精度最小修复后 GREEN | 41/41，exit 0，0.437s | 仅保留原浮点 dtype，整数/布尔仍转 float32。 |
| 变异验证后的最终 fresh GREEN | **41/41，exit 0，0.468s，OK** | 源/测试为最终交付内容，无失败、无跳过。 |

最终测试环境：**Python 3.13.11，torch 2.10.0+cu130，CUDA available=True**。CPU 与 CUDA 的设备/权重测试实际执行；无模型加载。

### 覆盖与真实 API 说明

[契约测试](<tests/test_region_edit.py>) 覆盖：

- 空需求/空白需求、None/非法 MASK 忽略、全局文本不能启用。
- 人像与互补背景、软边缘/洞原样保留、RGB/RGBA 保真、输入不变。
- 三种 MASK 形状、批次/非法维度、尺寸不一致、NaN/Inf/范围、64² 空占位。
- 非法图像（含空宽高/批次/通道/alpha）和区域在 no-op 时仍拒绝。
- 原人物太小不能靠反相变有效；原人物全白按 >0.1 拒绝；仅背景太小时人像仍可处理。
- 人物和背景恰好 0.002、不能被 500 整除的画布、严格 >0.1、float64 临界软权重。
- 用户冲突文本不能更改固定约束；文本 trim、目标名、段内换行、可选全局部分。
- legacy/V3 的五输入与五输出顺序/类型/默认值、中文 tooltip、模块映射与执行一致性。

V3 不是伪 Schema：只用 package-only `comfy_api.latest` 宿主跳过聚合入口的音视频/UI 导入，随后从本机加载真实 `_input`、`_io_public`、`_io`，断言类来源为 `comfy_api.latest._io`。检查了本机 [_io.py](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/comfy_api/latest/_io.py#L2210-L2234>)，测试通过真实 `GET_SCHEMA`、`GET_NODE_INFO_V1` 和 `FUNCTION` 指向的 `EXECUTE_NORMALIZED` 调用，不只直接调用 helper。

legacy 每次重新导入前明确执行 `sys.modules['comfy_api.latest'] = None`，断言 `io is None` 且节点没有 `define_schema`，运行真实 legacy `execute`。

导入隔离的 finder 禁止模型、服务、插件注册器与 Goohai/cv2/scipy 导入。验证末尾这些禁用模块实际载入清单为 **`[]`**。没有 mock 张量逻辑或返回值。

## 首次交付反向验证和语法证据

只将源文本变异后在内存中 `compile/exec`，复用测试的隔离 loader 与原断言；磁盘生产文件未被改坏，也没有临时文件或 pyc。

| 内存变异 | 对应测试检测结果 |
| --- | --- |
| 背景错误返回 M，而非 1−M | 1 failure |
| 跳过反相前人物最小面积校验 | 1 failure |
| 将人物恰好 0.002 也拒绝（`<` 改 `<=`） | 3 expected errors |
| 让全局文本启用空编辑需求 | 2 expected errors |
| RGBA 合成白底 | 3 failures |
| 删除固定人物身份约束 | 2 failures |
| 交换 V3 区域请求/锁定约束输出槽 | 1 failure |

运行工具输出：

```text
Python: 3.13.11 torch: 2.10.0+cu130 CUDA available: True
In-memory syntax compile: 2/2 PASS; no pyc written
wrong complement: DETECTED (1 failures, 0 expected errors)
skip human minimum before inversion: DETECTED (1 failures, 0 expected errors)
reject exact .002 human boundary: DETECTED (0 failures, 3 expected errors)
global text enables empty demand: DETECTED (0 failures, 2 expected errors)
white composite RGBA: DETECTED (3 failures, 0 expected errors)
remove fixed identity constraint: DETECTED (2 failures, 0 expected errors)
wrong V3 output order: DETECTED (1 failures, 0 expected errors)
Reverse verification: 7/7 mutations detected; production files never changed
Forbidden model/registry modules loaded: []
```

复现反向验证（同插件根、portable Python、`-B`）：

```powershell
@'
import io, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path('tests').resolve()))
import test_region_edit as t
source = t.MODULE_PATH.read_text(encoding='utf-8')
for path in (t.MODULE_PATH, Path(t.__file__)):
    compile(path.read_text(encoding='utf-8'), str(path), 'exec')
mutations = [
    ('区域遮罩 = 遮罩 if 处理区域 == "人像" else 1 - 遮罩', '区域遮罩 = 遮罩', 'RegionHelperTests.test_background_is_exact_complement_not_a_second_selection'),
    ('if 人物像素 * 500 < 总像素:', 'if False:', 'RegionHelperTests.test_tiny_original_human_cannot_become_valid_by_inversion'),
    ('if 人物像素 * 500 < 总像素:', 'if 人物像素 * 500 <= 总像素:', 'RegionHelperTests.test_exact_point002_human_area_is_accepted'),
    ('if not 需求:', 'if not 需求 and not 全局要求.strip():', 'RegionHelperTests.test_global_text_alone_cannot_enable_editing'),
    ('return 图像 if 图像.shape[3] == 3 else 图像[..., :3]', 'return 图像 if 图像.shape[3] == 3 else 图像[..., :3] * 图像[..., 3:4] + 1 - 图像[..., 3:4]', 'RegionHelperTests.test_rgba_drops_alpha_without_white_compositing_or_input_mutation'),
    ('保持原图人物的身份', '保持原图人物的颜色', 'RegionHelperTests.test_fixed_constraints_survive_conflicting_user_and_global_text'),
    ('io.String.Output("区域请求", tooltip=_OUTPUT_TOOLTIPS[2]),\n                    io.String.Output("锁定约束", tooltip=_OUTPUT_TOOLTIPS[3]),', 'io.String.Output("锁定约束", tooltip=_OUTPUT_TOOLTIPS[3]),\n                    io.String.Output("区域请求", tooltip=_OUTPUT_TOOLTIPS[2]),', 'RegionNodeAPITests.test_real_v3_schema_order_names_types_and_serialized_ports'),
]
original_loader = t.load_region
for old, new, name in mutations:
    assert source.count(old) == 1
    mutated = source.replace(old, new, 1)
    compile(mutated, str(t.MODULE_PATH), 'exec')
    try:
        t.load_region = lambda legacy=True, source=None, mutated=mutated: original_loader(legacy=legacy, source=mutated)
        result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(unittest.defaultTestLoader.loadTestsFromName(name, t))
    finally:
        t.load_region = original_loader
    assert result.testsRun == 1 and not result.wasSuccessful(), name
    print(name, 'DETECTED', len(result.failures), len(result.errors))
print('7/7 mutations detected; syntax compile 2/2 PASS')
'@ | & 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -
```

## 既有改动保护

初始状态有用户未提交的注册/图像/比例/文档/元数据修改，以及未跟踪遮罩模块和前端。下列 SHA-256 在本任务前后逐字一致：

| 保护文件 | SHA-256 |
| --- | --- |
| [mask_tools.py](<guli_nodes/mask_tools.py>) | `35ED7953C4A0C859A04A93C20610063A825C715F86DAB4DABDA01EF83C08F878` |
| [gg-image-merge-mask.js](<web/gg-image-merge-mask.js>) | `86CB3D6F11B46127ED8FA148C0C476E411FC1E7E1C2A3449880FEFE0048F26AA` |
| [image_tools.py](<guli_nodes/image_tools.py>) | `9B01ABE947282F5AFCB147BCD8DF83F4375819837271DB775A4E260B19150249` |
| [aspect_ratio.py](<guli_nodes/aspect_ratio.py>) | `FA1B10201CD82F67A7F838559BC29ADF0A5472435A7C1B270E2B97D3C6EB9758` |

## 首次交付限制与父代理交接（复审补充见末尾）

- 本任务仅准备数据/约束，不生成图像、不证明下游模型遵守文本约束。下游区域裁剪、生成、合成与最终保真验收由父代理工作流处理。
- 不执行插件聚合入口、全局注册或真实 GUI/服务重启；真实 V3/legacy API 的本地执行/序列化契约已验证，父代理负责加入模块清单和集成检查。
- 与精确五输入契约一致，Schema 保留 MASK 接口；no-op 可传 None/无效 MASK 的保证发生在 helper/执行阶段，未改 ComfyUI 的全局接线校验或添加前端/lazy 补丁。
- 已有 torch 导入警告全文：`FutureWarning: The pynvml package is deprecated. Please install nvidia-ml-py instead.` 不是本节点新增依赖或失败，按授权没有处理环境依赖。
- [region_edit.py](<guli_nodes/region_edit.py>) 的模块映射只提供一个新 ID。父代理处理注册、工作流、[README](<README.md>)/元数据；本子任务到此停止，无提交。

## 追加：2026-10-30 消费端 float32 精度复审修复

**本节为当前结论，取代首次交付中“float64 刚超过阈值即可接受”的期望。** 已按[修订 brief:12](<docs/superpowers/plans/2026-10-30-region-edit-task1.md#L12>) 的明确集成安全决策落实；只修改原授权的准备模块、其单测与本报告。

### 复现与最小改动

- 实际 [mask_tools.py:77–88](<guli_nodes/mask_tools.py#L77-L88>) 在 `_遮罩数组` 中先转 float32，再在 [裁剪:403–406](<guli_nodes/mask_tools.py#L403-L406>) 按 >0.1 求占比；不足 0.002 会整图回退。保留输出原精度本身不能保证消费端安全。
- 人物回归样本：500 像素中 1 个 float64 权重 `0.1 + 2**-32`，原始有效 count=1（恰好 0.002），消费端 count=0。人物和背景请求都必须在反相前拒绝这个原人物 MASK。
- 背景回归样本：1000 像素中背景原始 count=2（恰好 0.002），其中 1 个接近阈值，消费端 count=1（0.001）；人物的消费端 count=999 仍安全。仅当前背景目标应拒绝，人像请求仍可处理。
- 保留既有原始 count 校验，仅增加人物反相前和当前目标反相后的两个消费者等价整数 count 守卫：

```python
消费人物像素 = torch.count_nonzero(遮罩.float() > 0.1).item()
if 消费人物像素 * 500 < 总像素:
    raise ValueError("人像遮罩转为 float32 后有效区域不足 0.2%（精度导致像素落到 0.1 阈值），请重新涂选人物并让有效权重明显高于 0.1。")
# 区域遮罩保持原始精度的人像 M 或背景 1-M。
消费区域像素 = torch.count_nonzero(区域遮罩.float() > 0.1).item()
if 消费区域像素 * 500 < 总像素:
    raise ValueError(f"{处理区域}区域转为 float32 后有效面积不足 0.2%（精度导致像素落到 0.1 阈值），请检查人物涂选并让当前区域的有效权重明显高于 0.1。")
```

返回软权重、RGB、no-op、固定约束、五输入/五输出的名称/数量/顺序及双路 API 不变。原“近阈值必须接受”单测改用 `0.1001 + 2**-32` 的安全精度样本，仍断言软权重原样保留并接受恰好 0.002；新增人物/背景消费端归一化拒绝回归。不修改真实消费者或父代理集成测试。

### 本次 RED / GREEN 命令与输出

从插件根运行，解释器仍为 portable Python：

```powershell
# 先写两条消费端回归，再在生产功能修改前运行 focused RED。
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_edit.py -k consumer_cutoff -v
# 修复前后均直接运行同一真实消费者测试，文件不改、不 mock、不 source-extract。
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_integration.py -v
# 最小修复后的完整节点 GREEN。
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B -m unittest discover -s tests -p test_region_edit.py -v
```

| 阶段 | 实测命令结果 |
| --- | --- |
| focused RED | **Ran 2 tests in 0.015s；FAILED (failures=3)，exit 1**；全部是 `AssertionError: ValueError not raised`，分别为人物请求、背景请求的原人物归一化，以及当前背景目标归一化。无拼写/导入失败。 |
| 真实消费者 RED | **Ran 4 tests in 0.011s；3 PASS / 1 precision FAIL，exit 1**；与父代理复现一致，失败为 `ValueError not raised`。该后台命令结果已收集。 |
| 完整节点 GREEN | **Ran 43 tests in 0.460s；OK，exit 0**；含真实 V3/legacy、CPU/CUDA、no-op、原始和消费端的 0.002 可表示权重边界及软权重保留。 |
| 原文件真实集成 GREEN | **Ran 4 tests in 0.010s；OK，exit 0**；真实背景/人物裁剪恢复合并 roundtrip、RGBA 原 RGB 保留、实际 `_遮罩数组` 精度回归全部通过。输出 `成功导入 45 个节点`。 |

真实集成按父代理专门授权允许插件与已有 Comfy/model-definition 类定义导入；没有模型权重加载、LLM/采样器调用、推理排队、服务、下载或其他代理。隔离单测继续使用原真实 V3 API host。此次不是源抽取/假消费者证明。

### 本次反向验证、语法与未改文件证据

在内存中分别将 `if 消费人物像素 * 500 < 总像素:` 与 `if 消费区域像素 * 500 < 总像素:` 改为 `if False:`，用原新回归断言运行：

```text
Syntax compile: 2/2 PASS, no artifacts
human consumer guard removed DETECTED 2 failures 0 errors
target consumer guard removed DETECTED 1 failures 0 errors
Consumer guard reverse verification: 2/2 PASS; source never changed
```

没有写临时文件/pyc，也没有修改磁盘实现进行变异。此次前后 SHA-256 完全一致：

| 未改文件 | SHA-256 |
| --- | --- |
| [mask_tools.py](<guli_nodes/mask_tools.py>) | `35ED7953C4A0C859A04A93C20610063A825C715F86DAB4DABDA01EF83C08F878` |
| [test_region_integration.py](<tests/test_region_integration.py>) | `5364EA8EBAC9282B60CA63A9F517B61C880E01CDD366A03E24D3E03AE7078348` |
| [gg-image-merge-mask.js](<web/gg-image-merge-mask.js>) | `86CB3D6F11B46127ED8FA148C0C476E411FC1E7E1C2A3449880FEFE0048F26AA` |

**当前关注项**：只有既有 torch `pynvml` 弃用警告，以及实际集成导入时既有 `RequestsDependencyWarning`（urllib3 2.6.3 / chardet 7.1.0 / charset_normalizer 3.4.5）；不处理环境依赖。下游真实裁剪/恢复/合并已做张量验证，但没有生成模型或实时 GUI 验证。按授权停止，交父代理复审，无提交。
