// 验证 GG 执行错误显示扩展：注册、设置、drawNode 包装、事件链路。
// 打开专用标签验证，不碰用户已打开的页面。
const tab = await rsf.open('http://127.0.0.1:8188');

let ready = false;
for (let i = 0; i < 60; i++) {
    try {
        ready = await tab.eval('!!(window.app?.graph && app.extensions?.length > 0)');
        if (ready === true) break;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
}
if (ready !== true) throw new Error('ComfyUI 前端初始化超时');

const result = await tab.eval(async () => {
    const app = window.app || window.comfyAPI?.app?.app;
    if (!app) throw new Error('ComfyUI app 未准备好');
    const out = {};
    out.extensionRegistered = app.extensions?.some(e => e.name === 'ComfyUI.GGNodes.executionError') ?? false;
    out.settingValue = app.ui?.settings?.getSettingValue?.('GuliNodes.nodeError.enabled', null);
    out.prototypePatched = !!globalThis.LGraphCanvas?.prototype?._ggExecErrorDrawNodePatched;

    const node = app.graph._nodes.find(n => n.type === 'GGRegionEditPrepare') || app.graph._nodes[0];
    if (!node) throw new Error('图中没有节点可验证');
    out.nodeType = node.type;

    const msg = '人像遮罩全部为黑色（有效区域 0.00%），人物选区没有涂上或没有保存成功；请右键加载图像进入遮罩编辑器涂选人物（白色）并保存。';
    app.api.dispatchEvent(new CustomEvent('execution_error', {
        detail: { node_id: node.id, node_type: node.type, exception_message: msg },
    }));
    await new Promise(r => setTimeout(r, 300));
    out.errorMarked = node._ggExecErrorMsg === msg;

    app.api.dispatchEvent(new CustomEvent('execution_start', { detail: { prompt_id: 'gg-verify' } }));
    await new Promise(r => setTimeout(r, 300));
    out.startCleared = node._ggExecErrorMsg === undefined;
    return out;
});

return { tabId: tab.id, result };
