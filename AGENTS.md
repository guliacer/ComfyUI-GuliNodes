# AGENTS.md

给在本仓库工作的 AI 与开发者。**动手前先读本文件**；新增或修改功能前先过「二、新功能设计自检」。

## 一、项目与落位

ComfyUI-GuliNodes 是一组面向中文工作流的 ComfyUI 自定义节点 + 前端增强插件。目标：**轻量、中文友好、零额外 Python 依赖**。

| 位置 | 职责 |
| --- | --- |
| `__init__.py` | 插件入口，只导入映射并声明 `WEB_DIRECTORY`，不要加逻辑 |
| `guli_nodes/` | 后端节点，一个模块一组同类节点 |
| `web/` | 前端扩展，文件名一律 `gg-<功能>.js` |
| `README.md` / `pyproject.toml` / `requirements.txt` | 用户文档、打包与 registry 元数据 |

后端模块按能力划分，**完整清单以 `guli_nodes/__init__.py` 的 `_NODE_MODULES` 为准**（不要在本文件里维护副本，容易过期）：

- 尺寸与潜空间：`aspect_ratio.py`｜图像：`image_tools.py`｜视频：`video_tools.py`｜模型与显存清理：`model_loaders.py`
- 文本与输入：`text_tools.py`、`clipboard.py`、`prompt_optimizer.py`、`prompt_lighting.py`、`prompt_library.py`、`key_tools.py`
- 模型与采样：`lora_tools.py`、`zimage_sampler.py`、`seed_tools.py`
- 其它：`numeric_tools.py`、`title_node.py`、`web_ai_tools.py`、`taprelay.py`

新增后端节点：

- 在对应模块定义节点类，更新该模块的 `NODE_CLASS_MAPPINGS` 与 `NODE_DISPLAY_NAME_MAPPINGS`。
- 新建模块必须加进 `guli_nodes/__init__.py` 的 `_NODE_MODULES`，否则不会被加载。
- 节点 ID 稳定且唯一（改动会断旧工作流），显示名用中文，分类统一 `GuliNodes/...`。

新增前端扩展：放在 `web/`，`app.registerExtension({ name: "ComfyUI.GGNodes.<功能>" })`，设置项统一用 `GuliNodes.*` 前缀。前端文件清单直接看 `web/` 目录。

### 模型加载与处理职责（强制）

- 编码、条件构造、解码和图像处理节点只消费上游类型化模型输入。CLIP / VAE 必须分别使用 `CLIP` / `VAE` 输入；模型文件选择、加载、设备放置和缓存归 ComfyUI 原生 Loader 或独立 Loader 节点管理。
- 不得在处理节点里添加 CLIP / VAE 文件名下拉框、调用 `comfy.sd.load_clip` / `comfy.sd.load_vae`，或建立私有模型缓存；不得把 Loader 与文本编码、条件构造、Latent 编解码重新合并成一个节点。优先桥接原生 `CLIPLoader` / `VAELoader`，保留类型化连线。
- 新增节点或重写已有能力前，先搜索 `load_clip`、`load_vae` 及模块级模型缓存。发现已有融合节点时，按「加载节点输出模型 → 处理节点输入模型」拆分，并同步旧工作流迁移、README、使用指南和工作流生成脚本。
- ComfyUI 没有兼容原生类型的专用后端（例如隔离进程的 GGUF 推理）不应伪装成 CLIP / VAE；确需本地模型功能时，明确后端边界。后续若同一专用后端被多个节点复用，再抽成独立 Loader 与专用类型，不复制加载缓存。
- 模型生命周期测试至少覆盖：处理节点不自行加载 / 缓存模型、未接模型时报中文接线提示、外接模型被原样用于运算，以及现有工作流的节点 ID / 输出顺序保持稳定。CLIP / VAE 拆分防回归测试统一维护在 `tests/test_model_loader_separation.py`。
- 拆分或重构模型职责后必须做一次全仓静态审计：检索旧控件名（`CLIP名称` / `CLIP类型` / `VAE名称` / `生成后自动卸载模型`）和旧私有缓存描述（`GuliNodes VAE 缓存` / `VAE 缓存编码` / `VAE 缓存解码`），并同步更新 README、使用指南、示例工作流、生成器与探针脚本。仅为旧工作流保留的兼容字段必须在 tooltip 与文档里注明「不生效 / 不再持有缓存」，不得描述成仍在使用的模型缓存。`tests/test_model_loader_separation.py` 会对用户文档执行这组静态扫描。

## 二、动手前：新功能设计自检（强制）

**适用范围**：新增节点、新增前端扩展、给已有节点加参数/选项/输出、重写已有能力。
**先过一遍下面 8 项并把结论说出来，再动代码。** 最常见的返工不是写错，而是「做出来了但本来不该做」或「做重了」。

1. **必要性**——已有节点换个用法能不能覆盖？是用户明确要求，还是「顺手加的」（顺手加的不做）？ComfyUI 原生或社区插件已经有这个能力吗？有就优先做桥接（见「六」「七」）。只有极少数场景用得上的参数，考虑不落地。
2. **闭环**——后端 `execute`、前端交互、错误信息、文档四处都跟上了吗？空输入 / 未连接 / 0 或负数 / 超范围 / 维度不匹配 / 缺外部依赖都想过吗？错误信息是中文且能说清「哪错了 + 怎么改」吗？新参数进旧工作流会不会回退默认，默认值是否与旧行为一致？
3. **更优方案**——至少想两个再选一个。优先级：ComfyUI 原生机制（`DynamicCombo`、类型匹配）> 复用仓库已有 helper > 新写前端补丁。仓库里已有同类实现就抽共用函数，不要复制第二份。改动会不会影响工作流序列化、端口下标、节点高度这类「用户可感知且不可逆」的东西？有更小的改法吗？
4. **中文参数**——显示名、参数名、选项值、输出名、分类、提示与错误信息一律中文（技术专名除外，见「三」）。
5. **可简化**——参数越少越好：一个选择器能推导出来的不要暴露两个输入；上游能算出来的不要在本节点重复提供；选择器让某些输入失效时按「四」隐藏掉；默认值要能「不填也能用」；近似参数合并。
6. **收尾**——同步 README 与 `pyproject.toml`（见「八」），补齐致谢。**版本号不要动**，改动写进「未发布」小节并顺手更正旧条目。
7. **尺寸归属**——先回答「这个节点的高度/宽度谁说了算」，再写代码。默认规则是**用户拖过的尺寸只增不减**：
   - 自动贴合（行布局 `applyHeight`、面板 `resolveNodeHeight`、`computeSize` 覆写、`lockRowLayoutHeight`、预览贴合）一律取 `max(内容高度, 手动/存档基线)`；手动基线只在 `app.canvas.resizing_node === node` 时记录，读档从 `onConfigure(info).size` 认领，不能在首帧 `computeSize` 上量（那时隐藏控件还没收掉，会量出 1100+）。
   - 只有两种收缩是允许的，且必须在注释与文档里写明理由：① 按槽位精确贴合的 LoRA 类节点；② 新建节点按内容收一次（`shrinkToFit` 这类开关只在 `nodeCreated` 传 `true`）。
   - **禁止在读档、执行回包、预览加载、切换参数等「非用户拖动」路径上把节点设成精确内容高度**——`GG 文本拼接`（改字后缩回最小）与 `GG 视频保存`（读档/执行后缩回最小）都是这个错误。
   - 设计完成后必须验证：跑 `tools/probe_size_shrink.cjs`，或给该节点补一条 `tools/verify_<节点>_height.cjs`，覆盖「拉高 → 触发该节点的重排路径 → 读档」三步，高度都不许掉；同时要断言「用户自己往下拖仍然能变小」，避免把节点焊死。
8. **多路输入要自动新增**——节点接收「同类可互换、数量不定」的多路输入（分支选择、多源合并、批量对比等）时，默认按下面这套做，**不要固定摆满端口或给固定候选下拉**：
   - 输入用 `io.Autogrow`（`TemplatePrefix` / `TemplateNames`，`min=1`，上限按场景定），接线后自动长出下一路。参考实现：`guli_nodes/flow_tools.py`（GG 选择）、原生 `BranchNode` / `And` / `Or`。
   - 类型跟随上游：输入输出共用 `io.MatchType.Template`，不要写死 `"*"` 或单一类型，由第一路连接决定具体类型。
   - 选择器只列已连接项：优先官方分支选择控件（`extra_dict={"widgetType": "COMFY_BRANCH_SELECTOR"}`，且 Autogrow 组名必须是 `autogrow`）；自建下拉用前端 `widget.options.values = () => 已连接项`。**不要**把「输入1~输入20」这类固定候选直接摊给用户。
   - 自动跟随：前端扩展在连线变化 / 读档时把下拉值校准到第一路已连接项（见 `web/gg-switch-branch.js`）；后端在选中项为空或已断开时同样回退到第一路，并给中文提示。
   - 惰性执行：多路互斥只跑一路时，输入要 `lazy=True` 且 `check_lazy_status` 只请求选中项；Autogrow 的惰性键是 `autogrow.<子输入名>`，惰性回调里值会被包成 `(值, 键)`，不要用 `is None` 判断是否已求值。
   - **不要用 `io.Array` 把「已连接名称列表」传给执行器**：当前 ComfyUI 校验会把 list 当连线解析并抛 `KeyError`（官方 `BranchNode` 走 API 同样触发）。名称要么由前端写进 STRING 控件，要么由后端从 Autogrow 键推导。
   - 只有「各路类型不同且必须同时存在」或「固定语义槽位」（LoRA 槽、宽高参数等）才保留固定端口。
   - 主动检查：新增或重写节点时顺手扫一遍同类固定槽端口（含旧节点），符合上述条件的直接按这套改掉并同步文档，不要等用户提出再返工。

