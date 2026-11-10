// LoRA 单行布局的往返验证：新增行 / 空槽压缩 / 序列化顺序 / 老工作流兼容 / 勾选开关。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_lora_roundtrip.cjs
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NODE_CLASS = 'GGLoRACustomLoader';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const report = await page.evaluate(async (nodeClass) => {
    const app = window.app;
    const LGraphNode = window.LiteGraph.LGraphNode;
    const out = {};
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    app.graph.clear();
    const node = window.LiteGraph.createNode(nodeClass);
    app.graph.add(node);
    await new Promise((r) => setTimeout(r, 300));
    await tick();

    const get = (name) => node.widgets.find((w) => w.name === name);
    const visibleRows = () => new Set(
      node.widgets.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden')).map((w) => w.y),
    ).size;

    out.initialRows = visibleRows();
    out.initialCount = get('LoRA数量').value;

    // 1) 点「新增LoRA」加一行
    const add = get('新增LoRA');
    add.callback?.(add.value, app.canvas, node);
    await new Promise((r) => setTimeout(r, 200));
    await tick();
    out.afterAdd = { count: get('LoRA数量').value, rows: visibleRows() };

    // 2) 勾掉第 1 行启用，看值是否落盘
    const enable1 = get('LoRA1启用');
    enable1.value = false;
    enable1.callback?.(false, app.canvas, node);
    await new Promise((r) => setTimeout(r, 100));

    // 3) 序列化：widgets_values 顺序必须是 数量 → 名称/强度×20 → 启用×20
    const serialized = node.serialize();
    const values = serialized.widgets_values ?? [];
    out.serialize = {
      length: values.length,
      head: values.slice(0, 5),
      enableStart: values.slice(41, 44),
      enable1: values[41],
    };

    // 4) 老工作流的 widgets_values（41 个，没有启用开关）要能继续落到名称/强度上
    const legacy = [1, 'None', 0.8];
    while (legacy.length < 41) legacy.push('None', 1.0);
    const fresh = window.LiteGraph.createNode(nodeClass);
    app.graph.add(fresh);
    fresh.configure({ widgets_values: legacy.slice(0, 41) });
    await new Promise((r) => setTimeout(r, 300));
    await tick();
    const legacyGet = (name) => fresh.widgets.find((w) => w.name === name);
    out.legacy = {
      count: legacyGet('LoRA数量').value,
      name1: legacyGet('LoRA1名称').value,
      strength1: legacyGet('LoRA1强度').value,
      enable1: legacyGet('LoRA1启用')?.value,
      rows: new Set(fresh.widgets.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden')).map((w) => w.y)).size,
      height: fresh.size[1],
    };

    // 5) 名称改回 None 时压缩空槽
    legacyGet('LoRA1名称').value = 'None';
    legacyGet('LoRA1名称').callback?.('None', app.canvas, fresh);
    await new Promise((r) => setTimeout(r, 300));
    await tick();
    out.compact = { count: legacyGet('LoRA数量').value, height: fresh.size[1] };

    // 6) h 键：确认行布局没有把节点撑出画布
    out.computeSize = fresh.computeSize();
    return out;
  }, NODE_CLASS);

  console.log(JSON.stringify({ report, errors: errors.slice(0, 5) }, null, 2));
  await browser.close();
})();
