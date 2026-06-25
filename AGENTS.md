# AGENTS.md

本文件给后续在本仓库工作的 AI/开发者使用。请先读完本文件，再修改代码或文档。

## 项目概览

ComfyUI-GuliNodes 是一个 ComfyUI 自定义节点与前端增强插件，面向中文工作流效率工具。当前项目包含：

- Python 后端节点：位于 `guli_nodes/`，通过根目录 `__init__.py` 暴露 `NODE_CLASS_MAPPINGS` 和 `NODE_DISPLAY_NAME_MAPPINGS`。
- 前端扩展：位于 `web/`，通过根目录 `WEB_DIRECTORY = "web"` 自动加载。
- 文档与元数据：`README.md`、`pyproject.toml`、`requirements.txt`。

项目目标是保持轻量、中文友好、可直接在 ComfyUI 中使用。主插件原则上不增加额外 Python 依赖，除非功能确实无法通过 ComfyUI 环境自带库或可选外部程序完成。

## 目录职责

### 根目录

- `__init__.py`：ComfyUI 插件入口。保持简单，只导入 `guli_nodes` 映射并声明 `WEB_DIRECTORY`。
- `README.md`：用户文档、节点清单、依赖说明、致谢与借鉴说明、更新记录。
- `pyproject.toml`：打包和 ComfyUI registry 元数据。注意其中版本号和节点数量可能需要随发布同步更新。
- `requirements.txt`：目前只声明无额外 Python 依赖，不要随意加入大型依赖。

### `guli_nodes/`

每个文件负责一组后端节点：

- `aspect_ratio.py`：图像宽高、Latent 尺寸、图像转 Latent、尺寸缩放。
- `image_tools.py`：基础图像处理、预览/保存/压缩、图像对比、风格参考、色彩校正。
- `mask_tools.py`：蒙版绘制到图像。
- `sharpen_tools.py`：CAS 风格锐化。
- `video_tools.py`：视频加载、路径加载、合成、压缩、保存。
- `lora_tools.py`：LoRA 选择和自定义叠加。
- `text_tools.py`：TXT/MD 文本加载。
- `key_tools.py`：API Key/端点/模型配置输入。
- `numeric_tools.py`：数值、浮点滑条、万能滑条。
- `set_get.py`：Set/Get 虚拟连接节点。
- `title_node.py`：画布标题节点。
- `reroute_tools.py`：轻量转接节点。
- `dype_tools.py` + `dype_patch.py`：DyPE 动态位置补丁节点和实现。
- `seed_tools.py`：种子生成器。
- `group_controller.py`：单组/多组控制节点。
- `clipboard.py`：文本显示复制、CLIP 文本相关节点。
- `everywhere.py`：全局转接辅助节点。
- `web_ai_tools.py`：网页 AI 图像/文本反推节点。
- `model_loaders.py`：UNET、GGUF 桥接、VAE 编码/解码缓存、内存清理。
- `zimage_sampler.py`：Z-Image 采样器与集成采样器。
- `seedvr2_aggregate.py`：SeedVR2 视频放大聚合节点。

新增后端节点时：

- 在对应模块中定义节点类。
- 更新该模块的 `NODE_CLASS_MAPPINGS` 和 `NODE_DISPLAY_NAME_MAPPINGS`。
- 如果新增模块，需要加入 `guli_nodes/__init__.py` 的 `_NODE_MODULES`。
- 节点显示名优先中文，节点 ID 保持稳定且唯一。
- 分类统一使用 `GuliNodes/...`。

### `web/`

前端扩展均使用 ComfyUI 前端扩展机制，通常从 `../../scripts/app.js` 导入 `app` 并调用 `app.registerExtension(...)`。

主要文件：

- `gg-settings.js`：GuliNodes 设置入口。
- `gg-toolbar.js`：顶部/底部工具栏。
- `gg-link-style.js`：连接线样式工具。
- `gg-group-styler.js`：GuliNodes 分组样式增强，包装 LiteGraph `drawGroups`，带设置开关和原生回退。
- `gg-group-controller.js`：分组控制节点的前端绘制与交互。
- `gg-title-node.js`、`gg-pretty-reroute.js`、`gg-set-get-nodes.js`、`gg-anything-everywhere.js`：工作流组织类节点前端行为。
- `gg-clipboard.js`、`gg-key-input.js`、`gg-txt-load.js`、`gg-universal-slider.js`、`gg-seed-generator.js`：输入体验增强。
- `gg-image-comparer.js`、`gg-image-compress-save.js`、`gg-video-save-preview.js`、`gg-web-ai-reverse.js`：图像/视频/网页 AI 相关前端。
- `gg-node-theme.js`、`gg-node-autofit.js`、`gg-ui-icons.js`、`gg-comfy-translate.js`：UI、图标、节点样式、翻译辅助。