**结论指向「不做」或「改成改已有节点」时，这就是正确结果，不要因为已经动手了就硬推下去。**

## 三、命名与文案

- 用户可见的一切用中文：节点显示名、参数名、选项值、输出名、分类、tooltip、错误信息。技术专名保持原样（`Latent`、`VAE`、`LoRA`、`IMAGE`、`FLOAT`、`lanczos` 等格式名）。
- 参数名要自解释，避免歧义缩写；**同一概念跨节点用同一个词**——统一用「宽高比例」「画面方向」「边长类型」，不要一处叫「比例」另一处叫「宽高比」。
- 错误信息中文、可行动：说清哪里错了 + 怎么改，不要只抛原始异常。
- Python 标识符沿用所在文件的历史风格（仓库有中英混排历史），但用户可见字符串必须中文。JS 用现代 ES module 写法，优先 `const`/`let`。
- 文件已含中文与 Unicode，编辑时保持 UTF-8。

## 四、显示规则：不生效不展示

**原则（输入、输出都适用）**：节点只展示当前选择下真正生效的输入与输出。某个选择器（下拉 / 开关 / 接入方式）让部分输入或输出失效时，必须把它们隐藏，不留在界面上误导用户。

**判断依据**：看 `execute` / 主函数——某个输入只在选择器取特定值时才被读取，它对其它取值就是失效输入，应隐藏。

参考实现：`GG Latent` 的 `Latent方式`、`GG 图像宽高` 的 `宽高方式`、`GG 图像缩放` 的 `输出类型`。

### 输入侧

优先用后端 `io.DynamicCombo`（原生、随选择切换，首选方案）：

- 选择器改成 `DynamicCombo.Input`，每个 `DynamicCombo.Option(key=..., inputs=[...])` 只放该取值会用到的输入；始终生效的共享输入留在 `Schema` 顶层。
- 某个方式下确实不生效的输入要一并去掉，不要照抄兄弟节点的整份输入表。例如 `GG 图像宽高` 的「按图像接入」只输出目标宽高，「缩放方法」不改变目标宽高，因此该方式下不展示它。
- `execute` 收到的是嵌套值，用 `aspect_ratio._unpack_mode` 解包（要同时兼容嵌套 / 扁平 / 裸字符串三种形状）。
- 同一套方式被多个节点共用时，把方式选项、`DynamicCombo` 构造、解包与分派抽成模块级共用函数，两个节点只在 `outputs` 和最终返回值上区分（见 `_latent_mode_inputs` / `_adapter_mode_inputs`）。
- 按「宽高比例 / 边长 / 边长类型 / 画面方向 / 分辨率」算像素宽高，统一走 `aspect_ratio.dimensions_by_ratio` / `dimensions_by_resolution`（内部用 `align_to_eight` / `apply_orientation`）。**不要在节点里再写一份比例表或对齐逻辑**：`GG 图像裁剪` 曾自带一套 `_CROP_*` 常量和三个计算函数，与 `GG Latent` 逐字重复，已合并；新增按比例算尺寸的节点直接复用这几个函数，需要「不摆正方向」时给 `dimensions_by_ratio` 传 `画面方向=None`。
- `DynamicCombo` 的 key 只能是字符串；布尔开关要改成二选一 `Combo`（见 `GGVideoCompress` 的 `分辨率处理`）。
- 方式选择器只在 `INPUT_TYPES["required"]` 里声明一次，**不要**再放进 `optional` 扁平表——`/object_info` 会把两个桶原样发给前端，同名键可能建出两个控件。
- 需要双路时按仓库写法：先定义 legacy 类，再在 `if io is not None:` 内定义 `..._V3(io.ComfyNode)` 并 `原名 = _V3`（见 `image_tools.GGImageCrop`）。
- 取舍：改成 `DynamicCombo` 会改变控件序列化，旧工作流里被隐藏输入的手动值可能回退默认（选择器值保留）。这是可接受的代价，但要在更新记录里说明。

以下情况改用**前端隐藏**（切换 `widget.hidden`/`type`/`computeSize` 并重算节点尺寸，不改序列化）：节点继承 `SaveImage`、含 DOM 面板、带 `IS_CHANGED`/`onExecuted` 联动，或由「是否连接某输入」驱动而非显式选择器。
参考 `gg-seed-generator.js`（偏移模式）、`gg-image-compress-save.js`（PNG 格式）、`gg-web-ai-reverse.js`（平台）、`gg-web-ai-reverse-text.js`（未连本地模型）、`gg-lora-custom-loader.js`（LoRA 数量）、`gg-prompt-enhancer.js`（任务模式/增强方式切换显隐参数）、`gg-image-comparer.js`（未接图像的标签行）。
前端隐藏要幂等、能在切换后重新同步，并对找不到的控件安全跳过。

### 输出侧

**不要在前端隐藏输出端口。** 本仓库的 `GG 图像缩放` 曾为「按输出类型只显示对应端口」写前端隐藏逻辑（`web/gg-image-scale-outputs.js`），实测在用户环境（Nodes 2.0 / Vue 渲染、或触发时机问题）下整片失效——表现为「选了输出类型后输出源消失」。参照同插件 `GG Latent`（纯 V3、端口永不隐藏、永远按声明渲染），正确做法是：**输出端口一律在 V3 `io.Schema` 里声明、永远显示，前端不做任何端口隐藏**。

- **输出端口不能从 `node.outputs` 里删除**：后端按 `origin_slot` 下标读取上游返回值（`ComfyUI/execution.py`：`output_index = input_data[1]` → `cached.outputs[output_index]`）。`RETURN_TYPES` 固定，删下标 0 会让后续端口下标前移，已有连线携带的 `origin_slot` 取到错误分支。
- **本机前端没有「动态输出」控件**：`comfy_api/latest/_io.py` 的 `DynamicOutput` 只是抽象类（`pass`），前端也只识别 `COMFY_DYNAMICCOMBO_V3` / `COMFY_AUTOGROW_V3` / `COMFY_MATCHTYPE_V3`（均针对输入）。V3 没有声明式条件输出，所以「按模式显示不同输出」在框架层面不支持。
- 若确有「按模式给不同输出」的需求，正确做法是**拆成多个节点**（如 `GG 图像缩放` 与 `GG 图像尺寸`，各自固定输出），而不是在一个节点里隐藏端口——这与 GG Latent 用 `GGAspectRatioLatent` / `GGAspectRatioAdapter` 各自声明自己输出的思路一致。
- 历史踩坑（保留作反面教材，不要再走）：
  - `output.hidden` **不能**隐藏画布输出端口，本机前端里它只作用于控件（widget）。
  - 给输出设 `output.pos = [4000, 0]` 在经典画布 `calculateOutputSlotPos` 里能让端口停在屏外，但 Nodes 2.0 走 Vue 渲染、完全无视 `.pos`，隐藏不生效；且触发时机容易漏掉，结果不稳。
  - 覆写 `getOutputPos` 去传「压缩后的行号」会让 `calculateOutputSlotPos` 用压缩行号索引 `this.outputs[slot]` 取到错误输出对象，端口位置错乱、整片消失——这是最初 Bug 的根因。
  - **删除输出隐藏补丁后要迁移历史工作流状态**。旧版本可能已经把 `output.pos` 停放坐标或空的 `outputs` 数组序列化进工作流；只删除补丁并不能让已加载节点自动恢复。对固定输出节点要加一次性兼容迁移：清理残留 `output.pos`，按固定顺序补回缺失槽位，并标记画布/工作流变更；迁移本身仍不得隐藏或删除有效输出。

## 五、前端扩展红线

