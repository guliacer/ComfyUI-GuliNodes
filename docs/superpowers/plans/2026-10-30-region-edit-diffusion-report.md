# 分区编辑工作流：单次真实扩散验证报告

## 结论：DONE（执行链路通过，非绝对保真或画质提升保证）

2026-10-30 使用本机 portable Python，在**新建的独立 Python 进程**中调用真实 ComfyUI `PromptExecutor`，完成背景 → 人像两阶段 Qwen2.1 Turbo 扩散。两个采样进度均达到 **9/9**，进程退出码 **0**，`execution_success` 已记录，探针结果为 `success: true`、`errors: []`。

- **PromptExecutor 用时：44.52 秒**（不含进程启动、导入、输入准备与前置校验）。
- **完整进程墙钟用时：62.41 秒**。
- 两阶段处理裁剪均为 **512×512**；保存结果为 **1080×1920 RGB PNG**，保留原始画布尺寸。
- **AI 提示词增强关闭**。本次不验证本地 PE、本地 LLM、API 增强或正在修改的 LLM 隔离实现。
- 只执行这一轮扩散；无需任何测试脚本修复，未修改实现源码、模型、原图、用户遮罩或工作流 JSON。

**实际结果：** [分区_实际生成_00001_.png](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/output/GG_验证/分区_实际生成_00001_.png>)。

**机器结果：** [region_edit_diffusion_probe.json](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/region_edit_diffusion_probe.json>)。

## 1. 执行记录与范围

| 项目 | 本次实测 |
| --- | --- |
| 开始时间 | 2026-10-30T19:36:53.6990486+08:00 |
| 结束时间 | 2026-10-30T19:37:56.1137396+08:00 |
| 后台作业 | `pwsh-385b11ceef5841c5`；完成通知后收集一次，未忙轮询、未重复启动 |
| 执行方式 | 新进程内调用真实 `execution.PromptExecutor`，仅指定输出节点 `51` |
| 网络/服务范围 | 只读既有 `127.0.0.1:8188/queue` 确认队列空闲；未提交 HTTP 生成请求，未启动或替换 HTTP 服务 |
| 用户 ComfyUI | 未停止、重启或修改 PID `23012` |
| 源码改动 | **无**；测试脚本改动也为 **无** |
| GPU 任务 | 唯一扩散测试；未并行运行 PE/LLM；作业退出后已通知父会话释放 GPU 预留 |
| 新增制品 | 专用 RGBA 测试输入、实际生成 PNG、探针 JSON 和本报告 |

工作目录为本插件仓库。实际 Python 命令如下，PowerShell 包装仅增加起止时间及退出码记录：

```powershell
$env:PYTHONIOENCODING='utf-8'
& 'W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe' -B tools/probe_region_diffusion.py
```

执行前首先阅读 [probe_region_diffusion.py](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/probe_region_diffusion.py>) 与 [AGENTS.md](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/AGENTS.md>)。

## 2. 导入、测试输入与测试台兼容性

### 导入预检

执行前在另一个仅做导入和图片元数据读取的 portable Python 进程中检查：

```json
{
  "failed_modules": {},
  "loaded_module_count": 22,
  "registered_nodes": 45,
  "llama_cpp_modules": []
}
```

实际扩散进程再次导入成功，并通过脚本内 `assert not guli_nodes.FAILED_MODULES`。未出现需要等待父会话处理的瞬时源码导入错误。

