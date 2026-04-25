# ComfyUI-GuliNodes

ComfyUI-GuliNodes 是一组面向图像处理、文本处理、模型加载、图像反推、压缩保存和工作流控制的 ComfyUI 自定义节点。

## 功能概览

- 图像尺寸与 Latent：比例适配、Latent 创建、图像转 Latent。
- 图像处理：RGBA 转 RGB、缩放、裁剪、变换、基础调色、人脸磨皮、智能人脸美化、风格参考、预览、保存、压缩和对比。
- 文本处理：合并、分割、过滤、替换、计数、格式化、剪贴板读取、文本展示复制、CLIP 文本编码。
- 图像反推：多模态模型加载和图像描述/提示词反推。
- 模型加载：UNET、GGUF UNET、内存清理。
- 工作流工具：LoRA 堆叠、种子生成、分组控制。

## 节点功能列表

### 图像尺寸工具

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGAspectRatioAdapter` | GG 图像比例 | 按预设比例/尺寸计算目标宽高，辅助图像尺寸适配。 |
| `GGAspectRatioLatent` | GG Latent | 按宽高和批次数创建 Latent，便于直接接入采样流程。 |
| `GGImageToLatent` | GG 图像-Latent | 将输入图像转换为指定尺寸的 Latent，支持尺寸适配。 |

### 图像工具

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGRGBAtoRGB` | GG RGBA转RGB | 将 RGBA/带透明通道图像合成为 RGB，支持背景处理。 |
| `GGImageResize` | GG 图像调整大小 | 调整图像尺寸，支持插值、比例和边界对齐。 |
| `GGImageCrop` | GG 图像裁剪 | 按位置、尺寸或裁剪模式裁剪图像。 |
| `GGImageTransform` | GG 图像变换 | 执行翻转、旋转等基础图像变换。 |
| `GGImageAdjust` | GG 图像调整 | 调节亮度、对比度、饱和度、虚化、锐化等图像效果。 |
| `GGFaceSkinSmoothing` | GG 人脸磨皮 | 检测人脸区域并生成磨皮遮罩，对脸部进行基础磨皮处理。 |
| `GGFaceSmartBeauty` | GG 智能人脸美化 | 智能检测人脸并对脸部皮肤执行自动磨皮、污点修复、美白皮肤、除油、眼白提亮、眼睛大小、牙齿美白、瘦脸等可调处理；磨皮/修复/美白/除油会自动排除五官区域。 |
| `GGImageStyleReference` | GG 图像风格参考 | 参考另一张图像进行风格、色彩、纹理迁移，并可控制参考强度。 |
| `GGPreviewImage` | GG 图像预览 | 将图像输出到 ComfyUI 预览区域，便于查看中间结果。 |
| `GGSaveImage` | GG 图像保存 | 保存图像到输出目录，支持文件名前缀。 |
| `GGHighQualityImageCompress` | GG meowtec图像压缩 | 参考 meowtec/Imagine 思路进行高质量图像压缩，支持格式、质量、无损和外部优化器。 |
| `GGCaesiumImageCompress` | GG Caesium图像压缩 | 参考 Caesium Image Compressor 思路进行图像压缩，支持目标大小、格式、元数据、渐进 JPEG。 |
| `GGCivilblurImageCompress` | GG civilblur图像压缩 | 参考 mazanoke/civilblur 风格进行本地图像压缩，支持质量、目标大小、最大边长、元数据、渐进 JPEG。 |
| `GGImageComparer2` | GG 图像对比 2张 | 将 2 张图像横向拼接并加标签，用于效果对比。 |
| `GGImageComparer4` | GG 图像对比 4张 | 将 4 张图像横向拼接并加标签，用于多方案对比。 |
| `GGImageComparer8` | GG 图像对比 8张 | 将 8 张图像横向拼接并加标签，用于批量效果对比。 |

