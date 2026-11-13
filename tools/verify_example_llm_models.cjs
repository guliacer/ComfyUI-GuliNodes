// 正式示例工作流回归：GGPromptEnhancer 必须是 17 位双 LLM 模型格式，
// GGPromptOptimizer 必须是外接 CLIP/VAE 的 3 位格式，且真机能加载不错位。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_example_llm_models.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const T2I = '文生图LLM模型';
const I2I = '图生图LLM模型';
const PE_T2I = '文生图PE模型';
const PE_I2I = '图生图PE模型';
const T2I_GGUF = 'Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf';
const I2I_GGUF = 'Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf';
const MMPROJ = 'Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf';
const UNLOAD_MODES = ['自动', '保持加载', '运行后自动卸载', '运行前后自动卸载'];
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
    if (obj.type === 'GGPromptEnhancer' || obj.type === 'GGPromptOptimizer'
      || obj.class_type === 'GGPromptEnhancer' || obj.class_type === 'GGPromptOptimizer') out.push(obj);
    for (const value of Object.values(obj)) walkNodes(value, out);
  }
  return out;
}

function typeOf(node) {
  return node.type || node.class_type;
}

// ---- 静态：字段与位置数组 ----
for (const rel of UI_FILES) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const data = JSON.parse(raw);
  const nodes = walkNodes(data);
  const enhancers = nodes.filter((n) => typeOf(n) === 'GGPromptEnhancer');
  const optimizers = nodes.filter((n) => typeOf(n) === 'GGPromptOptimizer');
  check(`${rel} 含 GGPromptEnhancer 节点`, enhancers.length >= 2, String(enhancers.length));
  check(`${rel} 含 GGPromptOptimizer 节点`, optimizers.length >= 2, String(optimizers.length));
  check(`${rel} 没有残留「主模型」`, !raw.includes('主模型'), `出现 ${raw.split('主模型').length - 1} 次`);
  check(`${rel} 没有残留旧 PE 默认模型`, !raw.includes('clip_l.safetensors'), '出现 clip_l.safetensors');
  check(`${rel} 没有旧卸载开关`, !raw.includes('生成后自动卸载模型'), '出现 生成后自动卸载模型');

  for (const node of enhancers) {
    const v = node.widgets_values || [];
    const tag = `${rel} 增强节点 ${node.id}`;
    check(`${tag} widgets_values 17 位`, v.length === 17, String(v.length));
    check(`${tag} 两个 LLM 模型分开且正确`, v[6] === T2I_GGUF && v[7] === I2I_GGUF, `${v[6]} / ${v[7]}`);
    check(`${tag} mmproj 配套 I2I`, v[8] === MMPROJ, String(v[8]));
    check(`${tag} 尾部控件补齐`, v[15] === false && v[16] === '默认', `${v[15]} / ${v[16]}`);
    const named = node.widgets_values_named;
    if (named) {
      check(`${tag} named 用新字段名`, named[T2I] === T2I_GGUF && named[I2I] === I2I_GGUF && !('主模型' in named), JSON.stringify({ t2i: named[T2I], i2i: named[I2I] }));
      check(`${tag} named 不再保存 PE 文件名`, !(PE_T2I in named) && !(PE_I2I in named), JSON.stringify(Object.keys(named)));
    }
    const inputNames = (node.inputs || []).map((i) => i.name);
    check(`${tag} 控件输入镜像含两个新模型`, inputNames.indexOf(I2I) === inputNames.indexOf(T2I) + 1, JSON.stringify(inputNames));
    for (const name of [PE_T2I, PE_I2I]) {
      const input = (node.inputs || []).find((i) => i.name === name);
      check(`${tag} ${name} 是外接 CLIP 端口`, !!input && input.type === 'CLIP' && !input.widget, JSON.stringify(input));
    }
    const unload = (node.inputs || []).find((i) => i.name === '卸载策略');
    check(`${tag} 卸载策略是下拉控件`, !!unload && unload.type === 'COMBO' && !!unload.widget, JSON.stringify(unload));
    check(`${tag} 没有旧卸载开关端口`, !inputNames.includes('生成后自动卸载模型'), JSON.stringify(inputNames));
    const connectable = node.properties?.ue_properties?.widget_ue_connectable || {};
    check(`${tag} 属性不再引用 PE / 旧卸载开关`, ![PE_T2I, PE_I2I, '生成后自动卸载模型'].some((key) => key in connectable), JSON.stringify(Object.keys(connectable)));
  }

  for (const node of optimizers) {
    const v = node.widgets_values || [];
    const tag = `${rel} 优化节点 ${node.id}`;
    const inputs = node.inputs || [];
    const names = inputs.map((i) => i.name);
    const clip = inputs.find((i) => i.name === 'clip');
    const vae = inputs.find((i) => i.name === 'vae');
    check(`${tag} widgets_values 3 位`, v.length === 3, String(v.length));
    check(`${tag} 输入顺序与 schema 一致`, JSON.stringify(names) === JSON.stringify(['clip', '正向提示词', '负向提示词', '分辨率', '图像.图像1', '图像.图像2', 'vae']), JSON.stringify(names));
    check(`${tag} clip 是已连线的 CLIP 端口`, !!clip && clip.type === 'CLIP' && clip.link != null, JSON.stringify(clip));
    check(`${tag} vae 是已连线的 VAE 端口`, !!vae && vae.type === 'VAE' && vae.link != null, JSON.stringify(vae));
    check(`${tag} 没有旧模型选择器`, !names.includes('CLIP名称') && !names.includes('CLIP类型') && !names.includes('VAE名称'), JSON.stringify(names));
    const named = node.widgets_values_named || {};
    check(`${tag} named 只剩提示词与分辨率`, JSON.stringify(Object.keys(named)) === JSON.stringify(['正向提示词', '负向提示词', '分辨率']), JSON.stringify(Object.keys(named)));
    const connectable = node.properties?.ue_properties?.widget_ue_connectable || {};
    check(`${tag} 属性不再引用旧模型选择器`, !['CLIP名称', 'CLIP类型', 'VAE名称'].some((key) => key in connectable), JSON.stringify(Object.keys(connectable)));
  }
}

