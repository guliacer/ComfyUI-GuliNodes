// 「GG 网页AI图像反推」默认高度 500 的实机回归。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_web_ai_default_height.cjs
//
// 默认值的唯一来源是后端 INPUT_TYPES 里「节点高度」的 default（改 Python 后
// 必须重启 ComfyUI）。前端 gg-web-ai-reverse.js 的 DEFAULT_PANEL_HEIGHT 只是
// widget 缺失/非法时的兜底，两者必须同源。节点整体 size[1] 会比面板高多出
// 标题栏 + 参数控件约 86px，所以断言看面板高度而不是 node.size[1] 等于 500。
// 2026-11-06 起节点底部多一条 28px 提示条（host = 节点高度 + 28，iframe 不变），
// 本脚本同时验证提示条的文案 / 位置 / 样式与「不挤压 iframe」。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NODE_CLASS = 'GGWebAIReverseImage';
const WIDGET_NAME = '节点高度';
const EXPECTED_DEFAULT = 500;
const URL_BAR_HEIGHT = 28;
const HINT_BAR_HEIGHT = 28;
const HINT_TEXT = '空白太多？调整上方的节点高度。';

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

// 本机 ComfyUI 装了外部扩展，其中 gulips.bridge 的 setup 会抛
// `ReferenceError: io is not defined` 并被 ComfyUI 用 console.error 兜住。
// 它与本模块无关，属于启动环境噪音；但**不能把所有 console error 一律忽略**，
// 否则「无脚本异常」这条断言会空跑（问题文档第 5 条：假 PASS）。
// 口径：未捕获的 pageerror 一律算异常；console error 里凡是提到本模块的算异常，
// 其余归入 externalNoise 单独记录，并在下面反向验证过滤器本身没写宽。
const OWN_MODULE = /gg-web-ai-reverse|web_ai_tools|GGWebAIReverseImage|网页AI图像反推/i;
const isOwnModuleError = (text) => OWN_MODULE.test(String(text));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const missing = [];
  const externalNoise = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/.test(text)) return; // 404 由 response 钩子单独归类
    if (!isOwnModuleError(text)) { externalNoise.push('console: ' + text); return; }
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async ({ NODE_CLASS, WIDGET_NAME, URL_BAR_HEIGHT }) => {
    const app = window.app;
    const saved = app.graph.serialize();
    const info = await (await fetch('/object_info/' + NODE_CLASS)).json();
    const spec = info?.[NODE_CLASS]?.input?.optional?.[WIDGET_NAME];
    const backendDefault = spec?.[1]?.default;

    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const node = window.LiteGraph.createNode(NODE_CLASS);
    app.graph.add(node);
    node.pos = [60, 60];
    await new Promise((r) => setTimeout(r, 900));

    const heightWidget = node.widgets?.find((w) => w.name === WIDGET_NAME);
    const panel = node.ggWebAIReversePanel;
    const dump = () => {
      const hint = panel?.hintBar;
      const cs = hint ? window.getComputedStyle(hint) : null;
      return {
        size: node.size ? [...node.size] : null,
        widgetValue: heightWidget?.value,
        hostHeight: panel?.host?.style?.height ?? null,
        iframeHeight: panel?.iframe?.style?.height ?? null,
        hint: hint ? {
          text: hint.textContent,
          height: hint.style.height,
          color: cs?.color,
          fontSize: cs?.fontSize,
          justifyContent: cs?.justifyContent,
          background: cs?.backgroundColor,
          borderTopWidth: cs?.borderTopWidth,
          pointerEvents: cs?.pointerEvents,
          isLast: panel.host.lastElementChild === hint,
          index: Array.prototype.indexOf.call(panel.host.children, hint),
          bottomGap: panel.host.getBoundingClientRect().bottom
            - hint.getBoundingClientRect().bottom,
        } : null,
      };
    };
    const initial = dump();

    // 用户手动调高仍生效，面板与节点尺寸跟着走
    if (heightWidget) { heightWidget.value = 820; heightWidget.callback?.(820); }
    await new Promise((r) => setTimeout(r, 450));
    const changed = dump();

    // 读档后用户设的值不能被新默认值覆盖
    const data = app.graph.serialize();
    app.graph.clear();
    app.loadGraphData(data);
    await new Promise((r) => setTimeout(r, 900));
    const reloaded = (app.graph._nodes ?? []).find((n) => n?.comfyClass === NODE_CLASS);
    const reloadInfo = reloaded ? {
      size: [...reloaded.size],
      widgetValue: reloaded.widgets?.find((w) => w.name === WIDGET_NAME)?.value,
      hintText: reloaded.ggWebAIReversePanel?.hintBar?.textContent ?? null,
      hintIsLast: reloaded.ggWebAIReversePanel?.host?.lastElementChild
        === reloaded.ggWebAIReversePanel?.hintBar,
    } : null;

    // 截图留在 Node 侧做，恢复用户画布放到截图之后。
    window.__ggSavedGraph = saved;
    return { backendDefault, specMin: spec?.[1]?.min, specMax: spec?.[1]?.max,
      specStep: spec?.[1]?.step, initial, changed, reloadInfo, URL_BAR_HEIGHT };
  }, { NODE_CLASS, WIDGET_NAME, URL_BAR_HEIGHT });

  check('后端 /object_info 的「节点高度」默认值为 500',
    Number(result.backendDefault) === EXPECTED_DEFAULT, result.backendDefault);
  check('参数范围仍是 360~1500、步进 20（500 是合法值）',
    result.specMin === 360 && result.specMax === 1500 && result.specStep === 20
      && EXPECTED_DEFAULT >= result.specMin && EXPECTED_DEFAULT <= result.specMax,
    { min: result.specMin, max: result.specMax, step: result.specStep });

  check('新建节点的「节点高度」控件值就是 500',
    Number(result.initial.widgetValue) === EXPECTED_DEFAULT, result.initial.widgetValue);
  check('内嵌 DOM 面板高度 = 节点高度 500 + 底部提示条 28 = 528px',
    result.initial.hostHeight === `${EXPECTED_DEFAULT + HINT_BAR_HEIGHT}px`,
    result.initial.hostHeight);
  check('iframe 高度不受提示条挤压，仍是 500 - 地址栏 28 = 472px',
    result.initial.iframeHeight === `${EXPECTED_DEFAULT - URL_BAR_HEIGHT}px`,
    result.initial.iframeHeight);
  check('节点整体高度含标题栏/控件/提示条，落在 500~650',
    result.initial.size?.[1] >= EXPECTED_DEFAULT && result.initial.size?.[1] <= 650,
    result.initial.size);
  check('默认宽度仍是 520（本次只改高度）',
    result.initial.size?.[0] === 520, result.initial.size);

  // ---------------- 底部提示条 ----------------
  const hint = result.initial.hint;
  check('节点底部存在提示条，文案为「空白太多？调整上方的节点高度。」',
    hint?.text === HINT_TEXT, hint?.text);
  check('提示条是面板最后一个子元素，贴在面板最底边',
    hint?.isLast === true && hint?.index === 2 && Math.abs(hint?.bottomGap) <= 1,
    { isLast: hint?.isLast, index: hint?.index, bottomGap: hint?.bottomGap });
  check('提示条做成浅色通栏 + 居中灰字小字（仿参考图）',
    hint?.height === `${HINT_BAR_HEIGHT}px`
      && hint?.justifyContent === 'center'
      && hint?.fontSize === '11px'
      && hint?.color === 'rgb(148, 163, 184)'
      && hint?.background === 'rgb(255, 255, 255)'
      && hint?.borderTopWidth === '1px',
    hint);
  check('提示条不抢交互（pointerEvents:none）',
    hint?.pointerEvents === 'none', hint?.pointerEvents);
  check('手动调高后提示条仍在最底部',
    result.changed.hint?.isLast === true && Math.abs(result.changed.hint?.bottomGap) <= 1,
    { isLast: result.changed.hint?.isLast, bottomGap: result.changed.hint?.bottomGap });

  check('手动改成 820 后面板与节点尺寸跟随',
    result.changed.hostHeight === `${820 + HINT_BAR_HEIGHT}px`
      && result.changed.iframeHeight === '792px'
      && result.changed.size?.[1] > result.initial.size?.[1],
    result.changed);
  check('serialize -> loadGraphData 后仍保持用户设的 820',
    Number(result.reloadInfo?.widgetValue) === 820 && result.reloadInfo?.size?.[1] > 820,
    result.reloadInfo);
  check('读档后提示条也会重建且仍贴在底部',
    result.reloadInfo?.hintText === HINT_TEXT && result.reloadInfo?.hintIsLast === true,
    { text: result.reloadInfo?.hintText, isLast: result.reloadInfo?.hintIsLast });

  check('全程无页面脚本异常（外部扩展启动噪音单独归类）', errors.length === 0,
    errors.slice(0, 6));
  // 反向验证过滤器：本模块自身的错误必须仍被计入，外部扩展噪音必须能放行，
  // 否则「无脚本异常」有空跑风险（问题文档第 5 条）。
  check('异常过滤器有效，不会把本模块错误当噪音吞掉',
    isOwnModuleError('Uncaught TypeError in gg-web-ai-reverse.js')
      && !isOwnModuleError("Error calling extension 'gulips.bridge' method 'setup': ReferenceError: io is not defined")
      && !externalNoise.some((s) => isOwnModuleError(s)),
    { externalNoise: externalNoise.length, sample: externalNoise.slice(0, 2) });
  const ourMissing = missing.filter((u) => /gg-web-ai-reverse|web_ai_tools/.test(u));
  check('404 只来自本机缺预览资源，前端模块无缺失', ourMissing.length === 0,
    { total: missing.length, ourMissing });

  const pass = checks.filter((c) => c.ok).length;
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${pass}/${checks.length} passed`);
  console.log('外部扩展噪音（已排除）: ' + JSON.stringify(externalNoise.slice(0, 3)));
  console.log(JSON.stringify(result, null, 2));

  // 留一张默认高度下的真机截图，用于目视核对底部提示条的位置与样式。
  await page.evaluate(async () => {
    const node = (window.app.graph._nodes ?? [])
      .find((n) => n?.comfyClass === 'GGWebAIReverseImage');
    const widget = node?.widgets?.find((w) => w.name === '节点高度');
    if (widget) { widget.value = 500; widget.callback?.(500); }
    await new Promise((r) => setTimeout(r, 500));
    window.app.canvas.draw(true, true);
  });
  await page.screenshot({
    path: 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out/web_ai_bottom_hint.png',
  });
  await page.evaluate(() => window.app.loadGraphData(window.__ggSavedGraph));
  await browser.close();
  if (pass !== checks.length) process.exitCode = 1;
})();
