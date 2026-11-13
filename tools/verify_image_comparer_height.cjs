// N张 读档尺寸回归：执行真实扩展与定时队列，不启动浏览器、不依赖第三方包。
// 运行：node tools/verify_image_comparer_height.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pending = [];
const extensions = [];
const app = { canvas: { resizing_node: null }, graph: { setDirtyCanvas() {} }, registerExtension(extension) { extensions.push(extension); } };
const context = vm.createContext({
    app, console, Set, Map, WeakMap, WeakSet, Float64Array,
    isNodes2: () => false,
    isUserResizingNode: node => app.canvas.resizing_node === node,
    fitNodes2Content() {}, watchNodeState() {}, applySurface() {},
    document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: String(text).length * 8 }) }) }) },
    requestAnimationFrame: callback => pending.push(callback),
    setTimeout: callback => pending.push(callback),
});
for (const name of ['gg-node-autofit.js', 'gg-image-comparer.js']) {
    const source = fs.readFileSync(path.join(root, 'web', name), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: name });
}
function flush() {
    let iterations = 0;
    while (pending.length) {
        assert.ok(++iterations < 100, '定时队列没有收敛');
        pending.shift()();
    }
}
class Comparer {
    constructor(connected = 2, userSize = [340, 300]) {
        this.type = this.comfyClass = 'GGImageComparer4';
        this.title = 'GG 图像对比 N张';
        this.size = new Float64Array([340, 990]); // 官方读档期间全部标签可见的临时尺寸
        this.properties = userSize ? { _ggAutoFitUserSize: Array.from(userSize) } : {};
        this.inputs = Array.from({ length: 20 }, (_, i) => ({ name: '图像_' + String.fromCharCode(65 + i), type: 'IMAGE', link: i < connected ? i + 1 : null }));
        this.widgets = Array.from({ length: 5 }, (_, i) => ({ name: '参数_' + i, type: 'number', value: i, hidden: false })).concat(
            Array.from({ length: 20 }, (_, i) => ({ name: '标签_' + String.fromCharCode(65 + i), type: 'text', value: '保留_' + i, hidden: false })));
        this.outputs = [{ name: '对比结果', type: 'IMAGE', links: [21] }];
        this.graph = app.graph;
    }
    computeSize() { return [188, 50 + this.widgets.filter(widget => !widget.hidden).length * 24]; }
    setSize(size) { this.size = new Float64Array(size); this.onResize?.(this.size); }
    removeInput(index) { this.inputs.splice(index, 1); }
    addInput(name, type) { this.inputs.push({ name, type, link: null }); }
    arrange() {}
    _setConcreteSlots() {}
    setDirtyCanvas() {}
}
const checks = [];
function check(name, action) {
    try { action(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: error.message }); }
}
function load(connected, userSize) {
    const node = new Comparer(connected, userSize);
    node.onConfigure({ size: userSize || [340, 218], properties: node.properties });
    for (const extension of extensions) extension.loadedGraphNode?.(node);
    flush();
    return node;
}
(async () => {
    for (const extension of extensions) await extension.beforeRegisterNodeDef?.(Comparer, { name: 'GGImageComparer4' });
    check('手动高度 300px 读档不变成 990px', () => assert.equal(load(2, [340, 300]).size[1], 300));
    check('手动高度 620px 保留且不再增高', () => assert.equal(load(2, [340, 620]).size[1], 620));
    check('默认双图节点按可见内容收高', () => assert.equal(load(2, null).size[1], 218));
    check('没有连接时只留 A 标签与一个空图像槽', () => {
        const node = load(0, null);
        assert.equal(node.size[1], 194);
        assert.deepEqual(node.inputs.map(input => input.name), ['图像_A']);
    });
    check('旧尺寸已经膨胀时仍优先恢复用户副本', () => {
        const node = load(2, [340, 300]);
        node.setSize([340, 1500]);
        context.normalizeComparerInputs(node);
        assert.equal(node.size[1], 300);
    });
    check('连续五轮读档不累积高度', () => {
        for (let i = 0; i < 5; i++) assert.equal(load(2, [340, 300]).size[1], 300);
    });
    check('20 张时允许内容撑高，减回两张恢复用户高度', () => {
        const node = load(20, [340, 300]);
        assert.equal(node.size[1], 650);
        for (const input of node.inputs) if (input.link > 2) input.link = null;
        context.normalizeComparerInputs(node);
        assert.equal(node.size[1], 300);
    });
    check('拖拽期间不抢尺寸，松手后才恢复', () => {
        const node = load(2, [340, 300]);
        node.setSize([340, 500]);
        app.canvas.resizing_node = node;
        context.normalizeComparerInputs(node);
        assert.equal(node.size[1], 500);
        app.canvas.resizing_node = null;
        context.normalizeComparerInputs(node);
        assert.equal(node.size[1], 300);
    });
    check('折叠态保持标题高度', () => {
        const node = load(2, [340, 300]);
        node.flags = { collapsed: true };
        node.setSize([188, 30]);
        context.normalizeComparerInputs(node);
        assert.equal(node.size[1], 30);
    });
    check('用户重新拖小后的副本可继续读档', () => {
        const node = load(2, [340, 620]);
        app.canvas.resizing_node = node;
        node.setSize([240, 260]);
        app.canvas.resizing_node = null;
        assert.deepEqual(Array.from(node.properties._ggAutoFitUserSize), [240, 260]);
        const next = load(2, node.properties._ggAutoFitUserSize);
        assert.deepEqual(Array.from(next.size), [240, 260]);
    });
    check('接线槽下标、输出与隐藏标签的值不变', () => {
        const node = load(2, [340, 300]);
        assert.deepEqual(node.inputs.map(input => [input.name, input.link]), [['图像_A', 1], ['图像_B', 2], ['图像_C', null]]);
        assert.deepEqual(node.outputs, [{ name: '对比结果', type: 'IMAGE', links: [21] }]);
        assert.equal(node.widgets.find(widget => widget.name === '标签_T').value, '保留_19');
    });
    check('普通贴合入口保持原语义，不影响其他节点', () => {
        const node = new Comparer(2, [340, 300]);
        node._ggAutoFitManualSize = [340, 300];
        context.refitAfterContentChange(node);
        assert.equal(node.size[1], 990);
    });
    const result = { passed: checks.filter(item => item.ok).length, total: checks.length, checks };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed === result.total ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
