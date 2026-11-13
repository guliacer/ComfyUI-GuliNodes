// ComfyUI 真实前端回归；默认只检查提交参数，不加载模型。
// COMFY_URL=http://127.0.0.1:8190 node tools/verify_option_confirm_subgraph.cjs --execute
// --execute 仅允许 CPU 测试服务，运行 32x32 纯色图像并验证保存数量。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const BASE_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const OUT = path.resolve(__dirname, '../output/playwright');
const SOURCE = path.resolve(__dirname, '../web/gg-option-confirm.js');
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
  assert.ok(ok, name);
}
async function preparePage(browser, source) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/settings**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.route('**/userdata/**', route => ['POST', 'PUT', 'DELETE'].includes(route.request().method())
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.route('**/prompt', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  if (source) await page.route('**/gg-option-confirm.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: source,
  }));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.graph && LiteGraph.registered_node_types?.GGOptionConfirm,
    null, { timeout: 60000 });
  await page.evaluate(() => {
    const blank = () => app.loadGraphData({ version: 0.4, nodes: [], links: [], groups: [], config: {}, extra: {} });
    const widget = (node, name) => node.widgets.find(w => w.name === name);
    const add = (type, graph = app.graph) => { const node = LiteGraph.createNode(type); graph.add(node); return node; };
    async function controlFor(sub, values) {
      const control = add('GGOptionConfirm');
      for (let slot = 0; slot < values.length; slot++) {
        const link = control.connect(slot, sub, slot);
        if (!link) throw Error('连接失败: ' + slot);
        await Promise.resolve();
        const w = control.widgets.find(w => w.__ggOptionConfirmSlot === slot);
        w.value = values[slot]; w.callback?.(w.value);
      }
      return control;
    }
    async function fixture({ type = 'EmptyLatentImage', fanout = false, serializer = false } = {}) {
      await blank();
      const leaf = add(type); widget(leaf, 'batch_size').value = 4;
      if (type === 'EmptyImage') { widget(leaf, 'width').value = 32; widget(leaf, 'height').value = 32; }
      const leaves = [leaf];
      if (fanout) { const extra = add(type); widget(extra, 'batch_size').value = 4; leaves.push(extra); }
      const sub = app.graph.convertToSubgraph(new Set(leaves)).node;
      const actualLeaves = leaves.map(n => sub.subgraph.getNodeById(n.id));
      const actualLeaf = actualLeaves[0];
      if (serializer) widget(actualLeaf, 'batch_size').serializeValue = async function() {
        await Promise.resolve(); return this.value * 10;
      };
      const input = sub.subgraph.addInput('batch_size', 'INT');
      for (const n of actualLeaves) if (!input.connect(n.inputs.find(i => i.name === 'batch_size'), n)) throw Error('子图输入连接失败');
      const control = await controlFor(sub, [2]);
      control.pos = [80, 160]; sub.pos = [520, 160];
      window.__optionFixture = { leaf: actualLeaf, leaves: actualLeaves, sub, control };
      return window.__optionFixture;
    }
    window.__optionHelpers = { blank, widget, add, controlFor, fixture };
  });
  return { context, page, errors };
}
(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const source = await fs.readFile(SOURCE, 'utf8');
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-proxy-server'] });
  let imagePrompt;
  try {
    const brokenSource = source.replace('prepareSubgraphInputs(info.targetNode, info.input);', '');
    check('反向验证确实移除了子图桥接', brokenSource !== source);
    const broken = await preparePage(browser, brokenSource);
    try {
      const state = await broken.page.evaluate(async () => {
        const f = await __optionHelpers.fixture(); const p = await app.graphToPrompt();
        return { canvas: f.control.widgets[0].value, host: f.sub.widgets[0].value,
          submitted: p.output[f.sub.id + ':' + f.leaf.id].inputs.batch_size };
      });
      check('反向验证复现画布二但实际提交四', state.canvas === 2 && state.host === 2 && state.submitted === 4, state);
    } finally { await broken.context.close(); }
    const live = await preparePage(browser);
    try {
      for (const vue of [true, false]) for (const palette of ['light', 'dark']) {
        const label = (vue ? 'Nodes2-' : 'Classic-') + palette;
        const rows = await live.page.evaluate(async ({ vue, palette }) => {
          const { blank, widget, add, controlFor, fixture } = __optionHelpers;
          const rows = []; const record = (name, ok, detail) => rows.push({ name, ok, detail });
          await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', vue);
          await app.ui.settings.setSettingValue('Comfy.ColorPalette', palette);
          let f = await fixture();
          let prompt = await app.graphToPrompt(); let id = f.sub.id + ':' + f.leaf.id;
          record('批量二真实提交二', prompt.output[id].inputs.batch_size === 2);
          record('不覆盖子图定义里的默认批量', widget(f.leaf, 'batch_size').value === 4);
          const wrapped = widget(f.leaf, 'batch_size').serializeValue;
          for (const value of [1, 3, 2]) {
            // Nodes 2.0 文本/数值修改不保证触发 callback，提交阶段仍应取到当前值。
            f.control.widgets[0].value = value;
            prompt = await app.graphToPrompt();
            record('省略回调仍提交当前值' + value, prompt.output[id].inputs.batch_size === value);
          }
          record('重复提交不叠加序列化包装', widget(f.leaf, 'batch_size').serializeValue === wrapped);
          const copy = add(f.sub.type); const second = await controlFor(copy, [3]);
          prompt = await app.graphToPrompt();
          record('夹具共享同一个子图定义', copy.subgraph === f.sub.subgraph);
          record('共享实例各自提交二和三', prompt.output[id].inputs.batch_size === 2
            && prompt.output[copy.id + ':' + f.leaf.id].inputs.batch_size === 3);
          const nested = app.graph.convertToSubgraph(new Set([copy])).node;
          await Promise.resolve(); prompt = await app.graphToPrompt();
          const nestedId = nested.id + ':' + copy.id + ':' + f.leaf.id;
          record('两层子图保留各自批量', prompt.output[id].inputs.batch_size === 2
            && prompt.output[nestedId].inputs.batch_size === 3);
          const graph = app.graph.serialize(); await app.loadGraphData(graph);
          prompt = await app.graphToPrompt();
          record('保存读档后批量仍为二和三', prompt.output[id].inputs.batch_size === 2
            && prompt.output[nestedId].inputs.batch_size === 3);
          f.control = app.graph.getNodeById(f.control.id); f.sub = app.graph.getNodeById(f.sub.id);
          f.control.disconnectOutput(0); await Promise.resolve();
          const hostWidget = f.sub.getWidgetFromSlot(f.sub.inputs[0]); hostWidget.value = 5; hostWidget.callback?.(5);
          prompt = await app.graphToPrompt();
          record('断线后回归子图本身的参数', prompt.output[id].inputs.batch_size === 5
            && prompt.output[nestedId].inputs.batch_size === 3);
          f.control.connect(0, f.sub, 0); await Promise.resolve(); f.control.widgets[0].value = 2;
          prompt = await app.graphToPrompt();
          record('重新接线重新提交二', prompt.output[id].inputs.batch_size === 2);
          f = await fixture({ fanout: true }); prompt = await app.graphToPrompt();
          record('同一子图输入的多个目标全部生效', f.leaves.every(n => prompt.output[f.sub.id + ':' + n.id].inputs.batch_size === 2));
          f = await fixture({ serializer: true }); prompt = await app.graphToPrompt();
          record('保留已有异步序列化转换', prompt.output[f.sub.id + ':' + f.leaf.id].inputs.batch_size === 20);
          record('异步序列化后恢复定义值', widget(f.leaf, 'batch_size').value === 4);
          await blank();
          const latent = add('EmptyLatentImage'), scale = add('ImageScaleBy'), save = add('GGImageCompressSave');
          widget(latent, 'batch_size').value = 4;
          const sub = app.graph.convertToSubgraph(new Set([latent, scale, save])).node;
          const specs = [ [scale, 'upscale_method', 'bilinear'], [scale, 'scale_by', 0.75],
            [save, '文件名前缀', '批量回归'], [save, '清除内存', false], [latent, 'batch_size', 2] ];
          for (const [source, name] of specs) { const node = sub.subgraph.getNodeById(source.id);
            const input = node.inputs.find(i => i.name === name);
            if (!sub.subgraph.addInput(name, input.type).connect(input, node)) throw Error(name); }
          const control = await controlFor(sub, specs.map(s => s[2]));
          prompt = await app.graphToPrompt();
          for (const [node, name, value] of specs) record('第五输出及参数类型' + name,
            prompt.output[sub.id + ':' + node.id].inputs[name] === value);
          control.widgets.find(w => w.__ggOptionConfirmSlot === 1).value = 0;
          control.widgets.find(w => w.__ggOptionConfirmSlot === 2).value = '';
          prompt = await app.graphToPrompt();
          record('零和空字符串不会被当成缺值', prompt.output[sub.id + ':' + scale.id].inputs.scale_by === 0
            && prompt.output[sub.id + ':' + save.id].inputs['文件名前缀'] === '');
          const saved = app.graph.serialize(); await app.loadGraphData(saved); prompt = await app.graphToPrompt();
          record('多类型参数读档保留', prompt.output[sub.id + ':' + latent.id].inputs.batch_size === 2
            && prompt.output[sub.id + ':' + save.id].inputs['清除内存'] === false
            && prompt.output[sub.id + ':' + scale.id].inputs.scale_by === 0);
          await blank(); const direct = add('EmptyLatentImage'), c = add('GGOptionConfirm');
          c.connect(0, direct, direct.inputs.findIndex(i => i.name === 'batch_size')); await Promise.resolve();
          c.widgets[0].value = 2; prompt = await app.graphToPrompt();
          record('直接连接普通节点保持兼容', prompt.output[direct.id].inputs.batch_size === 2);
          return rows;
        }, { vue, palette });
        for (const row of rows) check(label + ' ' + row.name, row.ok, row.detail);
      }
      imagePrompt = await live.page.evaluate(async () => {
        const { fixture, widget, add } = __optionHelpers;
        await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', true);
        await app.ui.settings.setSettingValue('Comfy.ColorPalette', 'light');
        const f = await fixture({ type: 'EmptyImage' });
        const output = f.sub.subgraph.addOutput('图像', 'IMAGE');
        if (!output.connect(f.leaf.outputs[0], f.leaf)) throw Error('子图输出连接失败');
        const save = add('GGImageCompressSave'); widget(save, '文件名前缀').value = 'GG_option_batch/二张';
        widget(save, '清除内存').value = false;
        f.sub.connect(0, save, save.inputs.findIndex(i => i.name === '图像'));
        save.pos = [900, 160];
        app.canvas.ds.scale = 0.9; app.canvas.ds.offset = [0, 0]; app.canvas.setDirty(true, true);
        const p = await app.graphToPrompt();
        return { output: p.output, workflow: p.workflow, saveId: save.id, sourceId: f.control.id, imageId: f.sub.id + ':' + f.leaf.id };
      });
      check('小图执行夹具实际提交二', imagePrompt.output[imagePrompt.imageId].inputs.batch_size === 2);
      const template = live.page.locator('[data-dialog-key="global-workflow-template-selector"]');
      if (await template.isVisible()) { await live.page.keyboard.press('Escape'); await template.waitFor({ state: 'hidden' }); }
      const numberInput = live.page.locator('.lg-node[data-node-id="' + imagePrompt.sourceId + '"]').getByRole('spinbutton');
      for (const value of [3, 2]) {
        await numberInput.fill(String(value)); await numberInput.press('Enter');
        const submitted = await live.page.evaluate(async id => (await app.graphToPrompt()).output[id].inputs.batch_size, imagePrompt.imageId);
        check('Nodes2 原生输入框改为' + value + '真实提交' + value, submitted === value);
      }
      await live.page.screenshot({ path: path.join(OUT, 'gg-option-confirm-subgraph-batch.png'), fullPage: true });
      check('本模块没有浏览器运行异常', !live.errors.some(e => /gg-option-confirm/.test(e)), live.errors);
    } finally { await live.context.close(); }
    if (process.argv.includes('--execute')) {
      const stats = await (await fetch(BASE_URL + '/system_stats')).json();
      assert.ok(stats.system.argv.includes('--cpu'), '--execute 需要独立 CPU 测试服务');
      const response = await fetch(BASE_URL + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: imagePrompt.output, client_id: 'gg-option-batch-regression',
          extra_data: { extra_pnginfo: { workflow: imagePrompt.workflow } } }) });
      const queued = await response.json();
      check('两张小图任务提交成功', response.ok && !!queued.prompt_id, queued);
      const deadline = Date.now() + 30000;
      let completed;
      while (Date.now() < deadline) {
        const history = await (await fetch(BASE_URL + '/history/' + queued.prompt_id)).json();
        completed = history[queued.prompt_id];
        if (completed?.status?.completed) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      check('小图任务执行成功', completed?.status?.status_str === 'success', completed?.status);
      const images = completed?.outputs?.[imagePrompt.saveId]?.images;
      check('实际只保存两张图像', images?.length === 2, images);
      await fs.writeFile(path.join(OUT, 'gg-option-confirm-subgraph-batch-history.json'), JSON.stringify(completed, null, 2));
    }
  } finally {
    await browser.close();
    await fs.writeFile(path.join(OUT, 'gg-option-confirm-subgraph-batch-result.json'), JSON.stringify({
      checks, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length,
    }, null, 2));
  }
  console.log('RESULT ' + checks.filter(c => c.ok).length + '/' + checks.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
