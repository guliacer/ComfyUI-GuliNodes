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

- 尺寸与潜空间：`aspect_ratio.py`｜图像：`image_tools.py`｜视频：`video_tools.py`｜VAE 缓存与显存清理：`model_loaders.py`
- 文本与输入：`text_tools.py`、`clipboard.py`、`prompt_optimizer.py`、`key_tools.py`
- 模型与采样：`lora_tools.py`、`zimage_sampler.py`、`seed_tools.py`
- 其它：`numeric_tools.py`、`title_node.py`、`web_ai_tools.py`、`taprelay.py`

新增后端节点：

- 在对应模块定义节点类，更新该模块的 `NODE_CLASS_MAPPINGS` 与 `NODE_DISPLAY_NAME_MAPPINGS`。
- 新建模块必须加进 `guli_nodes/__init__.py` 的 `_NODE_MODULES`，否则不会被加载。
- 节点 ID 稳定且唯一（改动会断旧工作流），显示名用中文，分类统一 `GuliNodes/...`。

新增前端扩展：放在 `web/`，`app.registerExtension({ name: "ComfyUI.GGNodes.<功能>" })`，设置项统一用 `GuliNodes.*` 前缀。前端文件清单直接看 `web/` 目录。

## 二、动手前：新功能设计自检（强制）

**适用范围**：新增节点、新增前端扩展、给已有节点加参数/选项/输出、重写已有能力。
**先过一遍下面 6 项并把结论说出来，再动代码。** 最常见的返工不是写错，而是「做出来了但本来不该做」或「做重了」。

1. **必要性**——已有节点换个用法能不能覆盖？是用户明确要求，还是「顺手加的」（顺手加的不做）？ComfyUI 原生或社区插件已经有这个能力吗？有就优先做桥接（见「六」「七」）。只有极少数场景用得上的参数，考虑不落地。
2. **闭环**——后端 `execute`、前端交互、错误信息、文档四处都跟上了吗？空输入 / 未连接 / 0 或负数 / 超范围 / 维度不匹配 / 缺外部依赖都想过吗？错误信息是中文且能说清「哪错了 + 怎么改」吗？新参数进旧工作流会不会回退默认，默认值是否与旧行为一致？
3. **更优方案**——至少想两个再选一个。优先级：ComfyUI 原生机制（`DynamicCombo`、类型匹配）> 复用仓库已有 helper > 新写前端补丁。仓库里已有同类实现就抽共用函数，不要复制第二份。改动会不会影响工作流序列化、端口下标、节点高度这类「用户可感知且不可逆」的东西？有更小的改法吗？
4. **中文参数**——显示名、参数名、选项值、输出名、分类、提示与错误信息一律中文（技术专名除外，见「三」）。
5. **可简化**——参数越少越好：一个选择器能推导出来的不要暴露两个输入；上游能算出来的不要在本节点重复提供；选择器让某些输入失效时按「四」隐藏掉；默认值要能「不填也能用」；近似参数合并。
6. **收尾**——同步 README 与 `pyproject.toml`（见「八」），补齐致谢，递增版本号。

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
- 不要用全局轮询做高频重绘；用 `requestAnimationFrame`、设置变更回调或轻量事件钩子。
- `MutationObserver` 挂在 `document.body`（尤其 `subtree: true`）时，回调必须防抖 / 节流，且回调里严禁整文档 `querySelectorAll` 或读 `offsetHeight` / `getBoundingClientRect` 等触发强制回流的操作——ComfyUI 前端启动时会疯狂构建 DOM，未节流的重回调会把主线程拖死、工作台白屏卡死（`gg-ui-icons.js` 等多个文件栽过这个模式）。能局部观察就不要观察 `body`，能只处理 `addedNodes` 就不要重扫全文档。

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
- `pyproject.toml`：`version`、`tool.gulinodes.node_count`。
- 后端注册节点数当前为 **37**。新增前端扩展不计入；只有新增 Python 后端节点才需要改这个数字。

## 九、验证

按改动范围选择：

- Python 语法：`python -m py_compile guli_nodes/<file>.py`
- JS 语法：`node --check web/<file>.js`
- 注册映射：导入插件入口，确认 `NODE_CLASS_MAPPINGS` 数量与显示名。
- **双路节点要两条分支都测**：本仓库节点是 `if io is not None:` 的 V3 定义 + `else:` 的 legacy `INPUT_TYPES` 定义，只测 V3 会漏掉回退路径。强制走 legacy 的办法是在 `import` 之前 `sys.modules["comfy_api.latest"] = None`（`from comfy_api.latest import io` 会抛错并被文件顶部的 `except` 接住，`io` 变成 `None`）；用 `hasattr(cls, "define_schema")` 判断当前走的是哪条分支。
- 本机用 ComfyUI 自带解释器：`W:\AIphotograph\ComfyUI_windows_portable\python_embeded\python.exe`，并把 `<ComfyUI 根>` 与 `<插件根>` 都加进 `sys.path`。
- 前端绘制 / 叠加类改动：用无头 Node 测试台（stub `LGraphCanvas` / `app` 后 `import()` 真实扩展文件、驱动 `canvas.drawNode`）确认五件事——真的画出来了、一次调用只画一次、配色在当前画布背景上读得出来、效果确实从节点边界向外扩散、扩散是随机的而不是固定排布。跑 setups 后必须 flush 定时器队列，否则延迟安装的实例补丁还没生效，会测出假 PASS。
- 无头测试台本身有两个容易造出**假 FAIL** 的坑：stub 的 2D context 必须跟踪 `translate()`（花瓣是 `translate(x,y)` 后的 `ellipse(0,0)`，不跟踪就一律记成原点）；仿真时长必须长于最长粒子生命周期（否则长寿命粒子还在半路，测出的扩散距离偏小）。另外"逐帧画面不同"只能证明在动、**证明不了随机**——要额外断言同节点同效果的两次全新会话排布不同。现测试台还断言各效果的形态可辨识：花瓣为贝塞尔轮廓（非椭圆）、音符为刻制谱号字形（无 `fillText`、多形态）、爱心存在被箭射中形态、流星方位随机覆盖多数罗盘扇区、浅色主题 ink 占比不过淡。
- ComfyUI 实测：重启后确认右键菜单、节点参数、前端设置、画布交互正常。

## 十、工作方式

- 先读相关文件，再改代码。
- 保持改动聚焦，不做无关格式化。
- 不要删除用户已有改动。
- 改完按「九、验证」跑一遍再交付。
