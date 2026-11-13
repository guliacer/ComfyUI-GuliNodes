<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img src="assets/banner-dark.svg" alt="ComfyUI-GuliNodes" width="100%">
  </picture>
</p>

<p align="center">
  <b>面向中文工作流的轻量 ComfyUI 效率节点与前端增强工具</b><br>
  <sub>画布整理 · 图像处理 · Latent 尺寸 · 文本输入 · 模型与 LoRA · 采样 · 视频 · 显存清理</sub>
</p>

<p align="center">
  <a href="https://github.com/guliacer/ComfyUI-GuliNodes"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/guliacer/ComfyUI-GuliNodes?style=flat-square&color=ffcb47"></a>
  <a href="https://github.com/guliacer/ComfyUI-GuliNodes/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/guliacer/ComfyUI-GuliNodes?style=flat-square&color=0078ff"></a>
  <a href="https://github.com/guliacer/ComfyUI-GuliNodes/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/guliacer/ComfyUI-GuliNodes?style=flat-square&color=97ca00"></a>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-3776ab?style=flat-square">
  <img alt="No Extra Dependencies" src="https://img.shields.io/badge/%E9%A2%9D%E5%A4%96%E4%BE%9D%E8%B5%96-%E6%97%A0-2ea44f?style=flat-square">
</p>

<p align="center">
  <a href="#特性亮点">特性亮点</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#主要能力">主要能力</a> ·
  <a href="#节点清单">节点清单</a> ·
  <a href="#依赖与兼容">依赖与兼容</a> ·
  <a href="#界面与设置">界面与设置</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#更新记录">更新记录</a> ·
  <a href="#致谢与借鉴说明">致谢与借鉴说明</a> ·
  <a href="#贡献">贡献</a> ·
  <a href="#许可证">许可证</a>
</p>

---

## 特性亮点

面向中文工作流的 ComfyUI 节点与前端工具，覆盖画布整理、图像与 Latent、文本与 AI、LoRA、采样、视频和显存管理，主插件无需额外 Python 依赖，可选功能按需安装后端。

- **中文与按需参数**：节点、选项和错误提示中文化，失效输入按模式隐藏，固定输出保持稳定。
- **画布效率**：上色、对齐、吸附、分组折叠、标题按钮、三档控件皮肤、17 种连线样式和 6 种节点光效统一管理。
- **图像与 AI**：加载、裁剪、缩放、遮罩合并、压缩、对比、超分及 Qwen Image 2.1 提示词增强与条件编码串联使用。
- **工作流与资源**：支持示例模板、视频处理、显存清理、TapRelay 完成通知与素言素材库联动。

## 快速开始

1. **安装**：在 ComfyUI Manager 搜索 `ComfyUI-GuliNodes`，或在 `ComfyUI/custom_nodes` 执行：

   ```bash
   git clone https://github.com/guliacer/ComfyUI-GuliNodes.git
   ```

2. **重启**：重启 ComfyUI，旧界面可用 `Ctrl + F5` 强制刷新，`requirements.txt` 仅作兼容声明。
3. **使用**：右键添加 GG / GuliNodes 节点，通过顶部「GuliNodes 工具」或设置页调整功能，示例可从「浏览模板」加载或拖入画布。

| 示例 | 用途 |
| --- | --- |
| [人像精修](<example_workflows/人像精修工作流.json>) | 四个内嵌子图按区域逐步精修人像。 |
| 图像解码与混淆、超分 | 在 `example_workflows/` 选择可逆像素混淆或 Real-CUGAN 超分对照模板。 |
| [人像 / 背景分区编辑](<examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json>) | SAM3 或手绘蒙版串行编辑人像与背景，空需求跳过对应分支，按原遮罩回贴保持原坐标与画幅。 |

参数边界、推荐工作流设置与完整操作说明见[详细使用指南](<docs/使用指南.md>)和[分区编辑说明](<examples/workflows/GG-人像背景分区编辑_使用说明.md>)。

## 主要能力