// 改 inputs 数组会改连线槽位；links 里记录的是槽位下标，忘了平移就会在读档时丢线。
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
  check(`${rel} 没有残留旧 PE 默认模型`, !raw.includes('clip_l.safetensors'), '出现 clip_l.safetensors');
  check(`${rel} 没有旧卸载开关`, !raw.includes('生成后自动卸载模型'), '出现 生成后自动卸载模型');
  const enhancers = Object.entries(data).filter(([, v]) => v && v.class_type === 'GGPromptEnhancer');
  const optimizers = Object.entries(data).filter(([, v]) => v && v.class_type === 'GGPromptOptimizer');
  check(`${rel} 含 GGPromptEnhancer 节点`, enhancers.length >= 2, String(enhancers.length));
  check(`${rel} 含 GGPromptOptimizer 节点`, optimizers.length >= 2, String(optimizers.length));
  for (const [id, node] of enhancers) {
    const inputs = node.inputs || {};
    check(`${rel} 节点 ${id} 双模型正确`, inputs[T2I] === T2I_GGUF && inputs[I2I] === I2I_GGUF, `${inputs[T2I]} / ${inputs[I2I]}`);
    check(`${rel} 节点 ${id} mmproj 配套`, inputs.mmproj === MMPROJ, String(inputs.mmproj));
    check(`${rel} 节点 ${id} 不再提交 PE 文件名`, !(PE_T2I in inputs) && !(PE_I2I in inputs), JSON.stringify(Object.keys(inputs)));
    check(`${rel} 节点 ${id} 卸载策略合法`, UNLOAD_MODES.includes(inputs['卸载策略']), String(inputs['卸载策略']));
    check(`${rel} 节点 ${id} 补全新控件`, inputs['透明背景'] === false && inputs['增强方向'] === '默认', `${inputs['透明背景']} / ${inputs['增强方向']}`);
  }
  for (const [id, node] of optimizers) {
    const inputs = node.inputs || {};
    check(`${rel} 优化节点 ${id} clip/vae 是数组连线`, Array.isArray(inputs.clip) && inputs.clip.length === 2 && Array.isArray(inputs.vae) && inputs.vae.length === 2, JSON.stringify({ clip: inputs.clip, vae: inputs.vae }));
    check(`${rel} 优化节点 ${id} 不再提交模型名`, !('CLIP名称' in inputs) && !('CLIP类型' in inputs) && !('VAE名称' in inputs), JSON.stringify(Object.keys(inputs)));
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
          const type = n.comfyClass || n.type;
          if (type !== 'GGPromptEnhancer' && type !== 'GGPromptOptimizer') continue;
          const names = (n.widgets || []).map((w) => w.name);
          found.push({
            label, id: n.id, type, names,
            values: (n.widgets || []).map((w) => String(w.value)),
            inputs: (n.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link, widget: i.widget?.name || null })),
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
    const enhancers = loaded.found.filter((n) => n.type === 'GGPromptEnhancer');
    const optimizers = loaded.found.filter((n) => n.type === 'GGPromptOptimizer');
    check(`${rel} 真机加载找到增强节点`, enhancers.length >= 1, String(enhancers.length));
    check(`${rel} 真机加载找到优化节点`, optimizers.length >= 1, String(optimizers.length));
    for (const node of enhancers) {
      const idx = node.names.indexOf(T2I);
      check(`${rel} 增强节点 ${node.id} 控件顺序含相邻双模型`, idx >= 0 && node.names[idx + 1] === I2I, JSON.stringify(node.names));
      check(`${rel} 增强节点 ${node.id} 文生图模型 = T2I GGUF`, node.values[idx] === T2I_GGUF, node.values[idx]);
      check(`${rel} 增强节点 ${node.id} 图生图模型 = I2I GGUF`, node.values[idx + 1] === I2I_GGUF, node.values[idx + 1]);
      const proj = node.names.indexOf('mmproj');
      check(`${rel} 增强节点 ${node.id} mmproj 没被上下文长度顶掉`, proj === idx + 2 && node.values[proj] === MMPROJ, `${proj} / ${node.values[proj]}`);
      const prompt = node.names.indexOf('输入提示词');
      check(`${rel} 增强节点 ${node.id} 输入提示词位置正确`, prompt === node.names.length - 3, `${prompt} / ${node.names.length}`);
      const peT2I = node.inputs.find((i) => i.name === PE_T2I);
      const peI2I = node.inputs.find((i) => i.name === PE_I2I);
      check(`${rel} 增强节点 ${node.id} PE 端口是 CLIP`, !!peT2I && peT2I.type === 'CLIP' && !peT2I.widget && !!peI2I && peI2I.type === 'CLIP' && !peI2I.widget, JSON.stringify([peT2I, peI2I]));
      check(`${rel} 增强节点 ${node.id} 卸载策略存在`, node.names.includes('卸载策略') && !node.names.includes('生成后自动卸载模型'), JSON.stringify(node.names));
    }
    for (const node of optimizers) {
      check(`${rel} 优化节点 ${node.id} 控件 3 位`, node.names.length === 3, JSON.stringify(node.names));
      const clip = node.inputs.find((i) => i.name === 'clip');
      const vae = node.inputs.find((i) => i.name === 'vae');
      check(`${rel} 优化节点 ${node.id} clip/vae 已接线`, !!clip && clip.type === 'CLIP' && clip.link != null && !!vae && vae.type === 'VAE' && vae.link != null, JSON.stringify([clip, vae]));
      check(`${rel} 优化节点 ${node.id} 无旧模型控件`, !node.inputs.some((i) => ['CLIP名称', 'CLIP类型', 'VAE名称'].includes(i.name)), JSON.stringify(node.inputs));
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