- 包装 LiteGraph / ComfyUI 原型方法时必须保存原函数、幂等安装、提供失败回退，并带关闭开关（参考 `gg-group-styler.js` 包装 `drawGroups` 的写法）。
- **优先包装原型，不要挂到画布实例的自有属性上**。写成 `app.canvas.drawNode = wrapped` 会遮蔽 `LGraphCanvas.prototype`，此后所有扩展在原型上安装的补丁都**静默失效**（没有报错，只是不画了）——`GG 标题` 曾因此只剩一个空框、标题文字不显示。只在画布实例已自带该方法时才包装实例。
- 反过来，只包原型的扩展要能识别被遮蔽：当 `canvas.drawNode !== LGraphCanvas.prototype.drawNode` 时补包一次实例（`gg-title-node.js` 的做法），否则本功能会在别的扩展先装实例包装时整个失效。补包实例时**必须加绘制重入保护**（`WeakSet` 判断 + `finally` 清除，清除要在 `original.call(...)` 之后）：原型补丁和实例补丁可能同时命中一次调用链，导致同一节点画两遍。
- **不要留"看起来装好了但画不出东西"的钩子**。一个钩子若坐标系用错、或把宿主对象误当作目标参数传入，它可能永远画不出内容，却让安装流程返回"成功"并跳过真正可用的钩子。宁可删掉，只保留一条真正生效的钩子，并明确唯一的回退路径；两条钩子同时生效会重复绘制。
- **节点级装饰只用 `drawNode`，不要另开帧级叠加层**。`drawNode` 在 LiteGraph 的 `translate(node.pos)` 之内调用，坐标系就是节点局部坐标（原点在节点左上角，尺寸即 `node.size`）；帧级钩子（`drawFrontCanvas` / `onDrawForeground`）在图坐标系下运行，既要在绘制前手动 `toCanvasContext()`，又等于把效果铺到整张画布之上、脱离节点。**屏幕像素常量（偏移、线宽、阴影、粒子位移）一律除以画布缩放 `ds.scale`**，否则缩放画布时效果尺寸会跟着变。
- **贴边描边光环会被看成"节点背后的底板"，不要用**。任何沿节点轮廓描边或铺一条外扩光带的画法（哪怕加了模糊）都带一条贴着节点边界的**清晰内边**，观感是节点背后垫了一块彩色底板，也就是"背景图层"，而不是光从节点漏出来。要表现"光从节点散发出去"，就让光本身从边界向外扩散（粒子/径向柔光），不要画轮廓几何。注意参考实现用 `destination-out` 擦掉卡片内部正是为了藏掉这条内边——不擦就不成立。
- **动态效果要真随机，不能是"固定变化的动效"**。按 `节点id + 效果 + 下标` 哈希取位、再让粒子沿固定环振荡，看着在动但每次都是同一套排布，观感机械。正确做法是给每个「节点+效果」一条线性同余随机序列，用随机值决定出生位置、位移目标、生命周期、半径、速度、相位，并在会话切换（开关/模式/强度/效果池变化）时更换种子——同节点同效果的两次会话必须给出不同排布。
- **绘制配色要跟随画布明暗**。ComfyUI 内置 `light` 调色板的画布底色是 CSS 命名色 `lightgray`，深色主题用的浅亮色（`#ffffff` 一类）在浅底上亮度差不到 0.1，视觉上等于没有效果。主题判定依次取 `LGraphCanvas.clear_background_color`、`Comfy.ColorPalette`、`document.body` 背景色，解析时记得处理 CSS 命名色，并且**按秒缓存**——`getComputedStyle` 每帧每节点调用会拖死主线程。
- **`save()` / `restore()` 之间的 `globalAlpha` 会漏给下一段绘制**。同一节点内先画光环、再画高光扫过、最后画粒子时，粒子会继承上一步留下的 `globalAlpha`（曾因此整体偏暗）。每段独立绘制前显式设定自己需要的 `globalAlpha`，不要依赖上一段的遗留值。
- **为长期存活的状态设计动画节奏**。参考实现里"分批生成"的效果（花瓣、爱心）在一次悬浮会话内用完配额就结束，因为它悬停结束即卸载；本插件节点可以长期保持选中，照抄会让效果播完第一批后**永久停止**。配额用尽后要隔一段随机时间重新补给。
- **节点级光效必须在原始 `drawNode` 之后画**。标题栏是 `drawNode` 里画的不透明矩形，如果光效在 `original.call(...)` **之前**绘制，那么从节点上边界（y=0）出发的粒子在生命最初一段（约一个标题栏高度）会被标题栏盖住，视觉上就是"顶部扩散范围比左右两侧短一截"。正确做法是：先 `original.call(this, node, ctx, ...args)` 画节点本体（包括标题栏），再画光效，让粒子绘制在标题栏之上。坐标系仍然在节点局部（外层 `translate(node.pos)` 直到整个 `drawNode` 返回后才 `restore`），不需要额外变换。`reentrant` 重入保护要在调 `original` 之前就标记 `WeakSet`，保证原型补丁和实例补丁只会画一次。
- **切换控件显隐时,`type` 必须先于 `hidden` 写**:隐藏时先写 `hidden = true` 再把 `type` 换成隐藏类型;显示时先把 `type` 恢复成真实类型再写 `hidden = false`。前端 `hidden` 的 setter 只在当前 `type` **不是** legacy 隐藏类型时才把值写回控件原始选项(名字含 `hidden` 的 `ggHiddenXxx` 都会被判定为隐藏类型);顺序写反时 `type` 一变、控件类被重新套用,可见性会从旧值重新派生,表现为「该显示的控件不显示,要再操作一次才出现」。仓库内所有显隐 helper 一律按此顺序。
- **原型上的安装标记不能和实例标记同名**。`nodeType.prototype._xInstalled = true` 之后，实例里读 `node._xInstalled` 会顺着原型链拿到 `true`，于是「每个节点装一次」的逻辑被整段跳过，而且**不报错、测试台里也看不出来**（`GG 文本拼接` 的控件回调包装曾因此完全没生效，表现为「填了第一个框却不增行」）。原型用 `_xProtoPatched`、实例用 `_xWrapped` 这类不同名字，测试台要走 `beforeRegisterNodeDef` 建原型再实例化，否则测不到。
- **不要只靠 `widget.callback` 感知文本改动**。新版前端（Vue 渲染的文本控件）改字时不一定回调 `widget.callback`，只挂回调会出现「输入了但界面不响应」。做法是回调 + 节点绘制钩子双保险：在 `onDrawForeground` 里比对一次状态，用「上次结果」做缓存，数量没变时只花一次比较，不算高频重绘。
- **文本框字数角标只在 `web/gg-text-counter.js` 维护**：只扫 GuliNodes 节点的多行 `TEXTAREA`（单行输入框、API Key、文件名不统计），角标挂在宿主 `.dom-widget` 父容器里绝对定位，不要在每个节点里各写一份。统计口径是去掉空白后的 Unicode 码点数，验证见 `tools/verify_text_counter.cjs`。
- **面板类 DOM 控件的高度一律走 `web/gg-panel-fit.js`**（`measurePanelHeight` / `nextWidgetHeight` / `lockPanelChildren` / `scheduleRefit`），不要自己读 `host.scrollHeight` 定高。面板高度是「量内容 → 交给节点定高 → 前端再按它给面板定高」的闭环，在受限状态下量到的是被挤压后的值，会被当成正确值锁死；而且前端分配的高度比 `computeSize` 请求的少约 16px，不补就裁掉面板底部。`GG 镜头打光提示词` 的 72 个光效曾整块消失（光效区被压成 0 高、顶栏还写着「共 72 种」），就是这两件事叠在一起。**判断「面板有没有被裁」只看 `host.scrollHeight` 与 `host.parentElement.offsetHeight`**：面板容器的高度是跟着**内容**走的（≈ `computeSize` − 16），不是跟着节点高度走，所以 `node.size[1] - wrapper.offsetHeight` 不是固定的「节点 chrome」——内容变矮时 wrapper 立刻缩、节点还没缩，算出来的差额会跟着膨胀，`height = 自然高度 + 差额` 恒等于当前高度，`fitNode` 从此永远提前返回、节点再也缩不回去（这个改法试过，已回退）。
- **面板宽度只能跟着节点走，不许有独立的最小宽度**。面板比节点宽时，它不会把节点撑大，只会从右边戳出去（`GG 提示词库` 曾把「面板最小宽度 380」当默认宽度用，节点拖到 240 时面板还是 352，溢出 112px）。做法是 `panelWidth = nodeWidth - 内边距`，最小值只加在**节点**上；`computeSize` / `onResize` / 重贴合三处都要按同一个口径算，否则换个入口又冒出来。
- **栅格按条数平均分布，别固定列数**。固定 3 列时 4 条排成 3 + 1，最后一行孤零零一个、右边空一大片。先按可用宽度算出最多能放几列 `maxCols`，再按 `ceil(count / ceil(count / maxCols))` 反推列数：3 条 → 1 行 3 列、4 条 → 2 行 2 列、5 条 → 3 + 2。列数要跟着宽度重算（宽度变了要重新 `gridTemplateColumns`），并且栅格项必须 `min-width: 0`，否则卡片不会低于内容宽度、整列被撑出去。卡片上的操作按钮用绝对定位浮在右端，别当 flex 兄弟——隐藏时它照样占宽度，三列下名字会被挤成省略号。
- **面板里带滚动的那一段必须 `flex: 0 0 auto`**（由 `lockPanelChildren` 统一加）。CSS 规定 `overflow` 不是 `visible` 的元素其 `min-height: auto` 解析为 0，父级高度只要比内容小一点，挤压就全落在它身上，直接归零；其它段落有最小高度保护反而毫发无伤——所以现象是「只有那一块消失」，很容易误判成数据没了。
- **面板配色一律走 CSS 变量 + `[data-*]` 属性，不写内联颜色**。悬停 / 键盘焦点 / 选中 / 禁用这些状态没法用内联样式表达，写进内联就再也盖不住，只能靠 JS 逐个切色——`GG 镜头打光提示词` 的按钮曾因此看着像「已经按下去的输入框」，与选中态分不清。深 / 浅两套调色板都写在样式表里，JS 只决定用哪套（用户手动指定优先，否则跟随宿主主题）并写到 `data-*` 上；宿主主题按 `Comfy.ColorPalette` → 画布底色 → `body` 背景判定，**按秒缓存**（`getComputedStyle` 每帧调用会拖死主线程）。注意宿主变量挂在祖先作用域，用 `:root` / `body` 读不到实际值，别拿它判断主题。
- **用户拖出来的宽高只增不减，自动布局不许替他收回去**。统一入口是 `web/gg-node-autofit.js`（对所有 `GG*` 节点生效）：手动拖过的节点记 `_ggAutoFitManualSize`，之后所有贴合都按「不低于它」算，`loadedGraphNode` / `onConfigure` 也一律只增不减，否则重开工作流就按内容重排一次、用户得反复拉。判断「用户真的拖过」只用 `app.canvas.resizing_node === node`，其它布局引起的 `onResize` 不算，否则节点再也收不回去。面板节点另有 `web/gg-panel-fit.js` 的 `trackManualHeight` / `captureManualHeight` / `resolveNodeHeight` / `resolveNodeWidth`，内容异步加载的面板还必须加 `panel.ready` 闸（加载完再贴合），并从 `onConfigure(info)` 的 `info.size` 认领存档尺寸——前端 `addDOMWidget` 会用 `expandToFitContent` 先压一次，事后认领已经晚了。两个坑：**`node.size` 在这个前端是 `Float64Array`**（`Array.isArray` 恒为假，守卫会静默失效），判尺寸要用「有 `length` 且能取到两个数」；**前端下拉控件换选项会直接写 `node.size`**，扩展拦不住，恢复时的下限必须用手动尺寸而不是当前尺寸。例外：`GG LoRA自定义加载`（跟随槽位精确贴合）、`GG 图像压缩保存`（切格式保留多余高度）本来就按内容调整，不要统一进来。
- **单行多列布局只在 `web/gg-widget-rows.js` 里做，别在业务文件里自己排 y**。canvas 渲染下控件是竖向堆的，想一行放多个必须同时接管四处：`_arrangeWidgets`（同行同 y + 记 `widget._ggCol = {x, w}`）、`drawWidgets`（画前 `ctx.translate(col.x)` 并把列宽当宽度传）、`getWidgetOnPos`（按列矩形命中，用 `col.x + SIDE` 起、`col.w - 2*SIDE` 宽，别用带内边距的整格）、控件 `onClick`/`onDrag`（派发时临时把 `node.pos[0]` **右移**列偏移，让控件内部的 `canvasX - node.pos[0]` 变成列内坐标）。只做前两处的结果是「画得对、点不对」：数值控件的增量区判断用 `this.width || node.size[0]`，不给 `widget.width = col.w` 就会量整条节点，点列右端弹输入框而不是 +1。节点登记在 `web/gg-widget-row-presets.js`（`columns` / `weights` / `weightsByRow` / `minWidth` 数字或 `"auto"` / `"content"` / `maxRows` / `fullWidth` / `rows(node)` / `drawColumn` / `columnWidth(widget)` 申报自绘列真实内容宽 / `groups: [{title, match}]` 节标题分组 / `labels` / `autoWrap`）。**画布控件的统一皮肤在 `gg-widget-rows.js` 的 `drawSkinned`**：combo / number / text / toggle / button 自动换 `--gg-*` 皮肤（field 底 + divider 边 + 圆角 6，标签 muted 值 ink），主题跟随 `detectHostTheme` 按秒缓存；命中区沿用官方语义不动；多行文本、图像预览、`gg_*` 自绘块、带 element 的控件自动跳过；`drawColumn` 自绘列优先级高于皮肤。**节点自带颜色时控件底必须按节点「实际渲染色」派生**（读 `node.renderingBgColor`，浅色主题会先把节点色按 `nodeLightness` 调亮；只读 `bgcolor` 原值会让浅色节点配深色控件，看起来像蒙了一层黑），不能固定吃主题 `--gg-field`；缓存键必须带上该颜色，否则同一工作流里不同颜色的节点会串色。**布局外 DOM 预览的 y 必须按参数区实际底部兜底**：宿主 `_arrangeWidgets` 偶尔少算最后一行（实测「清除内存」在 166、预览从 170 就开始，压住整行），reflow 里要把 y 推到「参数底 + ROW_GAP」并等量收掉 `computedHeight`。**布局口径（2026-11-04 定）：非必要一律单列**——`columns: 1` + `minWidth: "content"`（引擎按「最宽控件完整显示所需」收宽度；`contentWidth()` 只量多控件行，单列量出来是 0，所以单列必须走这个模式），只有确实有必要的节点才两列（`columns: 2`：同形滑杆成对省高不出孤行，或参数天然成对——现有 4 个：色彩校正、脸部平滑、风格参考、纯色图像宽高），三列及以上不再使用。量列宽的口径不变：按「标签 + 数值 + 60」（前端 `BaseWidget.drawTruncatingText` 要求传给控件的 `width >= 标签 + 数值 + 90`，而列矩形 `w = 列宽 + SIDE*2` 已多带 30，故列宽只需 60；按 90 算会每列白撑 30px）。`autoWrap` + `minWidth: "auto"` 的折行搜索仍留在引擎里，只给确有需要的场景。量取值必须读 `widget._displayValue`，不能读 `widget.value`。`labels` 只改 `widget.label`，`name` 与 `widgets_values` 不许动。种子节点的 `control_after_generate` 可以一起排，显示名换成 `生成后`。**带多行文本框的节点不能套行布局**：这类控件走 `computeLayoutSize`，高度由节点剩余空间分出来，自定 y 会跟官方排布打架（文本块压到控件行上、高度每帧翻倍）；引擎里对这类节点只调宽度、y 交回官方，误登记也会自动退回原生竖排。自绘界面（标题 / 文本 / 密钥输入 / 打光提示词 / 提示词库 / 网页反推 / 视频保存）、图像决定高度的（图像预览、图像对比）也不登记。新改造一个节点必须跑 `tools/verify_all_rows.cjs`（逐格 `需要宽 ≤ 实给宽` + 无重叠 + 截图）；改模式型控件还要跑 `tools/verify_dynamic_rows.cjs`（每个取值切一遍），改引擎要跑 `tools/verify_workflow_reload.cjs`（存图 → configure 回来），另加 `tools/verify_row_presets.cjs`；改动 LoRA 还要跑 `tools/verify_lora_rows.cjs`（真实点击）与 `tools/verify_lora_roundtrip.cjs`（老工作流兼容）。宽度按「各行内容宽」收紧：每列只拿自己完整显示需要的宽度、从左贴紧排，行尾留白不摊到各列（官方控件是标签左对齐、数值右对齐，列宽给大就夹出一大片空白）；节点被拉宽时富余先补给取值被截断的列。老工作流里存的宽节点在「控件集合变了」或刚加载时收窄一次，之后用户拉宽不再干预。新增界面时 `import { applySurface, ensureGGDesign }`，容器加 `gg-surface`（弹层再加 `gg-popover`），色值一律取 `--gg-panel` / `--gg-card` / `--gg-btn` / `--gg-btn-hover` / `--gg-ink` / `--gg-muted` / `--gg-faint` / `--gg-divider` / `--gg-accent` / `--gg-field` / `--gg-ok` / `--gg-danger`，**不要在业务文件里再写十六进制或 `--comfy-*`**——猜宿主变量名就是「深色主题里一行灰字 / 一块白底」的来源（密钥面板与提示词库都栽过）。按钮统一用 `.gg-ui-top-button`（顶栏 30px）、`.gg-btn`、`.gg-icon-btn`（`.is-outline` 描边变体）；尺寸由使用方内联给，**颜色与四态留给设计层**，不要在 JS 里写 `style.background = 开 ? 蓝 : 白`。用户可选颜色的地方，默认值必须是「空 = 跟随主题」，并且提供回退入口；把「没选过」存成 `#ffffff` 的旧数据要迁移。
- **调色板只有一处：`web/gg-ui-design.js` 的 `PALETTES`**。新增界面时 `import { applySurface, ensureGGDesign }`，容器加 `gg-surface`（弹层再加 `gg-popover`），色值一律取 `--gg-panel` / `--gg-card` / `--gg-btn` / `--gg-btn-hover` / `--gg-ink` / `--gg-muted` / `--gg-faint` / `--gg-divider` / `--gg-accent` / `--gg-field` / `--gg-ok` / `--gg-danger`，**不要在业务文件里再写十六进制或 `--comfy-*`**——猜宿主变量名就是「深色主题里一行灰字 / 一块白底」的来源（密钥面板与提示词库都栽过）。按钮统一用 `.gg-ui-top-button`（顶栏 30px）、`.gg-btn`、`.gg-icon-btn`（`.is-outline` 描边变体）；尺寸由使用方内联给，**颜色与四态留给设计层**，不要在 JS 里写 `style.background = 开 ? 蓝 : 白`。用户可选颜色的地方，默认值必须是「空 = 跟随主题」，并且提供回退入口；把「没选过」存成 `#ffffff` 的旧数据要迁移。
- **「自动」主题不许把判定结果钉成属性**。`applySurface` 在 auto 模式必须 `removeAttribute(THEME_ATTRIBUTE)`，让 `.gg-surface` 继承 `<html>` 上的全局令牌；只有用户手动指定深/浅时才写属性。钉死一次之后，宿主切主题旧面板会停在原来的皮肤上（实测底部工具栏在深色主题里一直是浅色，而且不报错、看代码也「有主题逻辑」）。
- **CSS 自定义属性只能 `style.setProperty("--x", v)` 写**。`style["--x"] = v` 和 `Object.assign(style, {"--x": v})` 都静默无效，变量读出来是空的，表现为「颜色没生效但也没报错」。
- **JS 模板字符串里写 CSS 注释时不能出现反引号**。样式表整段塞在模板字符串里，注释里写 `.gg-btn` 这类反引号包裹的类名会提前结束字符串，`node --check` 报 `SyntaxError: Unexpected identifier`，而报错位置看起来毫不相关。
- **「基础 / 高级」这类显示模式只改显示**：不得清除已选项、不得改变输出内容。被模式藏起来的项若已被选中，必须保持可见可取消，否则会出现「标题写着已选 2、列表里却找不到是哪两项」；分组计数也要跟着写成「6 / 8 项」，与眼前的按钮对得上。模式与主题属于用户偏好，跟着工作流存进 `properties`；折叠 / 滚动位置才是纯浏览状态，不存。
- **判断「控件是否已接线」必须看 `input.link != null`，不能只看 `node.inputs` 里有没有同名条目**。新版前端会把**每一个控件**都镜像成一条 `node.inputs` 条目（`widget: { name }`、`link: null`），只按名字匹配等于把所有控件都当成端口：`GG 文本拼接` 曾因此一次性把 20 个文本框全放出来（每个都被判定为「已接线、必须可见」）。测试台必须专门造一组「全部镜像 + 全部 `link: null`」的节点来覆盖这条，否则桩里没有镜像条目，测不出这个 bug。
- **已接线槽位的控件显隐归前端，我们只交还类型与尺寸，不碰 `hidden`**。实测前端对已接线控件只改 `hidden`（接线置 `true`、`removeLink` 置 `false`），**从不改 `type`**。我们若连 `hidden` 一起改，就是和前端抢同一个开关：要么接线后空框冒出来，要么断开后 `type` 还停在 `ggHiddenXxx`、前端把 `hidden` 放开也渲染不出高度。做法是「还原 `type` / `computeSize` + 清掉自己的隐藏标记 + 留一个『已交还』标记」，断开后若看到该标记且 `hidden` 仍为真就补一次——因为前端只有 `removeLink` 这条路会自己放开，`disconnectOutput` 不会。**这个标记要在「看到接线」时无条件写上，不能只在「我们曾经藏过它」时才写**：接线前它本来可见的控件我们没有隐藏标记，一旦漏写，`disconnectOutput` 断开后控件就永远藏着、而我们以为它已经显示了。这类改动**必须让 `onConnectionsChange` 走强制重算**，否则「可见数量没变、缓存命中」会让交还逻辑整段跳过。
- **被前端藏起来的「已接线控件」要补一条带名字的标记行**。前端对已接线控件只留一个端口点，而隐藏的控件行仍按原高度参与排版：`GGPromptEnhancer` 的多行文本区实测保留 318px，节点中间一大块空白，端口点也没有任何文字，用户看不出线连在哪。做法：把隐藏控件收成一行（同时写 `computeSize` 与 `computedHeight`，然后必须调 `node.arrange()` 才会重排）、在该行画「控件名 ← 上游输入」；断开时由扩展自己放开 `hidden`（部分断开路径前端不会放开），并用一帧延迟把接线前的节点高度还原——引擎在断开这一帧可能已按「没有多行文本区」把节点收矮，当场设回去会被它再收一次。自动重排期间的 `setSize` 要用 `_ggEnhancerApplying` 闸住，不能记进用户高度记忆。验收跑 `tools/verify_prompt_enhancer_wired_rows.cjs`（12 项）。
- **自动增长的槽位，接线也要算「在用」**。只按文本框内容计数时，把第一个槽位转成输入端口并接线之后，节点上就只剩一个端口、一个能打字的框都没有（`GG 文本拼接` 用户实测报的缺陷）。但也不能「有连线就参与计数」——那会隔着空位接线时把前面的空框一起撑出来。正确口径是**只在可见范围末尾顺延**：先按内容算出范围，若范围正好停在一个已接线的槽位上就往后挪，直到落到未接线的槽位；隔着空位接第 3 个槽位时范围仍停在 1。接线槽位控件里的残留文字是死数据，一律不参与计数。
- **改连线的源槽位只能走 `link.origin_slot = 新槽位` 这个 setter**。新版前端的 Link 是带 `_state` 的代理对象，这个 setter 会同步 `_state.originSlot` 和两端的 `output.links` / `input.link`。绕过它去手写 `link._state.originSlot`、或自己把 `output.links` 清空重挂（`GG 简单数学表达式` 的旧连线迁移栽过），三处状态立刻对不上，**连线在下一帧被整条删掉**。同理不要用 `removeOutput` 退役端口——它内部 `disconnectOutput`，会把该槽位的连线一并断掉；只清尾部未接线的槽位才安全。
- **视频保存这类「预览决定高度」的节点，只在新建时按内容收一次，其余路径只增不减**。`GGVideoSave` 的预览贴合原来在读档、执行回包、`loadedmetadata` 三条路径上都按内容精确设置高度，用户拉高 / 工作流里存的高度每次都被收回最小高度。做法：`lockPreviewInsideNode(node, shrinkToFit)` 只在 `nodeCreated` 传 `true`，`loadedGraphNode` / `onExecuted` / `loadedmetadata` 一律 `max(当前高度, 内容高度)`；用户自己往下拖仍走 `onResize` 的下限钳制，不会被锁死。验收跑 `tools/verify_video_save_height.cjs`，全仓排查用 `tools/probe_size_shrink.cjs`。
- **`GG 文本拼接` 的高度只增不减，首帧不能量 `computeSize`**。槽位按内容自动长出来，若每次改字都重新贴合，用户拉高的尺寸会被一路收回最小高度（用户实测报的缺陷）。规则：① 首帧布局会把 20 个槽位全算进 `computeSize`（实测 1100+），必须等隐藏槽位真正收掉后再量——`ready` 门控 + 120 / 320 / 800ms 三轮重试；② 取 `max(自然高度, 手动基线)`，手动基线只在 `app.canvas.resizing_node === node` 时记录；③ 读档用 `onConfigure` 的 `info.size[1]` 当基线，settle 期间以它为下限、结束后锁死；④ 延迟重试必须无条件走 `fitNode`：`syncSlots` 的可见数量缓存命中时 `changed` 为 false，强制同步不补这一下，高度就永远停在首帧的 1100+。验收跑 `tools/verify_text_concat_height.cjs`。
- **老存档的 `widgets_values` 比当前控件数短时，要在原始 `configure` 之前补齐**。新版前端按控件数重建 `node.inputs` 里的控件镜像条目，长度对不上就会把连线的 `target_slot` 打乱，**整条连线在 configure 阶段就被丢掉**（`GG 简单数学表达式` 从 2 条表达式扩到 10 条时实测）。做法：patch `nodeType.prototype.configure`，在调原始 `configure` 之前把 `info.widgets_values` 补到当前控件数（前缀保留用户原值，后面补默认值），同时记下「这是老存档」以便做槽位迁移。
- **别用「`serialize()` 后改字段」拼旧工作流夹具**。`widgets_values` 长度、`outputs` 数组、`links` 元组互相牵制，改一处就变成不自洽的混搭格式，测出来的是夹具问题不是产品逻辑（`GG 简单数学表达式` 的旧连线迁移用这种方式反复假失败）。正确做法：用真实连线建图，再把「旧状态」（旧输出名、老存档标记）直接注入节点对象，驱动真实的同步路径。
- **控件显隐 / 端口增删之后必须显式收一次高度**。`gg-node-autofit.js` 在「打开工作流」路径上是 `allowShrink: false`（用户拉出来的宽高要留住），内容变小后没人收，节点就留着全可见时撑出来的空白（`GG 图像对比 N张` 实测 800~990 高、下面一大片空白）。统一入口是 `refitAfterContentChange(node)`（导出自 `gg-node-autofit.js`）——**必须走它内部的同步 `fitNode`，不要用 `scheduleFit` 异步派发**：那个队列合并 `allowShrink` 时是「只降不升」（有一路说不许缩，整批就不许缩），而加载路径正好排着一路 `allowShrink:false`，异步会被它盖掉、高度收不回来。用户手动拖过的节点（`_ggAutoFitManualSize`）仍只增不减，这条保护在 `fitNode` 内部。
- **「标签左 + 数值右」的控件要给自动贴合报宽度下限**。`gg-node-autofit.js` 只按标签估宽（`measureText(label) + 68`），数值会切成省略号。节点把「标签 + 数值 + 90」量出来写进 `node._ggAutoFitMinWidth` 即可（`compactNodeWidth` 会取它当宽的下限），不要再各自 patch `computeSize`。
- **列宽口径 60、节点宽度口径 90，别混**。`web/gg-widget-rows.js` 的 `requiredWidth()` 量的是「列矩形扣掉两侧内衬后的宽度」：官方 `drawTruncatingText` 的 `可用文字宽 = width - 85` 里 `width` 是 `column.w = need + 30`，所以 `need >= 标签 + 数值 + 60`。`web/gg-image-comparer.js` 给 autofit 报 `_ggAutoFitMinWidth` 量的是**节点宽**（原生控件直接收 `node.size[0]`），那边仍是 `+90`。验证脚本 `verify_all_rows.cjs` / `verify_dynamic_rows.cjs` / `verify_ar_rows.cjs` 的 `TEXT_CHROME` 必须与引擎一致（60），且 label 要 `trim()`、取值要读 `_displayValue`，否则会误报或漏报截断。
- **数值控件按 `_displayValue` 量宽**。`NumberWidget._displayValue = toFixed(options.precision)`，`1 / precision=1` 显示成 `1.0`、`0.9 / precision=2` 显示成 `0.90`，比 `String(widget.value)` 长 8~11px。按 `value` 量会把标签挤成 `…`（`GGZImageSampler` 的「引导」「降噪」实测，2 倍截图确认）。`ComboWidget` 的 `getOptionLabel` 也走同一 getter。引擎的 `displayValue()`、四个验证脚本、`gg-image-comparer.js` 一律用 `widget._displayValue ?? widget.value`。
- **`state.minWidth` 是默认宽度，不是硬下限**。它只给新建 / 读档定宽；用户拖过节点边之后（`_ggAutoFitManualSize`，autofit 排除的节点由行布局在实例 `onResize` 上补记 `_ggRowLayoutManualWidth`）`effectiveMinWidth()` 撤掉下限，`computeSize` / `applyHeight` / `shrinkToWidth` 都不许再把宽度撑回去。`autoWrap` 分行只能用紧凑宽度 `wrapWidth`：用 `max(紧凑宽, node.size[0])` 会把控件塞进更少更宽的行，`contentWidth` 再反过来撑宽节点，形成放大回路（`GG 视频压缩` 实测 543→621）。`PREFERRED_MAX_WIDTH = 420` 是「宁可多一行也别横着拖出去」的阈值。排查默认宽度与拖窄回弹用 `tools/probe_widths.cjs`。