AI 开关在内存中的 API 图固定为 `false`，两个增强分支经过原生 lazy `ComfySwitchNode`。本机 [nodes_logic.py:86–116](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/comfy_extras/nodes_logic.py#L86-L116>) 显示，仅选中的 `on_false` 分支请求执行；[prompt_enhancer.py:578–604](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/guli_nodes/prompt_enhancer.py#L578-L604>) 中 LLM bridge 导入位于按需加载函数内，而非模块顶层。这里的证据是开关配置、真实 lazy 实现和导入预检；本次探针未持久化全部节点事件或原生库加载审计，**不将其扩展为 LLM 隔离功能的验证结论**。

### 专用粗略涂选输入

- 原图：[77d2c42db7b0e56286aec070a54d1437.png](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/input/77d2c42db7b0e56286aec070a54d1437.png>)，1080×1920 RGB PNG。
- 专用输入：[GG_region_validation_masked.png](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/input/GG_region_validation_masked.png>)。启动前发现该文件不存在，脚本因此只新建它一次，没有复用或覆盖用户文件。
- 涂选由脚本中明确列出的粗略手绘多边形坐标产生，**不是自动人像分割、精细抠图或遮罩编辑器交互实测**。
- PNG RGB 通道与原图逐像素完全一致；仅加入 alpha。alpha 为 `0` 的人物涂选共 **828,745** 像素（**39.9665%**），alpha 为 `255` 的互补区域共 **1,244,855** 像素；ComfyUI `LoadImage` 将 alpha 反相得到 MASK。
- 已通过 `read_image` 阅读原图、实际结果及专用 RGBA 输入；输入真实性另以 CPU 像素检查确认，不依据透明 PNG 预览外观推断 RGB 已被破坏。

### 不需要测试台修复

核对本机实际 core，而非假定缓存接口：

- [execution.py:121–142](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/execution.py#L121-L142>)：默认使用 classic 分层缓存。
- [execution.py:748–749](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/execution.py#L748-L749>)：执行时直接读取 `ram`、`ram_inactive`；探针已提供二者。
- [progress.py:207–213](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/comfy_execution/progress.py#L207-L213>)：预览路径读取 `server.sockets_metadata`；探针的 `LocalServer` 已包含空字典。
- 探针没有使用“缓存占位键存在即表示节点执行”的错误判定。

因此无需修改缓存判断、server 桩或任何源码。

## 3. 两阶段实际配置

以已构建并经前端序列化的 [region_edit_browser_validation.json](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/region_edit_browser_validation.json>) 中 `output` 图为输入。脚本深拷贝后只在内存中替换专用输入、AI 开关、两处裁剪尺寸、保存前缀与保存后内存清理开关；没有写回工作流。

模型选择沿用现有配置，未下载、替换或实验模型：

```text
UNET: qwen\qwen_image_2.1_turbo_int8_convrot.safetensors
VAE:  qwen\qwen_image_2.1_vae_bf16.safetensors
CLIP: qwen\qwen3vl_8b_int8_convrot.safetensors
LoRA: qwen\编辑\Qwen2.1 一致性无偏移_GH_V1.0.safetensors（强度 1）
```

这里的 Qwen CLIP 是扩散所需条件编码，不等于开启提示词增强。

| 阶段 | 背景 | 人像 |
| --- | --- | --- |
| 裁剪输出 | 512×512，四边统一扩展系数 1.1 | 512×512，四边统一扩展系数 1.1 |
| 区域 | 人物涂选的反相 | 原始人物涂选 |
| 请求 | 保持场景结构与物体位置，优化曝光、色彩和材质细节 | 优化皮肤、发丝、服装质感，并要求保持脸型、身份、姿态等 |
| KSampler | `18` | `38` |
| seed | `246813579` | `246813580` |
| steps / cfg | `9 / 1` | `9 / 1` |
| sampler / scheduler | `euler / simple` | `euler / simple` |
| denoise | `0.45` | `0.25` |

每阶段实际经过 VAE 编码、latent noise mask、扩散采样、VAE 解码、坐标还原及原区域遮罩再次限域合成。还原时遮罩扩展/羽化/颜色还原均为 0；最终原遮罩合成不扩展、不模糊。日志中两次独立采样均达到 9/9，排除“仅验证图或只返回原图”的空跑结论。

## 4. 保存及完整性证据

保存结果为 [分区_实际生成_00001_.png](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/output/GG_验证/分区_实际生成_00001_.png>)：

- Pillow 确认实际格式 **PNG**，模式 **RGB**，尺寸 **1080×1920**，字节数 **1,928,942**。
- 结果像素确实不同于原图，两块互补区域都有变化。
- 原图运行前/后的 SHA-256 一致，专用输入 RGB 又与其完全一致；确认没有改变原始照片。

```text
原图 SHA-256（前后相同）:
a301c1ee640da55c47cdab42a583cc7e3c00474aab581f59f9e545c080cfbf69

专用 RGBA 输入 SHA-256:
9d8addce11efad1a7979dbf08b14b5f10555bae0845e482dd2795bd9b21c8bea

实际 PNG 结果 SHA-256:
ad3686afab6b4cfe354cfaff9e8ccced4cadaf3994207e910890b99786fc50cf
```

CPU 对最终结果与原图进行对照（8-bit RGB）：

| 区域（按粗略涂选分区） | 发生至少一个通道变化的像素比例 | 每通道平均绝对差（0–255） |
| --- | --- | --- |
| 手绘人物区域 | 99.3833% | 6.7774 |
| 互补背景区域 | 99.5705% | 5.9133 |

这些数值只证明最终图不是原图空返回；两阶段均启用时二者联合覆盖全图，**不能用最终图反推单阶段绝对无泄漏，也不是身份、姿态或画质评分**。

关键进程输出：

```text
execution_success {'prompt_id': 'gg-region-diffusion-check', 'timestamp': 1793360273510}
success=true; seconds=44.52; crop_size=[512,512]; ai_enhancement=false; errors=[]
background sampling: 9/9
portrait sampling: 9/9
WALL_SECONDS 62.41 EXIT 0
```

stderr 只有现有环境的 `pynvml` 弃用警告、`requests` 依赖版本警告及两段正常采样进度；无执行错误。未为警告安装或更换依赖。

## 5. 原图 / 结果目检

以下两图均经 `read_image` 直接阅读；没有制作或替换用户图像：

| 原图 | 实际两阶段结果 |
| --- | --- |
| ![原图](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/input/77d2c42db7b0e56286aec070a54d1437.png>) | ![实际生成结果](<W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/output/GG_验证/分区_实际生成_00001_.png>) |

目检结论：

- 原始竖幅、池边场景、单一人物的大体位置及坐姿仍然可辨；未见明显增加人物或彻底重构场景。
- 发丝、花朵、衣服花纹、编织包与背景纹理出现变化。结果的面部和细纹理较原图更软，面部局部外观也有变化；512×512 裁剪处理再还原到 1080×1920 不能视为高分辨率保真验证。
- 这轮**执行成功不代表视觉质量必然改善**；不能声称人物身份、姿态、外轮廓或所有物体细节绝对不变。
- 人物涂选仅为粗略测试轮廓，部分人物边缘可能落在所谓“背景”区域，部分非人物像素也可能落入人物区域。本次不证明精细人物/背景隔离效果。

## 6. 明确未验证

本报告仅关闭“现有工作流是否能真实跑通双阶段扩散并保存结果”的验证缺口。未再次运行父会话已报告的 API 图、lazy no-op、空遮罩和 73 项测试，也不声称这些测试由本次复验。未进行高分辨率扩散、质量调参、其他 seed/model 比较、PE/LLM 实验、遮罩编辑器交互验证或用户服务重启验证。

**交接状态：DONE。GPU 扩散作业已结束并收集，原图未变，产物可直接打开；无需实施修复。**
