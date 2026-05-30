# ComfyUI-GuliNodes 🎨
[![GitHub Stars](https://img.shields.io/github/stars/guliacer/ComfyUI-GuliNodes?style=flat-square&color=ffcb47)](https://github.com/guliacer/ComfyUI-GuliNodes)
[![GitHub License](https://img.shields.io/github/license/guliacer/ComfyUI-GuliNodes?style=flat-square&color=97ca00)](https://github.com/guliacer/ComfyUI-GuliNodes/blob/main/LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/guliacer/ComfyUI-GuliNodes?style=flat-square&color=0078ff)](https://github.com/guliacer/ComfyUI-GuliNodes/releases)

面向中文用户习惯的 **ComfyUI 效率增强插件**，把日常出图高频操作封装为轻量工具集，覆盖画布整理、图像处理、模型管理、采样、视频处理等全流程，让复杂工作流更易维护、出图更高效。

> 📌 核心优势：零额外Python依赖、纯前端+节点轻量化设计、中文交互友好、低显存/低配设备适配

## 👀 预览效果
| 画布整理 & 节点上色 | 文本快捷操作 & AI辅助 | 图像压缩 & 视频处理 |
|--------------------|----------------------|--------------------|
| ![画布整理预览](https://placeholder.pics/svg/400x250/EEEEEE/666666/画布整理：节点上色/对齐/排版) | ![AI辅助预览](https://placeholder.pics/svg/400x250/EEEEEE/666666/网页AI：图像反推/提示词优化) | ![图像压缩预览](https://placeholder.pics/svg/400x250/EEEEEE/666666/图像压缩：一键控体积/视频处理) |

> 👉 替换为实际截图可大幅提升直观性，建议补充：工具栏操作、连线美化、显存清理按钮、图像对比节点等场景截图

## 🚀 快速开始
### 安装（30秒搞定）
```bash
# 进入ComfyUI自定义节点目录
cd ComfyUI/custom_nodes

# 克隆仓库
git clone https://github.com/guliacer/ComfyUI-GuliNodes.git

# 安装依赖（当前无额外依赖，仅做兼容声明）
cd ComfyUI-GuliNodes
pip install -r requirements.txt

# 重启ComfyUI即可生效
```

### 首次使用
1. 重启ComfyUI后，顶部栏会出现「显存清理」按钮（低显存用户必用）
2. 画布空白处右键 → 找到「GG 系列节点」即可调用所有功能
3. 插件设置可在 ComfyUI 设置页 →「GuliNodes」中调整（如工具栏、连线样式等）

## ✨ 核心功能（按使用频率排序）
### 1. 画布效率神器 · GG Toolbar 🛠️
- 🎨 节点/编组上色：按功能区（采样/模型/后处理）区分颜色，大型工作流一眼看懂
- 📏 批量排版：等宽/等高/对齐/居中/自动间距，告别手动拖节点
- 🪄 一键优化：节点宽度自适应、标题节点美化、转接节点轻量化

### 2. 显存拯救者 · 顶部清理按钮 🧹
低显存/低配设备专属：无需重启ComfyUI，一键卸载闲置模型、清理CUDA缓存，解决「切换模型后显存占满」「出图提示OOM」问题。

### 3. 连线美化 · 数据流向可视化 🧵
自定义连线的颜色、线宽、透明度、流动速度、发光效果，复杂跨区域连线不再混乱，调试工作流更高效。

### 4. 文本操作 · 提示词效率拉满 ✍️
- 文本框悬浮按钮：复制/粘贴/清空一键操作，无需快捷键/右键菜单
- 通配符优化：批量处理提示词随机选项、权重语法，适配批量出图
- CLIP编码简化：一体化加载+编码，减少节点链路长度

### 5. 图像/视频处理 · 一站式落地 🖼️🎬
| 功能 | 场景 | 亮点 |
|------|------|------|
| 图像压缩保存 | 批量出图/网页分享 | 支持WEBP/JPEG/PNG，civilblur/Caesium等压缩模式，控体积更精准 |
| 多图对比 | A/B测试/参数筛选 | 2/4/8图拼接+标签，节点内直接预览对比 |
| 视频处理 | 视频超分/压缩 | 加载/压缩/保存一体化，支持节点内预览，适配ffmpeg |
| 基础后处理 | 出图微调 | 亮度/对比度/锐化/蒙版绘制，无需额外插件 |

### 6. Web AI辅助 · 边出图边反推 💬
在节点内嵌入豆包/腾讯元宝/文心一言网页，复用网页登录态，边看图边做：
- 图像描述/提示词反推
- 风格分析/提示词改写
- 无需切换浏览器，画布内一站式完成

### 7. 模型/LoRA管理 · 灵活轻量化 🧩
- LoRA叠加：4/8/20槽位自定义加载，支持顺序叠加
- 显存友好：UNET/GGUF模型加载适配低显存设备
- DyPE补丁：FLUX/Qwen/Z-Image模型高分辨率生成

## 📋 完整节点清单
### 按功能分类（点击展开）
<details>
<summary>🖼️ 图像、尺寸与潜空间</summary>

| 节点 | 核心作用 | 适用场景 |
|------|----------|----------|
| `GG 图像宽高` | 按比例/边长计算并对齐尺寸 | 出图前统一尺寸规范 |
| `GG Latent/GG Latent2` | 生成空Latent，支持输出宽高值 | 快速起图/下游节点需尺寸参数 |
| `GG 图像-Latent` | 参考图像生成Latent | 复用参考图尺寸 |
| `GG 图像缩放` | 像素空间缩放后回编Latent | 高质量潜空间放大/缩小 |
| `GG VAE解码` | 带缓存的VAE加载+解码 | 减少VAE重复加载，节省显存 |
</details>

<details>
<summary>📝 文本与输入</summary>

| 节点 | 核心作用 | 适用场景 |
|------|----------|----------|
| `GG 文本` | 展示文本+前端复制按钮 | 输出提示词/日志/说明 |
| `GG CLIP文本` | CLIP加载+编码一体化 | 简化文本编码链路 |
| `GG 文本优化` | 通配符/随机选项/权重处理 | 批量提示词变化 |
| `GG 密钥输入` | 安全输入API Key/令牌 | 需密钥的工作流（如第三方API） |
</details>

<details>
<summary>🧩 模型、LoRA与显存</summary>

| 节点 | 核心作用 | 适用场景 |
|------|----------|----------|
| `GG LoRA选择 4个/8个` | 顺序叠加LoRA | 常用LoRA组合快速调用 |
| `GG LoRA自定义加载` | 20槽位动态加载 | 复杂LoRA混搭 |
| `GG UNET/GGUF模型` | 轻量化模型加载 | 切换基础模型/GGUF格式适配 |
| `GG 内存清理` | 卸载模型+清理缓存 | 释放显存/低显存设备 |
</details>

<details>
<summary>🎬 视频处理</summary>

| 节点 | 核心作用 | 适用场景 |
|------|----------|----------|
| `GG 视频加载` | 多格式加载+节点内预览 | 视频输入（mp4/flv/mov等） |
| `GG 视频压缩` | ffmpeg压缩+实时进度 | 控制视频体积 |
| `GG SeedVR2视频放大器` | 聚合超分流程 | 视频放大/超分（需SeedVR2插件） |
</details>

<details>
<summary>🧰 工作流与画布组织</summary>

| 节点 | 核心作用 | 适用场景 |
|------|----------|----------|
| `GG Set/Get` | 画布内变量声明+读取 | 减少跨画布长连线 |
| `GG 多组/单组控制` | 编组启用/跳过 | 大工作流分段调试 |
| `GG 标题/转接` | 画布标注/连线整理 | 工作流可视化/分享 |
</details>

## 📖 常用链路示例
### 1. 极简出图链路
```
GG CLIP文本 → GG 采样器 → GG VAE解码 → GG 图像压缩保存
```
### 2. LoRA混搭出图
```
GG UNET模型 → GG LoRA选择 4个 → GG 采样器 → GG 图像对比 4张
```
### 3. 视频压缩流程
```
GG 视频加载 → GG 视频压缩 → GG 视频保存
```
> 💡 大视频建议放入`ComfyUI/input`目录加载，避免浏览器上传413错误

## 📦 依赖与兼容
| 功能 | 额外依赖 | 备注 |
|------|----------|------|
| 基础功能（画布/图像/文本） | 无 | 仅依赖ComfyUI原生环境 |
| 视频处理 | ffmpeg（可选ffprobe） | 系统需能调用ffmpeg |
| GGUF模型加载 | ComfyUI-GGUF插件 | 需自行安装插件+GGUF模型 |
| SeedVR2视频放大 | ComfyUI-SeedVR2_VideoUpscaler | 需安装插件+对应模型 |

### 模型目录建议
| 资源类型 | 推荐目录 |
|----------|----------|
| UNET/GGUF UNET | `ComfyUI/models/unet/` |
| VAE | `ComfyUI/models/vae/` |
| CLIP | `ComfyUI/models/text_encoders/` |
| LoRA | `ComfyUI/models/loras/` |

## ❓ 常见问题
### Q1: 文本框悬浮按钮不显示？
A: 进入ComfyUI设置 → GuliNodes → 检查「文本框悬浮按钮」是否开启，重启ComfyUI生效。

### Q2: 视频加载提示413错误？
A: 413是浏览器上传文件过大导致，将视频放入`ComfyUI/input`目录后再加载即可。

### Q3: 网页AI节点无法嵌入？
A: 部分平台有跨域限制，可更换嵌入地址（如移动端适配地址）或在外部浏览器打开使用。

## 📄 更新日志
### v1.0.10（最新）
- ✨ 主插件与额外Python依赖解耦，零依赖安装
- 🎨 强化前端能力：工具栏、连线样式、标题节点、Set/Get交互优化
- 🧩 新增：DyPE动态位置、Z-Image采样、遮罩绘制、数值/密钥输入节点
- 📊 累计注册50个实用节点

### 历史版本
- v1.0.9：参数中文化、文本框悬浮按钮、CLIP编码简化
- v1.0.8：AI辅助能力整合、工具栏交互优化
- v1.0.6：新增网页AI图像反推节点
- v1.0.5：视频加载/压缩/保存节点上线

## 🤝 贡献指南
1. Fork本仓库
2. 创建功能分支（`git checkout -b feature/xxx`）
3. 提交修改（`git commit -m 'feat: 新增xxx功能'`）
4. 推送分支（`git push origin feature/xxx`）
5. 提交Pull Request

## 📜 许可证
本项目基于MIT许可证开源，详见[LICENSE](LICENSE)文件。

---
⭐️ 如果觉得插件有用，欢迎给仓库点星支持！如有问题/建议，可提交Issue或联系作者。