- **节点尺寸归属总规矩（2026-11-04 夜，一次立规矩不再逐节点打补丁）**：官方 resize 的 onDrag 拿 node.computeSize() 当硬下限（`l.height < u[1]` 就把拉力钳回去），所以 computeSize / applyHeight / fitNode 里任何 `max(内容, 手动标记)` 都会把上次拖大的值变成新下限，onResize 记到的永远是引擎改写后的值——节点只能拉大（这个问题在对比2张/对比N张/压缩保存上反复复发就是它）。规矩：**拖拽中（`canvas.resizing_node === node`）引擎全线停手**——行布局 applyHeight 直接 return、computeSize 拖拽分支只报**常数下限**（`[MIN_NODE_WIDTH, min(当前, 内容高)]`——帧级追踪实锤：带 effectiveMinWidth 或 this.size 都会变成棘轮，上一次的值就是这次的下限，LoRA 拖窄全程被钳回 460；官方 onDrag 拿 computeSize 当硬下限，任何随状态变化的值都危险）、autofit fitNode 直接 return、对比2张报 `[520,420]`；松手后 onResize 记录的才是用户真实拉力，applyHeight 的 max 语义从「焊死」变「收敛」。autofit 里用户手动拖过的节点宽度完全尊重 `_ggAutoFitManualSize`（允许比内容窄），只有含 DOM 面板的节点保最小可用宽。**用户尺寸必须随 properties 持久化**（`_ggRowUserSize` / `_ggAutoFitUserSize`，onResize 时写入、onConfigure / loadedGraphNode 优先认领），restoreRowLayoutUserHeight 只给老存档兜底——它捕获 storedHeight 时官方已把 size 压回内容高，会在认领之后把用户尺寸覆盖回去。新增 / 改尺寸相关代码必须跑 `tools/verify_resize_ownership.cjs`（7 节点 × 拖大/拖小/拖窄/值变化/loadGraphData 读档五步，36/36），诊断用 `tools/probe_resize.cjs --json`。
- **`flow` 流式节点与用户高度保护**：`GGImageCompressSave` 走 `flow: true` / `flowRows()` 逐格贪心分行，默认宽度只按第一个控件算（`minWidth: "flow"`）；`flowColumnStep` 是「比默认宽多拉多少才允许多一列」的步长，`maxColumns = 1 + floor((实际宽 - 默认宽)/step)`，分行宽度直接取 `node.size[0]`，不走 `autoWrap` 的 DP。`packedRects(..., allowSurplus=false)` 富余留行尾不补宽；单控件行按内容贴紧，只有 `alone` 控件才占满整行。用户拖出来的高度归 `_ggRowLayoutManualHeight`：实例 `onResize` 只在 `app.canvas.resizing_node === this` 且 `size[1] > state.height + 2` 时写入，`applyHeight()` / `computeSize()` 取 `max(内容高, 手动高)`，`loadedGraphNode` 用 `restoreRowLayoutUserHeight()` 从存档认领，别的尺寸管理模块（如 `gg-image-compress-save.js`）恢复存档尺寸后要补调 `lockRowLayoutHeight()`；**拖回内容高度必须删标记**，否则节点再也收不回去。
- **布尔控件的列宽口径是 46 不是 60**：`BooleanWidget` 不走 `drawTruncatingText`，`drawLabel` 从 x=30 画、`drawValue` 右对齐到 `width-40`，所以 `requiredWidth()` 用 `BOOL_CHROME = 46`（文本 / 下拉 / 数值仍是 `TEXT_CHROME = 60`），标签-数值空白实测 6px 而不是 20px。`verify_all_rows.cjs` / `verify_dynamic_rows.cjs` 的口径要按 `type === "toggle"` 分别取 46 / 60。窄宽时 flow 节点在 `drawWidgets` 绘制期临时设 `LiteGraph.truncateWidgetValuesFirst = true` 保住标签，**必须在 `finally` 还原**：那是 LiteGraph 全局策略，常开会改掉其它节点的截断行为。改这块跑 `tools/verify_compress_save_layout.cjs`（21 项，含真实鼠标拖拽与读档）和 `tools/shot_compress_save.cjs` 截图核对。