### LoRA工具

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGLoRAFileStacker4V2` | GG LoRA选择 4个 | 选择并堆叠最多 4 个 LoRA 文件及权重，输出 LoRA 配置栈。 |
| `GGLoRAFileStacker8V2` | GG LoRA选择 8个 | 选择并堆叠最多 8 个 LoRA 文件及权重，输出 LoRA 配置栈。 |

### 文本工具

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGTextJoin` | GG 文本合并 | 合并两段文本，并支持自定义分隔符。 |
| `GGTextSplit` | GG 文本分割 | 按分隔符或规则拆分文本，输出拆分结果。 |
| `GGTextFilter` | GG 文本过滤 | 按关键词、包含/排除条件过滤文本内容。 |
| `GGTextReplace` | GG 文本替换 | 执行普通或正则文本替换。 |
| `GGTextCounter` | GG 文本计数 | 统计文本字符数、词数、行数等信息。 |
| `GGTextFormat` | GG 文本格式化 | 对文本添加前缀、后缀、补齐、居中等格式化处理。 |
| `GGClipboardReader` | GG 剪贴板读取 | 读取系统剪贴板文本并输出字符串，节点带读取剪贴板按钮。 |
| `GGTextDisplayCopy` | GG 文本展示复制 | 展示文本并输出字符串，节点带复制文本按钮，可快速复制到系统剪贴板。 |
| `GGCLIPTextEncode` | GG CLIP文本编码器 | CLIP 文本编码节点，输出 CONDITIONING，并内置读取剪贴板按钮。 |

### 工具

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGSeedGenerator` | GG 种子生成器 | 生成或控制随机种子，便于工作流复现与批量变化。 |

### 编组控制

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGGroupControllerM` | GG 多组控制 | 控制多个分组/开关状态，用于复杂工作流组织。 |
| `GGGroupControllerS` | GG 单组控制 | 控制单个分组/开关状态，用于简化工作流开关。 |

### 图像分析

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GG反推模型` | GG 反推模型 | 加载 Qwen/Gemma 等多模态反推模型，支持 GGUF、mmproj、上下文长度、GPU 层数、KV 缓存等配置。 |
| `GG图像反推` | GG 图像反推 | 输入图像并调用反推模型生成结构化图像描述/提示词，支持最大边长、最大生成 token、采样参数、think 输出和内存清理。 |

### 模型加载

| 节点ID | 显示名称 | 功能 |
|---|---|---|
| `GGUNET模型` | GG UNET模型 | 加载常规 UNET 模型，并提供加速开关。 |
| `GGGGUF模型` | GG GGUF模型 | 加载 GGUF 格式 UNET 模型，调用 ComfyUI-GGUF 能力并提供加速/数据类型配置。 |
| `GGMemoryCleanup` | GG 内存清理 | 卸载模型、清理缓存并释放 CUDA/系统缓存，用于降低显存和内存占用。 |

## 安装与使用

1. 将本仓库放入 ComfyUI 的 `custom_nodes` 目录。
2. 重启 ComfyUI。
3. 在节点菜单中查找 `GuliNodes` 分类下的节点。

## 依赖说明

- 基础节点依赖 ComfyUI、PyTorch、Pillow、NumPy 等 ComfyUI 环境自带组件。
- 剪贴板相关节点使用浏览器剪贴板 API 和/或 `pyperclip`。
- 人脸和图像增强功能会优先使用 `opencv-python`（`cv2`）；如果环境缺少 OpenCV，相关功能会降级或跳过。
- GGUF UNET 节点需要安装并启用 ComfyUI-GGUF。
- 图像反推模型节点需要对应的 LLM/GGUF/mmproj 文件以及可用的 `llama-cpp-python`。

## 维护说明

- 节点注册入口：`guli_nodes/__init__.py`。
- 图像工具节点：`guli_nodes/image_tools.py`。
- 文本与剪贴板节点：`guli_nodes/text_tools.py`、`guli_nodes/clipboard.py`、`web/gg-clipboard.js`。
- 图像反推节点：`guli_nodes/image_prompt/`。
- 模型加载节点：`guli_nodes/model_loaders.py`。

## 许可

MIT