| 类别 | 能力概括 |
| --- | --- |
| 画布与前端 | 整理节点与编组、复制颜色和尺寸、移动吸附、折叠与端口列表显示、主题与特效、文本快捷操作，并修复 DOM 控件遮挡画布。 |
| 图像与 Latent | 图像加载与遮罩读取、变换与色彩调整、比例缩放与尺寸适配、裁剪回贴、分区编辑、混淆解码、压缩保存、对比预览及超分。 |
| 文本与 AI | 文本加载与拼接、预设库、密钥与模型获取、数学与种子输入、CLIP 编码、Qwen 提示词增强与优化、镜头打光及网页 / 文本反推。 |
| 模型与视频 | 20 槽 LoRA 与分组管理、Z-Image 采样、模型与显存清理，以及本机视频加载、IMAGE + AUDIO 合成、压缩和保存。 |

## 节点清单

当前版本共 **56 个节点**（后端 55 个 + 前端 `GG 选项确认`），最新变化见[更新记录](<#更新记录>)，详细参数见[使用指南](<docs/使用指南.md>)。

### 图像、尺寸与 Latent

| 节点 | 用途 |
| --- | --- |
| `GG 图像宽高` | 按边长、K 分辨率、Latent 或图像计算对齐到 8 的宽高。 |
| `GG Latent` | 按边长、K 分辨率、像素宽高、Latent 或图像生成 Latent，并支持尺寸倍率调整。 |
| `GG 图像缩放` | 按倍数、长短边、单边或宽高缩放，支持插值和整除数对齐，参数按模式显示。 |
| `GG 图像缩放 V2` | 支持拉伸、裁剪、自定义色 / 边框色 / 边缘像素填充和总像素等比，遮罩同步缩放并输出实际宽高。 |
| `GG 尺寸适配` | 按比例与面积选取 32 倍数的 Qwen 稳定尺寸，支持自动或 512–2048 档位及裁剪、补边、拉伸。 |
| `GG 纯色图像` | 按宽高与颜色生成 IMAGE，支持取色及十六进制 / RGB 输入，单边上限 8192。 |

### 图像处理与输出

| 节点 | 用途 |
| --- | --- |
| `GG 图像加载` | 选择、粘贴或上传图像，保持单张等比预览，支持裁剪与官方蒙版编辑器，遮罩按手选文件、同名 sidecar、Alpha、全零依次回退。 |
| `GG 图像裁剪` | 按中心、坐标、比例或 K 分辨率裁剪图像。 |
| `GG 蒙版诊断` | 可视化人物与背景区域，输出遮罩占比及中文诊断。 |
| `GG 分区编辑准备` | 校验人物遮罩与输入，输出区域请求、固定姿态约束及编辑开关，空需求跳过分支。 |
| `GG 遮罩裁剪` | 按白色区域与四边扩展裁剪，支持多种目标尺寸并输出接缝、图像和遮罩。 |
| `GG 局部重绘裁剪` | 处理遮罩低值、补洞、扩展与反相，支持上下文、画布外扩和强制采样尺寸。 |
| `GG 裁剪恢复` | 按接缝羽化回贴裁剪结果，支持遮罩扩展、颜色还原、背景对照与外扩画布恢复。 |
| `GG 图像合并（遮罩）` | 按遮罩与透明度合并图像，支持膨胀 / 腐蚀、羽化、尺寸匹配、居中和单张广播。 |
| `GG 蒙版修边` | 对遮罩做扩展 / 收缩与高斯羽化，去掉自动分割硬边与贴回残影。 |
| `GG 图像变换` | 水平 / 垂直翻转及 90 / 180 / 270 度旋转。 |
| `GG 图像调整` | 调整亮度、对比度、饱和度、锐化和虚化。 |
| `GG 色彩校正` | 批量调整温度、色调、明度、对比度、饱和度和伽马。 |
| `GG 颜色校准` | 以未变化区域校准双图色偏，支持自动或手动遮罩，输出校准图、变化遮罩与比例。 |
| `GG 风格参考` | 参考图像的色彩统计与纹理混合迁移。 |
| `GG 图片超分（Real-CUGAN）` | 提供 2x / 3x / 4x 共 11 档、自动下载、GPU / CPU 推理、分块羽化、批量与 Alpha 缩放。 |
| `GG 图像预览` | 在节点中预览图像。 |
| `GG 图像保存` | 保存图像。 |
| `GG 图像压缩保存` | 按质量或目标大小压缩保存 JPEG / PNG / WEBP，保存后默认清理模型与缓存。 |
| `GG 图像压缩` | 输出压缩后的图像。 |
| `GG 图像对比 2张` | 双图对比预览。 |
| `GG 图像对比 N张` | 接线自动增减图像槽位与标签，最多对比 20 张；手动高度读档保持，不再自动伸长。 |
| `GG 图像混淆` | 按 4 位密码进行 Hilbert 像素置换，V3 可从缩放图识别尺寸，V2 保持逐像素无损。 |

### 文本、输入与工作流

| 节点 | 用途 |
| --- | --- |
| `GG 文本` | 显示并复制文本。 |
| `GG TXT加载` | 选择、上传或按路径读取 TXT / MD 文件。 |
| `GG 文本拼接` | 最多 20 段按顺序拼接，支持自定义分隔符、空段跳过与内容 / 接线驱动的自动增长。 |
| `GG 提示词库` | 按分类添加、编辑或删除预设，点击追加 / 取消，用户区存储并跨工作流共享。 |
| `GG CLIP文本` | 接收上游 CLIP 并编码文本；模型由 `CLIPLoader` 管理。 |
| `GG 密钥输入` | 导入、测试端点与密钥并获取模型列表，输出 API 配置 JSON 及三个独立字段。 |
| `GG 提示词增强qwen2.1` | 通过 API、外接 Qwen Image CLIP（本地PE）或 GGUF LLM 增强文生图、图生图与反推，支持语言、透明背景、方向和最多 20 张图，输出提示词、JSON 与反推标记。 |
| `GG 提示词优化qwen2.1` | 接收外接 CLIP、可选 VAE、提示词和最多 20 张参考图，输出带参考 Latent 的正负条件；CLIP / VAE 分别由上游 Loader 管理。 |
| `GG 镜头打光提示词` | 组合 20 种机位、72 种光效、方向与主体约束，支持基础 / 高级显示和上游文本，中文面板输出英文提示词。 |
| `GG 整数` | 输入并输出整数。 |
| `GG 选项确认` | 同步普通节点与嵌套子图的控件选项，支持自定义标签与最多 20 个输出源，由前端生成。 |
| `GG 简单数学表达式` | 输入、表达式与结果随接线增长，每条结果兼容 INT / FLOAT 下游。 |
| `GG 种子生成器` | 生成或固定随机种子。 |
| `GG 标题` | 添加画布标题和分区标注。 |
| `GG 多组控制` | 选择多个编组并批量或单独启停，显示状态、支持组跳转和布尔连线控制。 |
| `GG 单组控制` | 选择单个编组并通过开关或布尔输入启停。 |
| `GG 选择` | 输入按连线自动新增（默认 1 路，最多 20 路），`生效输入` 只列出已连线的分支；类型跟随上游自动适配（同官方 If/Else），只执行选中的那一路，其余分支不参与求值。 |
| `GG 网页AI图像反推` | 在节点内打开豆包、腾讯元宝、文心一言、百度翻译或自定义网页。 |
| `GG 文本反推` | 按规则调用大模型提取与总结小说文本，支持文本或 TXT 输入。 |

### 模型、LoRA、采样与视频

| 节点 | 用途 |
| --- | --- |
| `GG LoRA自定义加载` | 最多叠加 20 个 LoRA，逐槽启用、调整强度并拖拽排序。 |
| `GG LoRA组加载` | 管理多组 LoRA，可通过组标签或连接「GG 选项确认」选择生效组；双击组标签可改名，组数据随工作流保存。 |
| `GG 内存清理` | 卸载模型、清理设备缓存并输出报告；保留旧工作流的 VAE 缓存兼容字段。 |
| `GG Z-Image采样器` | Z-Image 专用采样。 |
| `GG 视频加载` | 从 input / temp / output 或文件路径加载并预览视频。 |
| `GG 视频路径加载` | 从本机路径读取大视频，避免浏览器上传限制。 |
| `GG 视频合成` | 将 IMAGE 批次与 AUDIO 合成 VIDEO，支持格式、帧率、CRF 和音频修剪。 |
| `GG 视频压缩` | 使用 ffmpeg 压缩视频并显示进度。 |
| `GG 视频保存` | 保存或封装视频输出。 |

## 依赖与兼容

| 功能 | 按需准备 |
| --- | --- |
| 基础节点 | 使用 ComfyUI 自带的 `torch` / `PIL` / `numpy`，无需额外 Python 包。 |
| Real-CUGAN 超分 | 安装 `onnxruntime` 或匹配的 `onnxruntime-gpu`，模型放 `models/Real-ESRGAN/`，内置档位可自动下载。 |
| 本地LLM 提示词增强 | 安装匹配平台 / CUDA 的 `llama-cpp-python`，GGUF 放 `models/LLM/` 或 `models/text_encoders/`，看图另需匹配 mmproj。 |
| 本地PE / API 提示词增强 | 官方 PE safetensors 放 `models/text_encoders/`，API 方式准备 OpenAI 兼容端点、密钥与模型。 |
| 视频处理 | `ffmpeg` 可从 PATH 调用，`ffprobe` 按需用于探测。 |
| TapRelay 通知 | 本机 TapRelay 监听 `1122` 端口，通知失败不阻断工作流。 |
| 素言联动 | 开启设置并运行监听 `http://127.0.0.1:9477/guli/suyan/import` 的本地收件服务。 |
| 前端与配套包 | 支持 Canvas / Nodes 2.0，配套依赖包提供的人脸美化等节点不计入本仓库节点数。 |
| 内置 SAM3 自动蒙版 | 安装配套依赖包 `ComfyUI-GuliNodes-Dependencies`（模型代码随包分发），权重放 `models/sam3/sam3.pt`；不再需要 `ComfyUI-Easy-Sam3` 或 `ComfyUI_LayerStyle`。 |

VAE、CLIP、LoRA 分别放 `models/vae/`、`models/text_encoders/`、`models/loras/`，缺少可选后端时只影响对应功能。

## 界面与设置

顶部 **GuliNodes 工具** 管理皮肤、翻译、连线、节点光效与分组，**设置 → GuliNodes** 提供完整配置，节点标题栏管理置顶、折叠及端口列表。

- **皮肤范围**：三档为「适配第三方 / 只我们插件 / 所有都关闭」，首次默认只我们插件，切换立即生效并保留用户选择。
- **布局与状态**：外观开关不改参数或连线，节点手动尺寸随工作流保存，用户配置落在 ComfyUI 用户区并兼容旧数据迁移。
- **联动默认值**：移动吸附与 TapRelay 通知默认开启，素言联动默认关闭，常用设置无需重启。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 界面未更新或节点缺失 | 重启 ComfyUI、强制刷新浏览器并检查控制台，基础安装无需额外依赖。 |
| 视频失败或文件过大 | 检查 ffmpeg 的 PATH，使用视频路径加载或放入 input 目录。 |
| 网页嵌入失败 | 平台可能限制 iframe，可尝试自定义移动端网址或外部浏览器。 |
| TapRelay 未通知 | 检查功能开关与本机 `1122` 端口，失败仅记录警告。 |
| 打光效果与预期不同 | 文字提示不是精确控光，先用 2–3 个光效并关注词数与模型上下文，精确控制需参考图或专用打光模型。 |
| API 网络中断 | 节点对瞬时故障重试最多 3 次，按错误提示检查代理 / VPN 与网络，直连兜底只在系统代理生效时尝试。 |
| 本地LLM 很慢或输出触顶 | 检查控制台后端与 GPU 运行库，连续调试选「保持加载」、后续生图保留卸载，token 触顶需检查正文完整性。 |

RTX 4060 Ti 16GB / Qwen PE Q5_K_S 的同参 64-token 生成实测为 17.44 → 2.15 秒（生成阶段约 8.1 倍），完整节点样本约 15–36 秒且不含排队，硬件、加载与输出长度仍会影响耗时。

## 更新记录

### v1.5.0（2026-11-13）

- **GG 选择**：新增分支选择节点，输入随连线自动增至 20 路，类型跟随上游适配，只执行选中的那一路。
- **人像精修内置化**：新增 `GG 蒙版修边`，配套依赖包提供 `GG SAM3 模型加载` / `GG SAM3 文本识别`，工作流不再依赖第三方插件且结构与参数不变。
- **模型职责拆分**：`GG 提示词优化qwen2.1`、`GG CLIP文本` 与提示词增强的本地PE改为外接 CLIP / VAE，移除 `GG VAE解码` 并改用原生「VAE 解码」。
- **自动迁移**：旧工作流的内置模型选择会自动迁移为画布上的 `CLIPLoader` / `VAELoader` 并保留连线，示例工作流同步改为外接模型。
- **GG 选项确认**：修复子图改选项后执行仍用旧值；`GG LoRA组加载` 新增组选择接口，可按组名切换生效 LoRA。
- **Nodes 2.0**：编组控制、LoRA 分组、超分帮助与图像对比适配原生界面，节点支持手动拖大拖小、折叠与读档保留尺寸。
- **GG 图像加载**：预览随节点宽高等比缩放且只显示一张，`蒙版` 打开官方编辑器并自动回写，旧工作流尺寸保留。
- **GG 提示词增强qwen2.1**：子图输入提升后显示「← 上游输入」标记行，消除端口悬空与文本区空白，断线恢复原高度。
- **高度保持**：`GG 图像对比 N张`、`GG 文本拼接`、`GG 视频保存` 的手动高度在重开工作流、清空内容或增减槽位后不再缩回。
- **界面细节**：`GG 标题` 文字颜色跟随画布明暗并修复部分插件下空白，多行文本框右下角显示实时字数。
- **GG 颜色校准**：自动在显卡运算并在无卡时回落 CPU，4096 图由 30 秒级降至 0.4 秒级，参数与旧工作流不变。

### v1.4.0（2026-11-10）

- **界面与工具栏**：统一深浅主题及主次按钮样式，将翻译、连线、光效与分组主开关收入工具菜单，完善开关状态、悬停提示、键盘焦点与窄屏显示。
- **节点标题按钮**：图标常显、悬停出底、激活变色，按宽度收起置顶 / 折叠 / 端口列表并提供右键入口，避让官方按钮且保持绘制与点击一致。
- **二级设置菜单**：连线、光效与折叠设置改为同宽侧滑页，统一标题、返回与 Esc / 方向键操作，完善焦点循环、窄屏适配及减少动画模式。
- **控件皮肤**：三档范围开关直接嵌入菜单，覆盖子图、第三方及各类单行控件，修复长标签截断、取值遮挡和深浅主题不一致；节点设置自定义颜色后，参数控件底色与文字按节点实际渲染色派生（浅色主题按调亮后的节点色取色），修改节点颜色时立即跟随。
- **连线与节点光效**：整合为 17 种连线、6 种光效和 8 套有效配方，旧的已移除效果自动回退，关闭功能恢复原有显示。
- **尺寸与布局**：常规节点优先单列并按内容紧凑排列，手动宽高支持拖大拖小和读档保留，参数变化不再造成回弹或多余空白。
- **图像加载**：新增节点内选择 / 粘贴 / 上传与遮罩优先级读取，裁剪支持 11 种比例、自定义比例、适应 / 居中、反选、旋转翻转及撤销重做。
- **颜色校准**：新增未变化区域色偏校准、自动 / 手动变化遮罩及遮罩外保留或还原，输出校准图像、遮罩和变化比例。
- **缩放与尺寸**：图像缩放增加多种定尺寸方式和整除数，新增 V2 多种落框与遮罩同步、Qwen 32 倍数尺寸适配及纯色图像，旧工作流自动兼容。
- **LoRA 管理**：自定义加载支持拖拽排序、完整名称与强度编辑，新增多组加载和工作流持久化，参数行紧凑贴合且无底部留白；组加载支持双击组标签改名，模型选 `None` 的空槽自动收回并把后面的槽位前移。
- **图像对比**：双图默认宽度收至 260 且尊重手动拉伸，N 图槽位随接线增减，高度不再自动伸长。
- **压缩保存**：改为单列与通栏预览，保留手动宽高并正确恢复 PNG 隐藏参数后的尺寸，读档不再多出底部空白；预览图按参数区实际底部定位，不再压住「清除内存」等最后一行参数，拉宽 / 拖高后也保持不重叠。
- **编组控制**：单组控制消除端口与组名重叠、合并重复信息并完善深浅主题可读性，保持启停接口与命中区域稳定。
- **数学表达式**：输入、表达式和通用数值结果随接线增长，兼容 INT / FLOAT 下游并自动迁移旧连线。
- **人脸美化**：配套节点采用高频分离磨皮与均匀提亮，更新默认参数并改善强结构保持和区域亮度一致性。
- **提示词增强**：本地LLM 分开使用文生图 / 图生图模型并支持透明背景、方向与卸载，修复隔离进程 CUDA 加载及取消 / 旧响应 / 缓存问题，新增后端诊断且兼容旧工作流；文生图借用配套 mmproj 关闭思考。修复选英文仍返回中文的问题：文生图、图生图及反推均遵循输出语言，模型偏离时自动校正一次，保留画面原文、比例与反推标记；校正仍失败会提示重试。
- **网页AI反推**：默认高度改为 500 并增加提示条，长文本区随编辑状态伸缩、支持展开和同组等高，可关闭增强显示恢复原组件。
- **文档**：按主题将更新合并为一句话概括，补齐节点速查，并把详细用法与已发布原始记录分离，保留全部来源与历史信息。

历史版本的完整原文见[历史更新记录](<CHANGELOG.md>)。

## 致谢与借鉴说明

下表概括实际借鉴关系，[完整来源与实现说明](<docs/使用指南.md#致谢与借鉴说明>)保留各节点对应关系及本地参考，退役功能的来源记录继续保留。

| 来源 | 涉及功能与关系 |
| --- | --- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI)、[前端](https://github.com/Comfy-Org/ComfyUI_frontend)、[LiteGraph](https://github.com/jagenjo/litegraph.js) | 原生 API 适配：节点、画布、徽章、分组、设置、Nodes 2.0 原生 DOM 控件与折叠布局、官方蒙版编辑器、图像预览标志、选项确认的子图输入解析、Qwen 条件编码与视频工作流。 |
| [KJNodes](https://github.com/kijai/ComfyUI-KJNodes)、[JosiaNodes](https://github.com/Josia-doit/ComfyUI_JosiaNodes)、[rgthree](https://github.com/rgthree/rgthree-comfy) | 思路参考：双图对比、画布标注、分组样式与单组 / 多组启停。 |
| [ComfyUI_essentials](https://github.com/cubiq/ComfyUI_essentials)、[QQ / Wysl](https://github.com/wysl/QQ_ComfyUI_Tools) | 思路参考：数学表达式与多选控件，提示词增强 API / 本地PE 逻辑及官方模板移植自 TE MAN / QQ 同类节点。 |
| [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) | 桥接：GGUF 推理与按架构选择视觉 handler，不内置其推理或投影实现。 |
| [Goohaitools](https://github.com/goohai/Goohaitools-comfyui) | 适配 / 思路参考：提示词增强与性能对照（文生图复用 Qwen 聊天模板关闭思考）、遮罩裁剪恢复、区域编辑、图像合并及缩放，按本项目结构与自带库重写。 |
| [ComfyUI-BlueBox](https://github.com/zhoutingxi/ComfyUI-BlueBox) | 思路参考：图像加载、颜色校准和 Qwen 稳定尺寸候选与落框方式。 |
| [ComfyUI_LayerStyle](https://github.com/chflame163/ComfyUI_LayerStyle) | 适配：宽高与颜色生成纯色图像的功能形态。 |
| [Inpaint-CropAndStitch](https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch) | 思路参考：重绘遮罩处理、上下文扩展、画面外扩和裁剪回贴。 |
| [mazanoke](https://github.com/civilblur/mazanoke)、[Caesium](https://github.com/Lymphatus/caesium-image-compressor)、[Imagine](https://github.com/meowtec/Imagine) | 思路参考：三档压缩命名、质量与目标大小交互，实际使用 Pillow 实现。 |
| [大番茄混淆工具](https://dfqtphx.netlify.app) | 算法思路：Hilbert 像素置换、4 位密码、尺寸条码与像素备份自愈。 |
| [Prompt Assistant](https://github.com/yawiii/ComfyUI-Prompt-Assistant) | 思路参考：文本框复制、粘贴与清空悬浮按钮。 |
| [李心宝爱玩Ai](https://www.runninghub.cn/post/2108448477058527233/)、[B 站](https://space.bilibili.com/470042957/dynamic) | 思路参考：光效多选、主体开关和光照方向面板，扩展机位与 72 种光效由本项目重写。 |
| [ffmpeg](https://ffmpeg.org/)、[小丸工具箱](https://github.com/wzxjohn/marukotoolbox) | 运行时调用 ffmpeg / ffprobe，视频编码器选项形态参考小丸，不打包其二进制。 |
| 本地「视觉生命」、ColorCorrect、ComfyUI-Group-Styler 与 TapRelay | 本地交互、色彩调节、前端分组路线及通知协议参考，来源细节见完整说明。 |

## 贡献

通过 [Issue](https://github.com/guliacer/ComfyUI-GuliNodes/issues) 或 Pull Request 反馈问题、改进功能与补充来源，开发约定见 [AGENTS.md](<AGENTS.md>)。

## 许可证

[MIT](<LICENSE>) · Copyright © 2026 Guli