- **提示词增强的本地LLM 与本地PE 一样按任务分模型，分界线是「要不要送图」**。`_enhance()` 用 `bool(ref_frames)` 选 `llm_i2i_model / llm_t2i_model`，不要用 `task_mode == MODE_I2I`：自动模式反推返回 `MODE_T2I + reverse=True` 但必须看图，得走 I2I 模型 + mmproj；文生图不送图，走 T2I 模型并强制 `mmproj_name = NO_MMPROJ`，否则加载视觉 chat 模板又慢又不对。默认模型按文件名 t2i / i2i 记号挑且必须排除 mmproj；mmproj 只认与 I2I 模型公共前缀 ≥12 的配套文件，凑不上就保持「无」。
- **`GGPromptEnhancer` 的本地PE 模型只能来自外接 `CLIP` 端口，不得再出现 PE 文件名控件**。现行 `widgets_values` 是 17 位位置数组（16 个声明控件 + 前端自动加的 `control_after_generate`）：0 任务模式、1 输出语言、2 增强方式、3 api_key、4 api_base_url、5 model、6 文生图LLM模型、7 图生图LLM模型、8 mmproj、9 上下文长度、10 最大生成token、11 seed、12 `control_after_generate`、13 卸载策略、14 输入提示词、15 透明背景、16 增强方向。`文生图PE模型` / `图生图PE模型` 是 `optional` 的 `CLIP` 输入（`shape: 7`、无 `widget`），由上游 `CLIPLoader` 供给；老存档的 PE 文件控件值只用于建 Loader，随后删除，不参与新数组。新增控件优先追加末尾；必须插在 `输入提示词` 之前时，要同时 patch `nodeType.prototype.configure`，在原始 configure 之前补值并迁移老数组（16 / 18 / 19 位都要覆盖）。后端保留 `P_LLM_LEGACY` 仅用于旧 API 提交兼容。验证跑 `tools/verify_prompt_enhancer_llm_split.cjs` 和 `tools/verify_prompt_enhancer_llm_api.py`。
- **`GGPromptOptimizer` 拆分后是 8 槽 → 7 槽，改 UI 工作流的 `inputs` 时必须按映射平移 `links` 的目标槽位**：old 0 `图像.图像1` → new 4、old 4 `分辨率` → new 3、old 5 `正向提示词` → new 1、old 6 `负向提示词` → new 2、old 7 `图像.图像2` → new 5；new 0 `clip` 接 `CLIPLoader`、new 6 `vae` 接外部 VAE（通常来自子图 `vae` 输入）。顶层 `links` 是 `[id, src, ss, dst, ds, type]`（`ds` 在下标 4），子图 `definitions.subgraphs[].links` 是 `{id, target_id, target_slot, ...}` 对象数组；改 `inputs` 后必须保证 `inputs[slot].link === link.id` 且双向一致，否则读档丢线。`GGPromptEnhancer` 拆 PE 时相反：两个 PE 输入**保留原槽位只改类型**，seed / 输入提示词 / 透明背景 / 增强方向的连线槽位不移动。子图节点不在顶层 `nodes` 里：静态检查递归 `definitions.subgraphs`，真机检查遍历 `app.graph._subgraphs`（是 Map）。示例 API 工作流不得出现 PE 文件字符串。改完跑 `tests/test_region_workflow.py` 的双向一致断言 + `tools/verify_example_llm_models.cjs` + `tools/sync_example_llm_models.py --check`。

