# 节点控件皮肤范围 Implementation Plan

> **For agentic workers:** Use executing-plans to implement each acceptance slice with red/green verification. Preserve the running checkout's existing uncommitted changes.

**Goal:** 落实三档皮肤范围，区分首次安装默认值与本机开发配置。

**Architecture:** 独立 scope 模块管理设置、节点归属与变更订阅；行布局绘制、独立控件绘制与宿主设置行 CSS 共用该状态。顶部工具菜单与 ComfyUI 设置写同一个用户区偏好。

**Tech Stack:** ES modules、ComfyUI Settings API、LiteGraph Canvas、Node.js、Playwright。

## Global Constraints

- 用户可见文案中文，设置 id 为 `GuliNodes.widgetSkin.scope`。
- 三个固定值 `all / own / off`；分发默认 `own`。
- 本机开发写用户区 `all`，用户明确选择优先。
- 不修改后端节点数、版本、端口、参数序列化或已有行布局几何。
- 在指定正在运行的 checkout 上应用微补丁；备份已存系统临时目录。

### Task 1: 范围状态与可逆绘制

**Files:** 新增 `web/gg-skin-scope.js`；修改 `web/gg-widget-rows.js`；测试 `tools/test_skin_scope.mjs`。

**Interfaces:** `getWidgetSkinScope(): string`、`isWidgetSkinEnabled(node): boolean`、`onWidgetSkinScopeChange(listener): function`；`paintCapsuleBase` 末尾增加可选所属节点参数。

- [x] 运行先写好的验收测试，确认默认全局行为被检测为失败：
  ```powershell
  node tools/test_skin_scope.mjs
  ```
- [x] 注册同源设置，默认 own；节点定义缓存归属；状态切换通知消费者并请求重绘。
- [x] 所有标准绘制入口先检查范围，关闭时调用保存的原函数；范围扩展时扫描已有图与子图。
- [x] 自绘底格关闭时读 LiteGraph 基础色，不画投影或高光；运行相同测试至全绿。

### Task 2: 三按钮入口与范围化设置样式

**Files:** 新增 `web/gg-widget-skin-settings.js`；修改 `web/gg-toolbar.js`、`web/gg-ui-icons.js` 与 LoRA 两个前端文件。

**Interfaces:** 顶部按钮宿主 `gg-widget-skin-buttons`；详情面板 `gg-widget-skin-settings-panel`；按钮写入用户数据存储桥，同步 scope。

- [x] 用三个互斥按钮显示已确认的中文模式，在工具菜单托管详情面板。
- [x] 所有旧宿主设置行选择器加范围保护，移除写内联边框的全局观察器。
- [x] LoRA 自绘传所属节点，关闭后仍保留拖拽、组切换和强度编辑。
- [x] 真机确认新装 own、已有 off、all 对第三方的即时适配与回退；深浅两套截图。

### Task 3: 回归、开发配置与文档

**Files:** `tools/verify_skin_scope.cjs`、`tools/verify_widget_skin.cjs`、`README.md`。

- [x] 真机脚本隔离 / 恢复用户设置，旧全覆盖测试显式选择 all。
- [x] 本机首次开发配置使用 Settings API 写 all；以后读取已有用户选择。
- [x] 按串行口径运行全部 `tools/verify_*.cjs`，无头测试并行运行。
- [x] 运行 probe-surfaces、run-surfaces-live、shot-surfaces 后目视核对。
- [x] README 常用开关表与「未发布」记录同步为当前三档结果；复查已有改动保留。