新增前端扩展时：

- 放在 `web/` 下，文件名使用 `gg-*.js`。
- 使用 `app.registerExtension({ name: "ComfyUI.GGNodes...." })`。
- 设置项统一使用 `GuliNodes.*` 前缀。
- 修改 LiteGraph 或 ComfyUI 原型方法时必须保存原函数、幂等安装，并提供失败回退。
- 不要用全局轮询做高频重绘；必要时用 `requestAnimationFrame`、设置变更回调或轻量事件钩子。

## 编码与命名

- 项目主要面向中文用户，节点显示名、参数名、README 可以使用中文。
- Python 标识符已有中英文混合历史，新增代码优先保持所在文件风格。
- JavaScript 保持现代 ES module 写法，优先 `const`/`let`。
- 不要引入和项目目标无关的重型框架、构建步骤或运行时依赖。
- 文件中已有中文和 Unicode，编辑时保持 UTF-8。

## 依赖策略

主插件维持零额外 Python 依赖：

- 可以使用 ComfyUI 环境通常已有的 `torch`、`PIL`、`numpy`。
- 视频能力可调用外部 `ffmpeg`/`ffprobe`。
- GGUF、SeedVR2 等节点是桥接/聚合节点，应检测可选插件是否存在，并给出清晰错误信息。
- 不要重新引入 README 中已明确移除的额外依赖路线，例如 `cv2`、`mediapipe`、`llama-cpp-python`、`color-matcher`、`kornia`，除非用户明确要求并同步文档。

## 借鉴与致谢要求

如果新增或修改的功能参考了其他插件、论文、算法、UI 实现路线或社区工作流，请同步更新 `README.md` 的“致谢与借鉴说明”板块。

当前已记录的来源类型包括：

- ComfyUI、ComfyUI_frontend、LiteGraph 基础 API。
- ComfyUI-DyPE 适配。
- ComfyUI-GGUF 桥接。
- ComfyUI-SeedVR2_VideoUpscaler 聚合。
- ColorCorrect 类色彩校正功能。
- KJNodes Draw Mask On Image 使用习惯。
- rgthree、Anything Everywhere、Set/Get、Reroute 等社区常见工作流形态。
- CAS 算法思路。
- ffmpeg/ffprobe 视频处理生态。
- ComfyUI-Group-Styler 的前端扩展 + LiteGraph Group 绘制路线。

写致谢时要区分：

- `桥接`：运行时调用外部插件，不内置核心实现。
- `适配`：基于已有实现改造到 GuliNodes。
- `思路参考`：交互或功能形态受启发，但源码为本项目重写。
- `算法思路`：实现了公开算法或常见处理方法。

不要把“思路参考”写成“复制来源”，也不要漏掉实际适配或桥接关系。

## 文档维护

修改节点或前端能力时，检查并更新：

- `README.md` 的“主要能力”。
- `README.md` 的“节点清单”。
- `README.md` 的“依赖与兼容”。
- `README.md` 的“致谢与借鉴说明”。
- `README.md` 的“更新记录”。
- `pyproject.toml` 中版本号、`tool.gulinodes.node_count` 等发布元数据。

当前 README 记录后端实际注册节点数为 58。新增前端扩展不计入后端节点数；新增 Python 后端节点才需要调整该数字。

## 验证建议

根据改动范围选择验证：

- Python 语法：`python -m py_compile guli_nodes/<file>.py`。
- JS 语法：`node --check web/<file>.js`。
- 注册映射：在可用 Python 环境中导入插件入口，确认 `NODE_CLASS_MAPPINGS` 数量和显示名。
- ComfyUI 实测：重启 ComfyUI，确认右键菜单、节点参数、前端设置、画布交互正常。

当前本工作环境里不一定有 `python`/`py` 命令；如果本地 shell 缺 Python，可使用 ComfyUI 自带 Python 环境验证。

## 工作原则

- 先读相关文件，再改代码。
- 保持改动聚焦，不做无关格式化。
- 不要删除用户已有改动。
- 前端增强要有关闭开关或失败回退，尤其是包装 LiteGraph/ComfyUI 原型方法时。
- 后端节点要给出中文、可行动的错误信息。
- 桥接外部插件时不要复制其核心实现，优先检测并调用外部插件接口。
- 新增功能若影响用户可见行为，要同步 README。