- 不要用全局轮询做高频重绘；用 `requestAnimationFrame`、设置变更回调或轻量事件钩子。
- `MutationObserver` 挂在 `document.body`（尤其 `subtree: true`）时，回调必须防抖 / 节流，且回调里严禁整文档 `querySelectorAll` 或读 `offsetHeight` / `getBoundingClientRect` 等触发强制回流的操作——ComfyUI 前端启动时会疯狂构建 DOM，未节流的重回调会把主线程拖死、工作台白屏卡死（`gg-ui-icons.js` 等多个文件栽过这个模式）。能局部观察就不要观察 `body`，能只处理 `addedNodes` 就不要重扫全文档。
- **`GGFaceSmartBeauty` 的实现与默认值不在本仓库**。它在 `ComfyUI-GuliNodes-Dependencies/guli_nodes_dependency/image_tools.py`（`object_info.python_module = custom_nodes.ComfyUI-GuliNodes-Dependencies`），本仓库只有工作流、前端布局和调参脚本。改 `INPUT_TYPES.default` / `beautify()` fallback / `_smooth_skin` / `_whiten_skin` 要改那边。调试期用 `tools/tune_face_offline.py`（复用 `tools/out/face_tune/raw_mask/mask.png` 走外部遮罩分支，直接 import 模块，**不重启 ComfyUI 就能重跑**）+ `tools/tune_face_algo_sweep.py` / `tools/tune_face_white_sweep.py` 扫常数；定稿后**必须重启 ComfyUI**（Python 模块没有热重载），跑 `python_embeded/python.exe tools/tune_face_beauty.py --mode verify` 验证「零参数执行输出 == `final_sam3` 标定组」，`--mode workflow` 按示例工作流双分支真机跑，`--mode compare` 出三方对比图。改默认值时 `example_workflows/GG智能人脸美化_SAM3测试.json` 的 `widgets_values` 与 `LoadImage` 文件名要一起同步，顺序不能变（新增项只能追加末尾）。依赖插件被 ComfyUI-Manager 更新会覆盖这些改动，更新后重跑 verify。
- **人脸美化算法的三条硬约束**（第一轮只调强度系数翻过车，别退回去）：① 磨皮尺度必须跟着脸宽走，`L - GaussianBlur(L, σ=脸宽×0.012)` 做高频分离，按幅值 + 梯度保护决定保留比例；固定 d≈31 的双边 + 高斯会把 225px 小脸的眼线睫毛一起糊平。② 五官保护不要依赖 `context["mesh_results"]` 一定存在（浓妆/白发/小脸实测 MediaPipe 返回 0 个），也不要用按轮廓外接框比例画的椭圆遮罩（实测盖住脸内 60% 且位置偏）；结构保持交给图像本身的高频幅值 + 梯度。③ 提亮权重只能由遮罩 + **低频**亮度保护（σ≈10）决定，逐像素高光/暗部阈值会在鼻线、眼窝画深色描边；用加法抬 L 而不是 gamma（gamma 压对比度、皮肤发灰白），并补少量 HSV 饱和度。验收看 `tools/out/face_tune/final_metrics.json`：强结构保持率 ≥0.97、四分区亮度差 ≤2.0、过曝 0。
- **用户自定义数据一律存用户区，禁止存进插件目录或裸 localStorage**。插件目录会被升级整目录覆盖（删文件夹重装、ComfyUI-Manager 更新都是这个形态），localStorage 会随清浏览器缓存 / 换浏览器丢失。前端持久化一律走 `web/gg-userdata-store.js` 的 `getUserItem / setUserItem / removeUserItem`（原始字符串语义）或 `loadUserState / saveUserState`（结构化对象语义）——它们把数据落到 ComfyUI settings（`user/default/comfy.settings.json`），localStorage 仅作过渡兜底并在读取时自动回填。`GG 密钥输入`、`GG 工具栏`、`GG 标题`、`GG 剪贴板`、`GG 编组样式` 已接入；新扩展要存任何用户状态，先走这个桥，不要直接碰 `localStorage`。
- **任何数据落盘先自问「插件目录被整目录覆盖后会不会丢」**：会丢的设计直接否。Python 侧写文件只能写 `folder_paths.get_user_directory()` 之下、ComfyUI 的 output / temp 目录，或系统临时目录；禁止在插件目录内创建运行时状态文件（缓存、索引、用户配置都不行——插件目录里只放随仓库分发的静态资产）。用户数据盘点与备份用 `tools/userdata.py info / backup`。

