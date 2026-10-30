import fs from 'node:fs/promises';

const workflow = JSON.parse(await fs.readFile('examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json', 'utf8'));
const definitions = JSON.parse(await fs.readFile('tools/region_edit_schema_snapshot.json', 'utf8'));
const tab = await rsf.tab('t1');
const result = await tab.eval(async ({workflow, regionDef}) => {
    const app = window.app || window.comfyAPI?.app?.app;
    if (!app) throw new Error('ComfyUI app 未准备好');
    // 只在自用标签注册待重启的新节点定义，验证真实前端序列化；不改变后端注册。
    const def = {...regionDef, name: 'GGRegionEditPrepare', category: 'GuliNodes/图像', description: '分区编辑准备验证', output_is_list: [false,false,false,false,false], output_node: false};
    await app.registerNodeDef('GGRegionEditPrepare', def);
    app.queuePrompt = async () => { throw new Error('验证标签不允许排队生图'); };
    await app.loadGraphData(workflow, true, false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const prompt = await app.graphToPrompt();
    const output = prompt.output;
    const errors = [];
    for (const id of ['11','31']) {
        const p = output[id]?.inputs || {};
        for (const key of ['输出尺寸.宽度','输出尺寸.高度']) if (p[key] !== 768) errors.push(`${id}.${key}=${JSON.stringify(p[key])}`);
        if (p['输出尺寸'] !== '按宽高') errors.push(`${id}.输出尺寸=${JSON.stringify(p['输出尺寸'])}`);
        if (p['扩展方式.扩展系数'] !== 1.1) errors.push(`${id}.扩展系数=${JSON.stringify(p['扩展方式.扩展系数'])}`);
    }
    for (const [id,src] of [['15','11'],['35','31']]) {
        const input = output[id]?.inputs?.['图像.图像1'];
        if (JSON.stringify(input) !== JSON.stringify([src,1])) errors.push(`${id}.图像引用=${JSON.stringify(input)}`);
    }
    for (const id of ['10','30']) if (!output[id]?.inputs?.编辑需求) errors.push(`${id}.编辑需求缺失`);
    for (const id of ['18','38']) {
        const p=output[id]?.inputs;
        if (p?.cfg !== 1 || p?.steps !== 9) errors.push(`${id}.采样参数错误`);
    }
    return {errors, nodes:app.graph._nodes.length, apiNodes:Object.keys(output).length, output,
      crops:['11','31'].map(id=>({id,inputs:output[id]?.inputs,widgets:app.graph.getNodeById(Number(id))?.widgets?.map(w=>({name:w.name,value:w.value}))}))};
}, {workflow,regionDef:definitions.GGRegionEditPrepare});
await fs.writeFile('tools/region_edit_browser_validation.json', JSON.stringify(result,null,2),'utf8');
return {errors:result.errors,nodes:result.nodes,apiNodes:result.apiNodes,crops:result.crops};
