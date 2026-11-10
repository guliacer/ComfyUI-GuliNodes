// 正式示例工作流回归：GGPromptEnhancer 必须是 19 位双模型新格式，且真机能加载不错位。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_example_llm_models.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const T2I = '文生图LLM模型';
const I2I = '图生图LLM模型';
const T2I_GGUF = 'Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf';
const I2I_GGUF = 'Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf';
const MMPROJ = 'Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf';
const UI_FILES = [
  'examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json',
  'example_workflows/人像精修工作流.json',
];
const API_FILES = [
  'examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.api.json',
];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function walkNodes(obj, out = []) {
  if (Array.isArray(obj)) {
    for (const item of obj) walkNodes(item, out);
  } else if (obj && typeof obj === 'object') {
    if (obj.type === 'GGPromptEnhancer' || obj.class_type === 'GGPromptEnhancer') out.push(obj);
    for (const value of Object.values(obj)) walkNodes(value, out);
  }
  return out;
}

// ---- 静态：文件里的字段与位置数组 ----
for (const rel of UI_FILES) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const data = JSON.parse(raw);
  const nodes = walkNodes(data);
  check(`${rel} 含 GGPromptEnhancer 节点`, nodes.length >= 2, String(nodes.length));
  check(`${rel} 没有残留「主模型」`, !raw.includes('主模型'), `出现 ${raw.split('主模型').length - 1} 次`);
  for (const node of nodes) {
    const v = node.widgets_values || [];
    const tag = `${rel} 节点 ${node.id}`;
    check(`${tag} widgets_values 19 位`, v.length === 19, String(v.length));
    check(`${tag} 两个模型分开且正确`, v[8] === T2I_GGUF && v[9] === I2I_GGUF, `${v[8]} / ${v[9]}`);
    check(`${tag} mmproj 配套 I2I`, v[10] === MMPROJ, String(v[10]));
    check(`${tag} 尾部控件补齐`, v[17] === false && v[18] === '默认', `${v[17]} / ${v[18]}`);
    const named = node.widgets_values_named;
    if (named) {
      check(`${tag} named 用新字段名`, named[T2I] === T2I_GGUF && named[I2I] === I2I_GGUF && !('主模型' in named), JSON.stringify({ t2i: named[T2I], i2i: named[I2I] }));
    }
    const inputNames = (node.inputs || []).map((i) => i.name);
    check(`${tag} 控件输入镜像含两个新模型`, inputNames.indexOf(I2I) === inputNames.indexOf(T2I) + 1, JSON.stringify(inputNames));
  }
}

// 拆「主模型」成两项会让 inputs 槽位整体右移一格；links 里记录的是槽位下标，
// 忘了平移就会在读档时丢线（顶层是数组格式，子图是对象格式）。
function linkProblems(container) {
  const nodes = new Map((container.nodes || []).map((n) => [n.id, n]));
  const bad = [];
  for (const link of container.links || []) {
    let lid, dst, slot;
    if (Array.isArray(link) && link.length > 4) {
      [lid, , , dst, slot] = link;
    } else if (link && typeof link === 'object') {
      ({ id: lid, target_id: dst, target_slot: slot } = link);
    } else continue;
    const node = nodes.get(dst);
    if (!node) continue;
    const input = (node.inputs || [])[slot];
    if (!input || input.link !== lid) bad.push(`边 ${lid} → 节点 ${dst} 槽 ${slot}`);
  }
  return bad;
}

for (const rel of UI_FILES) {
  const data = readJson(rel);
  const containers = [data, ...((data.definitions || {}).subgraphs || [])];
  for (const container of containers) {
    const bad = linkProblems(container);
    check(`${rel} 连线槽位双向一致`, bad.length === 0, bad.join('; '));
  }
}

for (const rel of API_FILES) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const data = JSON.parse(raw);
  const nodes = Object.entries(data).filter(([, v]) => v && v.class_type === 'GGPromptEnhancer');
  check(`${rel} 含 GGPromptEnhancer 节点`, nodes.length >= 2, String(nodes.length));
  check(`${rel} 没有残留「主模型」`, !raw.includes('主模型'), `出现 ${raw.split('主模型').length - 1} 次`);
  for (const [id, node] of nodes) {
    const inputs = node.inputs || {};
    check(`${rel} 节点 ${id} 双模型正确`, inputs[T2I] === T2I_GGUF && inputs[I2I] === I2I_GGUF, `${inputs[T2I]} / ${inputs[I2I]}`);
    check(`${rel} 节点 ${id} mmproj 配套`, inputs.mmproj === MMPROJ, String(inputs.mmproj));
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  for (const rel of UI_FILES) {
    const data = readJson(rel);
    const loaded = await page.evaluate(async (workflow) => {
      const app = window.app;
      app.graph.clear();
      app.graph.configure(workflow);
      await new Promise((r) => setTimeout(r, 450));
      await new Promise((r) => requestAnimationFrame(r));
      const found = [];
      const seen = new Set();
      const visitGraph = (graph, label) => {
        if (!graph || seen.has(graph)) return;
        seen.add(graph);
        for (const n of graph._nodes || []) {
          if ((n.comfyClass || n.type) !== 'GGPromptEnhancer') continue;
          const names = (n.widgets || []).map((w) => w.name);
          found.push({
            label, id: n.id, names,
            values: (n.widgets || []).map((w) => String(w.value)),
            linkedInputs: (n.inputs || []).filter((i) => i.link != null).length,
          });
        }
        // 新版前端的 _subgraphs 是 Map（UUID -> Subgraph），不是普通对象。
        const subs = graph._subgraphs;
        if (subs) {
          const list = subs instanceof Map
            ? Array.from(subs.values())
            : (Array.isArray(subs) ? subs : Object.values(subs));
          for (const sub of list) visitGraph(sub, label + '/sub');
        }
      };
      visitGraph(app.graph, 'root');
      return { topNodes: app.graph._nodes.length, found };
    }, data);

    check(`${rel} 真机加载后节点数正确`, loaded.topNodes >= 10, String(loaded.topNodes));
    check(`${rel} 真机加载找到增强节点`, loaded.found.length >= 1, String(loaded.found.length));
    for (const node of loaded.found) {
      const idx = node.names.indexOf(T2I);
      check(`${rel} 节点 ${node.id} 控件顺序含相邻双模型`, idx >= 0 && node.names[idx + 1] === I2I, JSON.stringify(node.names));
      check(`${rel} 节点 ${node.id} 文生图模型 = T2I GGUF`, node.values[idx] === T2I_GGUF, node.values[idx]);
      check(`${rel} 节点 ${node.id} 图生图模型 = I2I GGUF`, node.values[idx + 1] === I2I_GGUF, node.values[idx + 1]);
      const proj = node.names.indexOf('mmproj');
      check(`${rel} 节点 ${node.id} mmproj 没被上下文长度顶掉`, proj === idx + 2 && node.values[proj] === MMPROJ, `${proj} / ${node.values[proj]}`);
      const prompt = node.names.indexOf('输入提示词');
      check(`${rel} 节点 ${node.id} 输入提示词位置正确`, prompt === node.names.length - 3, `${prompt} / ${node.names.length}`);
    }
  }

  check('真机加载无页面异常', errors.length === 0, JSON.stringify(errors));
  await browser.close();

  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
  }
  console.log(`\n${passed}/${checks.length} 通过`);
  process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