## 六、依赖策略

主插件维持**零额外 Python 依赖**：

- 可用 ComfyUI 环境通常已有的 `torch`、`PIL`、`numpy`。
- 视频能力可调用外部 `ffmpeg` / `ffprobe`。
- GGUF 等节点是桥接节点：检测可选插件是否存在，给出清晰错误信息，不要复制其核心实现。
- 不要重新引入 README 已明确移除的依赖路线：`cv2`、`mediapipe`、`color-matcher`、`kornia`——除非用户明确要求并同步文档。
- 例外（已按用户明确要求引入并同步文档）：`llama-cpp-python` 仅用于 `GG 提示词增强qwen2.1` 的「本地LLM」增强方式，为**可选、按需在函数内导入**的依赖；缺失时该方式给出中文错误，API / 本地PE 方式与其余节点不受影响。requirements.txt 里仅注释说明、不作强制安装项。

## 七、借鉴与致谢

参考了任何插件、论文、算法、UI 实现路线或社区工作流，都要更新 `README.md` 的「致谢与借鉴说明」，写明**来源名称 + 项目地址（URL）+ 实际参考的节点或功能**。只写名称、漏 URL 或漏引用关系都算致谢不完整。

引用类型要写准，不要混：

| 类型 | 含义 |
| --- | --- |
| 桥接 | 运行时调用外部插件，不内置核心实现 |
| 适配 | 基于已有实现改造到 GuliNodes |
| 思路参考 | 交互或功能形态受启发，源码为本项目重写 |
| 算法思路 | 实现了公开算法或常见处理方法 |

不要把「思路参考」写成「复制来源」，也不要漏掉实际适配或桥接关系。

**强制**：借鉴或参考任何外部项目都必须在致谢表补一行（来源名称 + URL + 实际参考的节点或功能），无一例外。删除节点或功能时，**对应致谢行不删除文本**，只用删除线（`~~……~~`）标注失效，保留来源记录。

