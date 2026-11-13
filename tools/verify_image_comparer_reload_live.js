// N张 真实前端读档回归：使用现有 frago 标签页，不自行启动浏览器。
// 启动：frago browser -b cdp exec-js W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/verify_image_comparer_reload_live.js --group gulinodes-comparer-height --return-value
// 结果：frago browser -b cdp exec-js "window.__ggComparerHeightRun" --group gulinodes-comparer-height --return-value
(() => {
 if (document.hidden) return { state: 'error', error: '测试标签页在后台，请先激活本组标签页再运行' };
 const previous = window.__ggComparerHeightRun;
 if (previous?.state === 'running') return previous;
 const job = { state: 'running', startedAt: new Date().toISOString(), checks: [] };
 window.__ggComparerHeightRun = job;
 const task = (async () => {
 const app = window.app ?? window.comfyAPI?.app?.app;
 if (!app?.graph) throw new Error('ComfyUI 工作台尚未加载完成');
 const original = app.graph.serialize();
 const originalMode = app.ui.settings.getSettingValue('Comfy.VueNodes.Enabled');
 const view = { scale: app.canvas.ds.scale, offset: Array.from(app.canvas.ds.offset) };
 const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
 const checks = job.checks;
 const check = (mode, name, ok, detail) => checks.push({ mode, name, ok: !!ok, detail });
 const near = (a, b) => a && b && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= 2);
 const userResize = (node, size) => {
  const previous = app.canvas.resizing_node;
  app.canvas.resizing_node = node;
  try { node.setSize(size); } finally { app.canvas.resizing_node = previous; }
 };
 try {
  for (const vue of [false, true]) {
   const mode = vue ? 'Nodes 2.0' : '经典画布';
   await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', vue);
   app.graph.clear(); app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
   const a = LiteGraph.createNode('EmptyImage'), b = LiteGraph.createNode('EmptyImage');
   const node = LiteGraph.createNode('GGImageComparer4'), output = LiteGraph.createNode('PreviewImage');
   for (const item of [a, b, node, output]) app.graph.add(item);
   a.pos = [30, 60]; b.pos = [30, 270]; node.pos = [420, 60]; output.pos = [830, 60];
   await sleep(300);
   a.connect(0, node, node.inputs.findIndex(input => input.name === '图像_A')); await sleep(120);
   b.connect(0, node, node.inputs.findIndex(input => input.name === '图像_B')); await sleep(180);
   node.connect(0, output, 0); await sleep(300);
   const id = node.id;
   const get = () => app.graph.getNodeById(id);
   const labelValues = () => get().widgets.filter(widget => widget.name.startsWith('标签_')).map(widget => widget.value);
   const linkState = () => get().inputs.filter(input => input.name.startsWith('图像_')).map(input => [input.name, input.link]);
   const initialLinks = linkState();
   const values = labelValues();
   const reload = async () => {
    const data = app.graph.serialize();
    await app.loadGraphData(JSON.parse(JSON.stringify(data))); await sleep(600);
    return get();
   };
   check(mode, '双图保留 A/B 连线及空尾槽 C', initialLinks.length === 3 && initialLinks[0][1] != null && initialLinks[1][1] != null && initialLinks[2][1] == null, initialLinks);
   const autoHeight = get().size[1]; await reload();
   check(mode, '自动高度读档不膨胀', Math.abs(get().size[1] - autoHeight) <= 2, { before: autoHeight, after: get().size[1] });
   userResize(get(), [340, 300]); await sleep(150);
   const user = Array.from(get().size);
   for (let iteration = 1; iteration <= 5; iteration++) {
    await reload();
    check(mode, '手动 300px 高度连续读档 ' + iteration, near(Array.from(get().size), user), { before: user, after: Array.from(get().size) });
   }
   check(mode, '读档后图像连线下标不变', JSON.stringify(linkState()) === JSON.stringify(initialLinks), linkState());
   check(mode, '读档后隐藏标签的值不变', JSON.stringify(labelValues()) === JSON.stringify(values), undefined);
   const outputLink = get().outputs[0].links?.[0];
   const link = app.graph.links[outputLink];
   check(mode, '固定输出仍连向预览节点的第 0 槽', link?.origin_slot === 0 && link?.target_slot === 0 && outputLink != null, { origin: link?.origin_slot, target: link?.target_slot });
   userResize(get(), [340, 620]); await sleep(150); await reload();
   check(mode, '用户拉高到 620px 后仍可读档保留', near(Array.from(get().size), [340, 620]), Array.from(get().size));
   userResize(get(), [260, 300]); await sleep(150); await reload();
   check(mode, '重新拖小后读档不回到旧高度', near(Array.from(get().size), [260, 300]), Array.from(get().size));
   const font = get().widgets.find(widget => widget.name === '字体大小');
   if (font) { font.value = Number(font.value) + 1; font.callback?.(font.value); }
   await sleep(250);
   check(mode, '修改参数不造成高度回弹', Math.abs(get().size[1] - 300) <= 2, Array.from(get().size));
   for (let index = 2; index < 20; index++) {
    // 从当前图恢复源节点，不沿用已经卸载的对象。
    const source = app.graph._nodes.find(item => item.comfyClass === 'EmptyImage' || item.type === 'EmptyImage');
    source.connect(0, get(), get().inputs.findIndex(input => input.name === '图像_' + String.fromCharCode(65 + index)));
    await sleep(40);
   }
   await sleep(400);
   check(mode, '连接 20 张时为真实内容增加高度', get().size[1] > 300 && get().inputs.filter(input => input.name.startsWith('图像_')).length === 20, Array.from(get().size));
   for (const input of get().inputs.filter(input => input.name.startsWith('图像_')).slice(2).reverse()) {
    const index = get().inputs.indexOf(input); get().disconnectInput(index);
   }
   await sleep(500);
   check(mode, '减回两张后恢复 300px 用户高度', Math.abs(get().size[1] - 300) <= 2, Array.from(get().size));
  }
  return { passed: checks.filter(item => item.ok).length, total: checks.length, checks };
 } finally {
  await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', originalMode);
  await app.loadGraphData(original);
  app.canvas.ds.scale = view.scale; app.canvas.ds.offset = view.offset; app.canvas.setDirty(true, true);
 }
})();
 task.then(result => Object.assign(job, { state: 'complete', finishedAt: new Date().toISOString(), ...result }))
  .catch(error => Object.assign(job, { state: 'error', error: String(error), stack: error.stack, finishedAt: new Date().toISOString() }));
 return { state: job.state, startedAt: job.startedAt };
})()