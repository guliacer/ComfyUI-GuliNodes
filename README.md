# ComfyUI-GuliNodes

[![GitHub Stars](https://img.shields.io/github/stars/guliacer/ComfyUI-GuliNodes?style=flat-square&color=ffcb47)](https://github.com/guliacer/ComfyUI-GuliNodes)
[![GitHub License](https://img.shields.io/github/license/guliacer/ComfyUI-GuliNodes?style=flat-square&color=97ca00)](https://github.com/guliacer/ComfyUI-GuliNodes/blob/main/LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/guliacer/ComfyUI-GuliNodes?style=flat-square&color=0078ff)](https://github.com/guliacer/ComfyUI-GuliNodes/releases)

ComfyUI-GuliNodes 是一组面向中文工作流的轻量效率节点和前端增强工具，覆盖画布整理、文本输入、图像处理、Latent 尺寸、模型/LoRA 管理、采样、视频处理、显存清理和网页 AI 辅助。

<details>
<summary>依赖说明</summary>

当前主插件保持零额外 Python 依赖：不需要安装 `cv2`、`mediapipe`、`llama-cpp-python`、`color-matcher`、`kornia` 等额外包。部分功能会调用外部程序或可选插件，例如视频处理需要系统可调用 `ffmpeg`，GGUF 和 SeedVR2 聚合节点需要对应 ComfyUI 插件或模型环境。

</details>


## 快速开始

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/guliacer/ComfyUI-GuliNodes.git
cd ComfyUI-GuliNodes
pip install -r requirements.txt
```

`requirements.txt` 当前只是兼容声明，主插件没有额外 Python 包依赖。安装后重启 ComfyUI，在右键菜单中查找 `GG` 或 `GuliNodes` 分类即可使用节点；前端工具会自动随插件加载。

## 主要能力

### 画布与前端工具

- 顶部工具栏：节点/分组上色、取色粘贴、节点尺寸复制粘贴、对齐、等宽等高、自动间距、批量整理。
- 连线样式：颜色、宽度、透明度、发光和流动效果可调。
- 标题和转接：提供标题节点、轻量转接节点、全局转接和 Set/Get 虚拟连接节点。
- 组增强：选中节点可直接新建为组，组名可改，标题随画布缩放保持清晰，支持四角和四边缘拖拽缩放；可在标题栏快速显示/隐藏整组以跳过组内节点，也可将分组折叠为同名子工作流小节点；折叠小节点支持拖动和双击改名，通过右下角彩色圆点或顶部快捷开关按快照还原原始位置和尺寸。
- 文本与输入体验：文本复制展示、密钥输入、种子生成、数值输入、CLIP 文本编码一体化。

### 图像与 Latent

- 基础图像处理：RGBA 转 RGB、尺寸调整、裁剪、翻转旋转、亮度/对比度/饱和度/锐化/虚化、色彩校正。
- 风格参考：使用纯 PyTorch 统计迁移和纹理混合实现，不依赖 OpenCV。
- 图像保存与压缩：预览、保存、压缩保存、独立压缩，支持 JPEG/PNG/WEBP。
- 图像对比：2/4/8 图拼接预览，适合参数对比和 A/B 测试。
- Latent 尺寸：比例预设、图像转 Latent、Latent 缩放、尺寸读取、VAE 编码/解码缓存。
- 遮罩与锐化：遮罩绘制、CAS 锐化增强。

### 模型、LoRA、采样与视频

- LoRA：4 槽、8 槽和 20 槽自定义 LoRA 顺序叠加。
- 模型加载：普通 UNET 加载、GGUF UNET 桥接加载、VAE 缓存编码/解码。
- 采样：Z-Image 采样器、集成尺寸计算的 GG 采样器、DyPE 动态位置补丁。
- 显存清理：卸载 ComfyUI 模型、清理设备缓存、清理 GuliNodes VAE 缓存并输出报告。
- 视频：视频加载、路径加载、图像音频合成视频、压缩、保存，以及 SeedVR2 视频放大聚合节点。

## 节点清单

当前版本实际注册 58 个节点。

### 图像、尺寸与 Latent

| 节点 | 用途 |
| --- | --- |
| `GG 图像宽高` | 按比例、边长和方向计算宽高。 |
| `GG Latent` | 按预设比例生成空 Latent。 |
| `GG Latent2` | 增强版空 Latent，适合输出尺寸参数。 |
| `GG 图像-Latent` | 根据图像尺寸生成匹配 Latent。 |
| `GG 图像尺寸缩放` | 按模型预设或边长缩放图像尺寸。 |
| `GG 图像缩放` | 像素空间缩放后回编码 Latent，并输出预览图。 |
| `GG 图像尺寸读取` | 读取图像宽度和高度。 |
| `GG VAE解码` | 加载并缓存 VAE 后解码 Latent。 |
| `GG VAE编码` | 加载并缓存 VAE 后编码图像。 |

### 图像处理与输出

| 节点 | 用途 |
| --- | --- |
| `GG RGBA转RGB` | 将灰度、带 Alpha 或 RGBA 图像合成 RGB。 |
| `GG 尺寸调整` | 按比例、固定尺寸或边长调整图像。 |
| `GG 图像裁剪` | 中心、坐标、比例等裁剪。 |
| `GG 图像变换` | 水平/垂直翻转和 90/180/270 度旋转。 |
| `GG 图像调整` | 亮度、对比度、饱和度、锐化和虚化。 |
| `GG 色彩校正` | 使用 torch 张量批量调整温度、色调、明度、对比度、饱和度和伽马。 |
| `GG 风格参考` | 参考图像风格统计迁移和纹理混合。 |
| `GG 绘制蒙版` | 将蒙版绘制到图像上，便于检查遮罩区域。 |
| `GG 图像CAS锐化+` | CAS 锐化增强。 |
| `GG 图像预览` | 预览图像。 |
| `GG 图像保存` | 保存图像。 |
| `GG 图像压缩保存` | 压缩并保存图像。 |
| `GG 图像压缩` | 输出压缩后的图像。 |
| `GG 图像对比 2张` | 双图对比预览。 |
| `GG 图像对比 4张` | 四图对比预览。 |
| `GG 图像对比 8张` | 八图对比预览。 |

### 文本、输入与工作流组织

| 节点 | 用途 |
| --- | --- |
| `GG 文本` | 显示文本并支持前端复制。 |
| `GG TXT加载` | 像加载图像一样选择或上传 TXT/MD 文本文件，并输出文本内容。 |
| `GG CLIP文本` | 加载 CLIP 并编码文本。 |
| `GG CLIP文本编码器` | 文本编码辅助节点。 |
| `GG 密钥输入` | 用于 API Key、令牌、API 端点和模型名称，可测试当前配置，并输出单个 `API配置`。 |
| `GG 数值` | 输出数值参数。 |
| `GG 浮点滑条` | 输出 0 到 1 的浮点滑条参数。 |
| `GG 万能滑条` | 可自定义范围、步长、显示名称和浮点/整数输出的自绘滑条。 |
| `GG 种子生成器` | 生成或固定随机种子。 |
| `GG Set` | 声明画布内可复用连接值。 |
| `GG Get` | 读取同名 Set 节点值。 |
| `GG 标题` | 画布标题和分区标注。 |
| `GG 转接` | 轻量转接节点。 |
| `GG 全局转接` | 全局连接辅助。 |
| `GG 单组控制` | 控制单个分组启用/跳过。 |
| `GG 多组控制` | 批量控制多个分组。 |
| `GG 网页AI图像反推` | 在节点中打开豆包、腾讯元宝、文心一言或自定义网页。 |
| `GG 文本反推` | 调用大模型按规则提取小说内容并总结，支持文本或 TXT 输入。 |

### 模型、LoRA、采样与显存

| 节点 | 用途 |
| --- | --- |
| `GG LoRA选择 4个` | 最多 4 个 LoRA 顺序叠加。 |
| `GG LoRA选择 8个` | 最多 8 个 LoRA 顺序叠加。 |
| `GG LoRA自定义加载` | 最多 20 槽 LoRA 自定义叠加。 |
| `GG UNET模型` | 加载普通 UNET/diffusion 模型。 |
| `GG GGUF模型` | 桥接 ComfyUI-GGUF 加载 GGUF UNET。 |
| `GG 内存清理` | 卸载模型、清理缓存并输出报告。 |
| `GG DyPE动态位置` | 为 FLUX、Qwen、Z-Image 应用动态位置补丁。 |
| `GG Z-Image采样器` | Z-Image 专用采样。 |
| `GG 采样器` | 集成尺寸计算和 Z-Image 采样的便捷采样器。 |

### 视频

| 节点 | 用途 |
| --- | --- |
| `GG 视频加载` | 从 input/temp/output 目录或文件路径加载视频并预览。 |
| `GG 视频路径加载` | 通过本机真实文件路径加载视频，不经过浏览器上传，适合超过 ComfyUI 上传限制的大视频。 |
| `GG 视频合成` | 将上游 IMAGE 批次与 AUDIO 合成为 VIDEO，支持视频格式、像素格式、CRF、输出帧率和音频修剪，便于接入 `GG 视频压缩`。 |
| `GG 视频压缩` | 使用 ffmpeg 压缩视频并显示进度。 |
| `GG 视频保存` | 保存或封装视频输出。 |
| `GG SeedVR2视频放大器` | 聚合 SeedVR2 DiT、VAE 和视频放大流程。 |

## 致谢与借鉴说明

本项目会尽量把借鉴、适配和桥接关系写清楚。除下表列出的项目外，其余节点主要是围绕 ComfyUI 原生节点 API、前端扩展 API 和日常中文工作流需求重新实现；如后续发现遗漏来源，会继续补充。

| 涉及功能/节点 | 致谢对象 | 说明 |
| --- | --- | --- |
| 全部节点与前端工具 | ComfyUI、ComfyUI_frontend、LiteGraph | 本项目运行在 ComfyUI 自定义节点和前端扩展机制之上，画布、节点、连线、分组绘制等能力依赖这些基础 API。 |
| `GG DyPE动态位置` | [wildminder/ComfyUI-DyPE](https://github.com/wildminder/ComfyUI-DyPE) | `guli_nodes/dype_patch.py` 已注明基于本地 ComfyUI-DyPE 实现适配，保留 Apache-2.0 来源说明，并封装为 GuliNodes 的中文参数节点。 |
| `GG GGUF模型` | [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | 本节点是桥接加载器，不内置 GGUF 加载实现；运行时检测并调用 ComfyUI-GGUF 中的 `UnetLoaderGGUFAdvanced` 或 `UnetLoaderGGUF`。 |
| `GG SeedVR2视频放大器` | [numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | 本节点参考并聚合 SeedVR2 插件的 DiT、VAE、注册表和视频放大接口，简化常用参数，不复制其模型或核心推理实现。 |
| `GG 色彩校正` | ColorCorrect 类色彩校正功能 | 参数设计和功能目标参考 ColorCorrect 的温度、色调、明度、对比度、饱和度、伽马调节思路；当前实现改写为 torch 张量批处理，不依赖额外 OpenCV/kornia 包。 |
| `GG 绘制蒙版` | KJNodes 的 Draw Mask On Image 使用习惯 | 节点搜索别名保留 `DrawMaskOnImage`、`Draw Mask On Image`、`KJNodes`，方便用户迁移；实现为本项目的向量化 alpha blend。 |
| `GG 图像对比 2张` | ComfyUI-KJNodes、[ComfyUI_JosiaNodes](https://github.com/Josia-doit/ComfyUI_JosiaNodes) | 双图对比节点的交互形态和使用场景参考了 KJNodes 与 JosiaNodes 的相关实现；本项目按 GuliNodes 的预览、保存和前端交互方式重新整理。 |
| 文本框悬浮按钮 | [ComfyUI-Prompt-Assistant](https://github.com/yawiii/ComfyUI-Prompt-Assistant) | 文本框悬浮复制、粘贴、清空按钮的交互灵感来源于 Prompt Assistant；本项目按 GuliNodes 的全局文本框识别、设置开关和前端按钮样式重新实现。 |
| `GG Set`、`GG Get`、`GG 全局转接`、`GG 转接`、`GG 标题` | rgthree、Anything Everywhere、Set/Get、Reroute 等社区常见工作流形态 | 这些节点借鉴了社区里“虚拟连接、全局转接、轻量转接、画布标注”的交互思路，但前后端逻辑按 GuliNodes 的中文体验和序列化方式重写。 |
| `GG 单组控制`、`GG 多组控制`、分组前端增强 | [Josia-doit/ComfyUI_JosiaNodes](https://github.com/Josia-doit/ComfyUI_JosiaNodes)、ComfyUI 原生 Group 与社区分组管理/样式插件 | 单组/多组控制相关节点参考 JosiaNodes 的分组控制思路，并按 GuliNodes 的中文参数和工作流习惯重新整理；标题栏显示/隐藏按钮沿用本项目单组/多组控制的组内节点识别机制，使用 `mode=2/0` 控制执行禁用/启用，并兼容旧的 `mode=4` 跳过状态。子工作流折叠为本项目前端交互增强，会保存组内节点位置和尺寸快照，仅影响分组内节点的画布显示与命中，并提供可拖动/改名的画布折叠小节点和右下角圆点恢复入口。 |
| `GG 图像CAS锐化+` | Contrast Adaptive Sharpening（CAS）算法思路 | 使用 CAS 风格的对比度自适应锐化思路，以 PyTorch 张量实现为 ComfyUI 图像节点。 |
| `GG 视频加载`、`GG 视频路径加载`、`GG 视频合成`、`GG 视频压缩`、`GG 视频保存` | ffmpeg/ffprobe 与 ComfyUI 视频工作流生态 | 视频封装、压缩和探测依赖 ffmpeg/ffprobe；节点形态面向 ComfyUI 常见 IMAGE/AUDIO/VIDEO 串联工作流重新封装。 |
| `web/gg-group-styler.js` | ComfyUI-Group-Styler 的“前端扩展 + LiteGraph Group 绘制”路线 | 新增分组样式增强参考了该类前端实现路线，但没有复制其源码；当前文件在本项目内独立包装 `drawGroups`，带设置开关和原生绘制回退，并扩展标题栏按钮、顶部快捷开关、子工作流折叠动画、隐藏节点过滤与右下角圆点恢复指示器。 |

## 依赖与兼容

| 功能 | 依赖 | 说明 |
| --- | --- | --- |
| 主插件节点 | 无额外 Python 包 | 仅依赖 ComfyUI 自带 Python 环境中的常规库。 |
| 图像处理 | ComfyUI 环境内的 `torch`、`PIL`、`numpy` | 不需要 `cv2`、`mediapipe`、`kornia` 或 `color-matcher`。 |
| 视频加载/压缩/保存 | `ffmpeg`，可选 `ffprobe` | 需要系统命令可调用，或把 ffmpeg 放到 PATH。 |
| GGUF 模型加载 | ComfyUI-GGUF 插件 | 只有使用 `GG GGUF模型` 节点时需要。 |
| SeedVR2 视频放大 | ComfyUI-SeedVR2_VideoUpscaler 插件 | 只有使用 `GG SeedVR2视频放大器` 节点时需要。 |

推荐模型目录：

| 资源类型 | 推荐目录 |
| --- | --- |
| UNET / diffusion model | `ComfyUI/models/unet/` 或 `ComfyUI/models/diffusion_models/` |
| GGUF UNET | `ComfyUI/models/unet/`、`ComfyUI/models/diffusion_models/` 或 ComfyUI-GGUF 配置目录 |
| VAE | `ComfyUI/models/vae/` |
| CLIP / text encoder | `ComfyUI/models/text_encoders/` |
| LoRA | `ComfyUI/models/loras/` |

## 常见问题

### 安装时还需要 `pip install -r requirements.txt` 吗？

可以执行，但当前文件不安装额外包，只用于兼容 ComfyUI Manager 或已有安装习惯。

### 视频加载或压缩失败怎么办？

确认 `ffmpeg` 可以在系统 PATH 中直接运行。大视频可以使用 `GG 视频路径加载` 直接选择本机文件路径，避免浏览器上传大小限制；也可以放入 `ComfyUI/input` 后在节点里选择。

### GGUF 节点提示未检测到 ComfyUI-GGUF？

`GG GGUF模型` 只是桥接节点，不内置 GGUF 加载器。需要安装并启用 ComfyUI-GGUF，并把 `.gguf` 模型放到对应目录。

### SeedVR2 节点提示无法加载插件？

`GG SeedVR2视频放大器` 会调用 `ComfyUI-SeedVR2_VideoUpscaler` 的接口。需要先安装该插件和对应模型。

### 网页 AI 节点无法嵌入？

部分平台会限制 iframe 嵌入。可以尝试自定义移动端地址，或在外部浏览器打开平台网页使用。

## 更新记录

### v1.0.11

- 顶部工具栏：新增上色取色/粘贴功能，可从画布节点或分组复制上色信息，并粘贴到单个/多个选中节点或分组。
- 顶部工具栏：新增节点尺寸复制/粘贴功能，可把一个节点的宽高应用到单个或多个选中节点。
- 分组样式增强：修复四边四角拖拽缩放的事件捕获顺序，并兼容新版 LiteGraph 分组矩形写回。
- 分组样式增强：新增标题栏缩放折叠按钮和顶部快捷开关，折叠时会保存分组框与组内节点的位置/尺寸快照，将分组显示为官方风格的同名子工作流小节点，恢复时精确写回原始布局，并过滤隐藏节点绘制、命中、文本和连线显示。
- 分组样式增强：修复工作流在分组折叠为子工作流小节点时保存，重新打开后组内节点以折叠坐标直接显示并重叠的问题。
- 分组样式增强：启用后会强制接管官方 Group 绘制、鼠标交互和分组选择工具条，避免官方分组按钮与 GuliNodes 分组功能叠加显示。
- 分组样式增强：新增浏览器本地缓存记忆，重启 ComfyUI 后会按工作流和组内节点快照恢复折叠子工作流状态；超过缓存期限的折叠工作流会自动恢复到折叠前布局，避免节点重叠。
- 分组样式增强：折叠父组时会同步归纳内部子组，保存或重启后不会残留未缩放的子组空框。
- 分组样式增强：折叠小节点单击不再恢复；支持拖动当前折叠位置且不改变原始快照位置，双击可自定义显示名称。
- 分组样式增强：新增画布右下角子工作流圆点指示器，多个折叠分组会自动排列并分配随机颜色；悬停显示名称，点击可恢复对应分组。
- 分组样式增强：右下角子工作流圆点按当前工作流隔离，切换工作流时会立即隐藏其他工作流的圆点，避免误点恢复旧工作流导致重叠。
- 新增 `GG 视频路径加载` 节点：通过本机路径直接加载视频，不经过浏览器上传，适合绕开 ComfyUI 上传体积限制。
- 新增 `GG 视频合成` 节点：把上游 `IMAGE` 批次和 `AUDIO` 合成为 `VIDEO`，作为 `GG 视频压缩` 的前置桥接节点，方便接入没有视频输出的第三方工作流。
- `GG 视频合成` 支持视频格式、像素格式、CRF、输出帧率和修剪音频参数；修剪音频会按当前输出帧率计算视频时长。
- `GG 视频路径加载` 增加前端“选择视频文件”按钮，使用 Windows 原生文件选择器填写真实路径。
- 修正新增视频节点分类，统一归入 `GuliNodes/视频`。

### v1.0.10

- 主插件与额外 Python 依赖解耦，保留零额外 Python 依赖安装体验。
- 当前实际注册 56 个节点。
- 新增 `GG 色彩校正` 节点，基于 ColorCorrect 功能用 torch 张量批量实现，无需额外 OpenCV 依赖。
- 保留 GGUF、SeedVR2、DyPE、Z-Image、视频、前端工具栏、Set/Get、标题、转接、内存清理等节点。
- 移除需要额外 Python 包的节点代码，例如 `color-matcher` / `kornia` 色彩匹配、`llama-cpp-python` 图像提示词和提示词优化相关节点。
- 恢复零额外 Python 依赖的网页 AI 节点和风格参考节点。

### 历史版本

- v1.0.9：参数中文化、文本框悬浮按钮、CLIP 编码简化。
- v1.0.8：前端工具栏和交互能力优化。
- v1.0.6：新增网页 AI 图像反推节点。
- v1.0.5：视频加载、压缩、保存节点上线。

## 许可证

本项目基于 MIT 许可证开源，详见 [LICENSE](LICENSE)。
