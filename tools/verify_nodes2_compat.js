// 在已加载 GuliNodes 的 ComfyUI 页面执行；结果保存在 __ggNodes2CompatResult。
// 可选 __ggNodes2CompatOptions = { vue: true, palette: "dark" }。
// 会临时替换当前测试页工作流，完成后恢复；不执行模型推理。
(async () => {
  const { app } = window;
  if (!app?.graph || document.hidden) throw new Error("请在前台打开已加载插件的 ComfyUI 页面。");
  const options = window.__ggNodes2CompatOptions ?? { vue: true, palette: "dark" };
  const settings = app.ui.settings;
  const saved = { graph: app.graph.serialize(), vue: settings.getSettingValue("Comfy.VueNodes.Enabled"), palette: settings.getSettingValue("Comfy.ColorPalette"), collapse: settings.getSettingValue("GuliNodes.enableNodeCollapseButton"), width: settings.getSettingValue("GuliNodes.nodeCollapseWidthPadding") };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const wait = (ms=260) => new Promise(r => setTimeout(r, ms));
  const widget = (n,name) => n.widgets?.find(w => w.name === name);
  const host = n => document.querySelector('.lg-node[data-node-id="'+n.id+'"]');
  const panel = (n,name) => widget(n,name)?._ggVuePanel;
  const set = (n,name,v,notify=true) => { const w=widget(n,name); if(!w) throw Error(name); w.value=v; if(notify) w.callback?.(v); };
  const add = (type,x=20,y=20) => { const n=LiteGraph.createNode(type); if(!n) throw Error(type); app.graph.add(n); n.pos=[x,y]; return n; };
  const draw = async () => {app.canvas.setDirty(true,true);app.canvas.draw(true,true);await wait();};
  const visible = w => !w.hidden && !/hidden/i.test(w.type);
  const mode = async v => {await settings.setSettingValue("Comfy.VueNodes.Enabled",v);await draw();};
  const blank = { last_node_id:0,last_link_id:0,nodes:[],links:[],groups:[],config:{},extra:{},version:0.4 };
  try {
    await settings.setSettingValue("Comfy.ColorPalette",options.palette);
    await settings.setSettingValue("GuliNodes.enableNodeCollapseButton",true);
    await mode(options.vue);
    await app.loadGraphData(blank);
    app.canvas.ds.scale=0.5;app.canvas.ds.offset=[30,120];
    let concat=add('GGTextConcat',20,30), math=add('GGSimpleMath',380,30), lora=add('GGLoRACustomLoader',740,30), groups=add('GGLoRAGroupLoader',1100,30), single=add('GGGroupControllerS',20,650), multi=add('GGGroupControllerM',380,650), comparer=add('GGImageComparer2',740,650), sr=add('GGImageSuperResolution',1100,650);
    await draw();
    set(concat,'文本1','第一项',false);await draw();
    check('文本原生输入自动增加下一行',visible(widget(concat,'文本2')));
    set(concat,'文本1','',false);await draw();
    check('清空文本收起多余行',!visible(widget(concat,'文本2')));
    const textSource=add('GGTextDisplayCopy',20,1100);
    const textOutput=textSource.outputs.findIndex(o=>o.type==='STRING');
    const slot=concat.inputs.findIndex(i=>i.name==='文本1');
    if(textOutput>=0 && slot>=0){ textSource.connect(textOutput,concat,slot);await draw();check('接线末尾保留可输入的下一行',visible(widget(concat,'文本2')));textSource.disconnectOutput(textOutput);await draw();check('断线后首行恢复可编辑',visible(widget(concat,'文本1'))); }
    else check('文本连线夹具有效',false,{textOutput,slot});
    const mathSource=add('GGSimpleMath',380,1100);
    mathSource.connect(0,math,math.inputs.findIndex(i=>i.name==='a'));await draw();
    mathSource.connect(0,math,math.inputs.findIndex(i=>i.name==='b'));await draw();
    check('数学接线自动增长输入',math.inputs.some(i=>i.name==='c') && visible(widget(math,'表达式_2')));
    mathSource.disconnectOutput(0);await draw();
    check('数学断线收起多余输入',!math.inputs.some(i=>i.name==='c'));
    for(const n of [lora,groups]){
      widget(n,'新增LoRA').callback();await draw();
      set(n,'LoRA1名称','回归A.safetensors');set(n,'LoRA1强度',0.25);set(n,'LoRA1启用',false);
      set(n,'LoRA2名称','回归B.safetensors');set(n,'LoRA2强度',0.75);set(n,'LoRA2启用',true);
      check(n.type+'第二行可用',visible(widget(n,'LoRA2名称')));
      if(options.vue){
        const order=panel(n,'gg_lora_order');
        check(n.type+'原生排序可见',order?.host.isConnected && !order.widget.hidden);
        [...order.host.querySelectorAll('button')].find(b=>b.textContent==='下移').click();await draw();
        check(n.type+'排序整组移动参数',widget(n,'LoRA1名称').value==='回归B.safetensors' && widget(n,'LoRA1强度').value===0.75 && widget(n,'LoRA1启用').value===true);
      } else check(n.type+'经典不显示额外排序栏',widget(n,'gg_lora_order').hidden);
    }
    if(options.vue){
      const gp=panel(groups,'gg_lora_groups_dom');
      gp.host.querySelector('[aria-label="新增 LoRA 组"]').click();await draw();
      check('新增LoRA组',JSON.parse(groups.properties.ggLoraGroups).length===2);
      set(groups,'LoRA1名称','第二组.safetensors');set(groups,'LoRA1强度',0.9);
      gp.host.querySelector('[role=tab]').click();await draw();
      check('切组恢复整组值',widget(groups,'LoRA1名称').value==='回归B.safetensors');
      gp.host.querySelectorAll('[role=tab]')[1].click();await draw();
      check('切回保留第二组值',widget(groups,'LoRA1名称').value==='第二组.safetensors' && widget(groups,'LoRA1强度').value===0.9);
      [...gp.host.querySelectorAll('button')].find(b=>b.textContent==='删除组').click();await draw();
      check('删除组后保留原组',JSON.parse(groups.properties.ggLoraGroups).length===1 && widget(groups,'LoRA1名称').value==='回归B.safetensors');
    }
    const member=add('KSamplerSelect',1650,800);
    const group=new LiteGraph.LGraphGroup('回归编组');group.pos=[1600,740];group.size=[480,300];app.graph.add(group);
    single.properties.selectedGroup='回归编组';multi.properties.selectedGroups=['回归编组'];await draw();
    if(options.vue){
      const mp=panel(multi,'gg_group_controls');
      const click=text=>[...mp.host.querySelectorAll('button')].find(b=>b.textContent===text).click();
      click('全部跳过');await draw();check('多组全部跳过生效',member.mode===4);
      click('全部启用');await draw();check('多组全部启用生效',member.mode===0);
      set(single,'启用',false);await draw();check('单组原生开关生效',member.mode===4);
      set(single,'启用',true);await draw();check('单组原生开关恢复',member.mode===0);
      check('单组保留原生接线控件',visible(widget(single,'启用')) && !!host(single)?.querySelector('[data-widget-name="启用"]'));
      const confirm=add('GGOptionConfirm',20,1050);const slot=single.inputs.findIndex(i=>i.name==='启用');confirm.connect(0,single,slot);await draw();
      check('单组启用接线保持有效',single.inputs[slot].link!=null && !!host(single)?.querySelector('.lg-slot'));
      confirm.disconnectOutput(0);await draw();check('单组断线恢复开关',visible(widget(single,'启用')));
    }
    const hint=widget(sr,'gg_model_mirror_hint');check('超分原生帮助按钮',hint?.type==='button' && hint.serialize===false);
    const imgs=await fetch('/object_info/GGImageLoad').then(r=>r.json());const input=imgs.GGImageLoad.input.required['图像'];const values=Array.isArray(input[0])?input[0]:input[1].options;
    const name=values.find(v=>/\.(png|jpg|jpeg|webp)$/i.test(v));const parts=name.split('/');const image={filename:parts.pop(),subfolder:parts.join('/'),type:'input'};
    comparer.onExecuted({a_images:[image],b_images:[image]});await Promise.all(comparer.ggComparer.imgs.map(img=>img.decode()));await draw();
    check('双图对比收到两张图像',comparer.ggComparer?.imgs.filter(i=>i?.naturalWidth>0).length===2);
    set(comparer,'Mode',true);await draw();check('对比模式同步',comparer.properties.comparer_mode==='Click');
    set(comparer,'Mode',false);await draw();check('对比模式恢复',comparer.properties.comparer_mode==='Slide');
    const imagesWidget=widget(comparer,'gg_image_comparer_preview');check('对比预览按渲染器显隐',imagesWidget.hidden===!options.vue);
    const before=app.graph.serialize();await app.loadGraphData(before);await draw();
    const after=app.graph.serialize();
    for(const n of before.nodes){const next=after.nodes.find(x=>String(x.id)===String(n.id));check(n.type+'读档参数保留',JSON.stringify(n.widgets_values??[])===JSON.stringify(next?.widgets_values??[]),{id:n.id});}
    for(const n of app.graph._nodes){const names=(n.widgets??[]).filter(w=>w.name.startsWith('gg_')).map(w=>w.name);check(n.type+'DOM控件不重复',new Set(names).size===names.length);}
    groups=app.graph._nodes.find(n=>n.type==='GGLoRAGroupLoader');single=app.graph._nodes.find(n=>n.type==='GGGroupControllerS');
    await mode(!options.vue);await mode(options.vue);
    check('来回切换后组面板显隐正确',widget(groups,'gg_lora_groups_dom').hidden===!options.vue);
    if(options.vue) for(const n of app.graph._nodes.filter(n=>/LoRA.*Loader/.test(n.type))) check(n.type+'切换后恢复原生标签',String(widget(n,'LoRA1名称').displayName).trim()!=='' && String(widget(n,'LoRA1强度').displayName).trim()!=='');
    if(options.vue){for(const n of [groups,single,app.graph._nodes.find(n=>n.type==='GGGroupControllerM')]){
      const p=n.widgets.find(w=>w._ggVuePanel)?._ggVuePanel;const rect=p.host.getBoundingClientRect();const nr=host(n).getBoundingClientRect();
      check(n.type+'面板不溢出',rect.width>0 && rect.right<=nr.right+1 && p.host.scrollHeight<=p.host.offsetHeight+2);
      check(n.type+'主题令牌有效',getComputedStyle(p.host).getPropertyValue('--gg-panel').trim()!=='');
    }}
    let wide=app.graph._nodes.find(n=>n.type==='KSamplerSelect');wide.title='用于回归的极长节点标题'.repeat(30);wide.setSize([1600,400]);wide.collapse();await draw();
    for(const width of [120,158,200]){await settings.setSettingValue('GuliNodes.nodeCollapseWidthPadding',width);await draw();const actual=options.vue?host(wide).getBoundingClientRect().width/app.canvas.ds.scale:wide._collapsed_width;check('根图折叠宽度'+width,Math.abs(actual-width)<1,{actual});}
    if(options.vue){const e=host(wide);e.classList.remove('gg-vue-collapse-width');const broken=e.getBoundingClientRect().width/app.canvas.ds.scale;e.classList.add('gg-vue-collapse-width');check('宽度反向验证可重现长条',broken>1000,{broken});}
    wide.collapse();await draw();check('展开保留手动尺寸',wide.size[0]===1600 && wide.size[1]===400);
    wide.collapse();const sub=app.graph.convertToSubgraph(new Set([wide]));app.canvas.openSubgraph(sub.subgraph,sub.node);await draw();wide=sub.subgraph._nodes.find(n=>n.type==='KSamplerSelect');
    const sw=options.vue?host(wide).getBoundingClientRect().width/app.canvas.ds.scale:wide._collapsed_width;check('子图折叠宽度',Math.abs(sw-200)<1,{actual:sw});
    wide.collapse();await draw();check('子图展开保留尺寸',wide.size[0]===1600);
    const withSub=app.graph.serialize();await app.loadGraphData(withSub);await draw();const subNode=app.graph._nodes.find(n=>n.subgraph);app.canvas.openSubgraph(subNode.subgraph,subNode);await draw();wide=subNode.subgraph._nodes.find(n=>n.type==='KSamplerSelect');wide.collapse();await draw();const restoredWidth=options.vue?host(wide).getBoundingClientRect().width/app.canvas.ds.scale:wide._collapsed_width;check('子图读档折叠宽度',Math.abs(restoredWidth-200)<1,{actual:restoredWidth});
  } catch(error) { check('运行完整性',false,String(error.stack??error)); }
  finally {await app.loadGraphData(saved.graph);await settings.setSettingValue('Comfy.ColorPalette',saved.palette);await settings.setSettingValue('GuliNodes.enableNodeCollapseButton',saved.collapse);await settings.setSettingValue('GuliNodes.nodeCollapseWidthPadding',saved.width);await mode(saved.vue);}
  const result={options,checks,passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok)};window.__ggNodes2CompatResult=result;return JSON.stringify(result);
})();