## 八、文档与版本

改动节点或前端能力时同步：

- `README.md`：主要能力、节点清单、依赖与兼容、致谢与借鉴说明、更新记录。
- `pyproject.toml`：`tool.gulinodes.node_count`。
- 后端注册节点数当前为 **53**（另有 1 个由前端生成：`GG 选项确认`，所以清单是 54 行）。新增前端扩展不计入；只有新增 Python 后端节点才需要改这个数字。
- 数节点**不能按显示名数**：本机 `custom_nodes` 下还有配套包 `ComfyUI-GuliNodes-Dependencies`，它的显示名同样以 `GG` 开头（`GG 人脸磨皮`、`GG 智能人脸美化`、`GG 色彩匹配`、`GG 提示词优化`、`GG 图像反推`、`GG 反推模型`、`GG 图像风格参考`），按名字做差集会把这 7 个算进本仓库。可靠做法：`import guli_nodes` 后读 `NODE_DISPLAY_NAME_MAPPINGS`，或 `/object_info` 里按 `python_module.startswith('guli_nodes.')` 过滤。

**所有改动一律写进 `README.md`「更新记录」顶部的 `### 未发布` 小节**（没有就新建），不另开小节，也不自己编版本号——写 `v1.1.3`、`v1.2.0` 这类未授权版本号、或顺手改 `pyproject.toml` 的 `version` 都算越权。

「未发布」是**当前状态的快照，不是流水账**，每次改动落地时顺手更正：

- 同一节点、同一主题的多条合并成一条；被后续改动推翻的描述直接改写或删掉，不留「先改成 A、后又改回 B」的过程。
- 只写用户能感知的结果（行为、参数、错误信息、兼容性），不写实现过程与调试细节；仓库内部规则、`AGENTS.md` 调整这类用户看不到的改动不进更新记录。
- 写完回头读一遍，确认每条与当前代码一致、彼此不重复。

**发版**（只在用户明确要求升级版本时）**先做发布前自检**：通读「未发布」去重合并、按主题重排、逐条核对与代码一致，并检查节点清单 / 依赖 / 致谢 / 常见问题等联动章节是否同步；确认无误后再把 `### 未发布` 改名为该版本号，并同步 `pyproject.toml` 的 `version`。已发布的小节冻结，不再追加。

**推送即发布**：`git push` 后版本即对外生效，归档必须在同一次提交里完成——`README.md` 的「更新记录」只保留最新版本一节（精简版），详细原文（参数、迁移、兼容说明）写进 `CHANGELOG.md` 顶部同名版本下；推送后再把记录标回「未发布」，或只改 README 不改 CHANGELOG，都算发布流程缺失。

## 九、验证

按改动范围选择：

- Python 语法：`python -m py_compile guli_nodes/<file>.py`
- JS 语法：`node --check web/<file>.js`
- 注册映射：导入插件入口，确认 `NODE_CLASS_MAPPINGS` 数量与显示名。
- **双路节点要两条分支都测**：本仓库节点是 `if io is not None:` 的 V3 定义 + `else:` 的 legacy `INPUT_TYPES` 定义，只测 V3 会漏掉回退路径。强制走 legacy 的办法是在 `import` 之前 `sys.modules["comfy_api.latest"] = None`（`from comfy_api.latest import io` 会抛错并被文件顶部的 `except` 接住，`io` 变成 `None`）；用 `hasattr(cls, "define_schema")` 判断当前走的是哪条分支。
- 本机用 ComfyUI 自带解释器：`W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe`，并把 `<ComfyUI 根>` 与 `<插件根>` 都加进 `sys.path`。
- 前端绘制 / 叠加类改动：用无头 Node 测试台（stub `LGraphCanvas` / `app` 后 `import()` 真实扩展文件、驱动 `canvas.drawNode`）确认五件事——真的画出来了、一次调用只画一次、配色在当前画布背景上读得出来、效果确实从节点边界向外扩散、扩散是随机的而不是固定排布。跑 setups 后必须 flush 定时器队列，否则延迟安装的实例补丁还没生效，会测出假 PASS。
- 无头测试台本身有两个容易造出**假 FAIL** 的坑：stub 的 2D context 必须跟踪 `translate()`（花瓣是 `translate(x,y)` 后的 `ellipse(0,0)`，不跟踪就一律记成原点）；仿真时长必须长于最长粒子生命周期（否则长寿命粒子还在半路，测出的扩散距离偏小）。另外"逐帧画面不同"只能证明在动、**证明不了随机**——要额外断言同节点同效果的两次全新会话排布不同。现测试台还断言各效果的形态可辨识：花瓣为贝塞尔轮廓（非椭圆）、音符为刻制谱号字形（无 `fillText`、多形态）、爱心存在被箭射中形态、流星方位随机覆盖多数罗盘扇区、浅色主题 ink 占比不过淡。
- **无头测试台的桩必须复现真实 DOM 的完整 API**，少一个方法就测出「假 FAIL」，而且是崩在桩的缺口上、看起来像产品的 bug。`document.createElement` 返回的对象至少要具备 `style` / `dataset` / `classList`（`add` / `remove` / `contains` / `toggle`）/ `setAttribute` / `getAttribute` / `hasAttribute` / `removeAttribute` / `appendChild` / `addEventListener` / `dispatch`：设计层只要调一次 `applySurface`，缺 `hasAttribute` 就会整个面板崩掉。同理，桩里只造最小 `node.inputs` 会让「镜像条目」这类 bug 完全测不出来。造桩前先问「真实前端还多塞了什么」。
- **断言必须做反向验证**：故意把关键规则改坏（例如让 `applySurface` 在 auto 模式重新钉属性、让色板退回空串），确认对应断言真的 FAIL，再改回来。一次全绿不可信，报 0 条 FAIL 往往说明断言在空跑。
- **改节点尺寸逻辑必须跑尺寸专项验证**：`tools/probe_size_shrink.cjs` 全仓扫「拉高 → 触发重排（执行 / 切参数 / 读档）→ 是否回缩」，单节点断言写成 `tools/verify_<节点>_height.cjs`（参考 `verify_text_concat_height.cjs` / `verify_video_save_height.cjs`）。必须同时断言两条：① 手动高度与存档高度在重排、读档后都不掉；② 用户自己往下拖仍然能变小（`canvas.resizing_node === node`），避免为了「不回缩」把节点焊死。
- **界面类改动要跑两个真实环境工具**：`probe-surfaces.mjs [dark|light]` 盘点页面上所有 `gg-*` 界面的底色 / 文字色 / 亮度 / 对比度（深色主题里任何 `lum > 0.5` 的块会被标成「深色主题里的浅底」），`run-surfaces-live.mjs` 做深浅两套断言（开关四态、菜单、底部工具栏 / 折叠设置弹层 / 密钥面板 / 悬浮工具条 / 剪贴板右键菜单）。改完先盘点、再断言，最后 `shot-surfaces.mjs` 拍图肉眼复核——**「亮着像开着」「深色里一块白」「色板显示纯黑」这三类问题只有眼睛能发现**。
- **截图类脚本要显式收拾造景**：`pointerdown` 才收起的弹层在脚本里不会自己关（`el.click()` 只派发 click），`opacity: 0` 的悬浮条要 `dispatchEvent(new MouseEvent("mouseenter"))` 才会浮出来。不收拾就会拍出「同一个按钮两种样子」的假象，或者拍到一块空背景。
- **别依赖宿主或上一次测试留下的状态**：`GuliNodes.enableFloatButtons` 这类开关存在服务端设置里，被关过一次之后，后面每次跑都报「悬浮工具条不存在」——看着像回归，其实是造景没保证。测试台开局把需要的开关显式设成期望值，需要的节点自己 `createNode` 造（别指望「默认工作流里正好有个 CLIPTextEncode」）。同理，`el.dispatchEvent(new MouseEvent("mouseenter"))` 触发不了 CSS `:hover`，要验悬停样式必须用真实鼠标移动（`page.mouse.move`）。
- ComfyUI 实测：重启后确认右键菜单、节点参数、前端设置、画布交互正常。

## 十、工作方式

- **错误三次即立档（持续执行）**：同一个错误 / 踩坑累计出现第 3 次，当轮必须写入仓库根目录的 `问题与解决方法.md`
  （现象 / 根因 / 解决 / 验证 / 出现记录 五段），后续每再踩一次就在该条目「出现记录」末尾追加日期与出处；
  处理任务前先查该文档。已收录：节点尺寸弹回、Python 无热重载、Playwright 缺 NODE_PATH、CRLF Edit 匹配失败、
  前端测试假 PASS/假 FAIL。未满 3 次的在该文档末尾「未达 3 次」表持续计数，满 3 当轮转正。
- 先读相关文件，再改代码。
- 保持改动聚焦，不做无关格式化。
- 不要删除用户已有改动。
- 改完按「九、验证」跑一遍再交付。
