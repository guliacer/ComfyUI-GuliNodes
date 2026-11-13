// 在 ComfyUI 标签页中由 frago browser exec-js 执行本文件。
// 使用真实 DOM 分配验证拖宽、拉高、缩小、换图与读档；不启动浏览器进程。
// 可选 window.__ggImageLoaderTestOptions = { palette: "dark", vue: true }。
(async () => {
    const app = window.app;
    if (!app?.graph || !app.ggImageLoader) throw new Error("请先打开已加载 GuliNodes 的 ComfyUI 页面。");
    if (document.hidden) throw new Error("测试页处于后台，请先激活该标签页再运行。");
    const options = window.__ggImageLoaderTestOptions || {};
    window.__ggImageLoaderResizeResult = null;
    const settings = app.ui.settings;
    const original = {
        graph: app.graph.serialize(),
        palette: settings.getSettingValue("Comfy.ColorPalette"),
        vue: settings.getSettingValue("Comfy.VueNodes.Enabled"),
        scale: app.canvas.ds.scale,
        offset: Array.from(app.canvas.ds.offset),
    };
    const results = [];
    const checks = [];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.__ggImageLoaderResizeProgress = { phase: "准备", checks, cases: results };
    const check = (name, ok, detail) => {
        checks.push({ name, ok: Boolean(ok), detail });
        window.__ggImageLoaderResizeProgress.phase = name;
    };
    const draw = async () => {
        app.canvas.setDirty(true, true);
        app.canvas.draw(true, true);
        await wait(220);
        app.canvas.draw(true, true);
    };
    const resize = async (node, width, height) => {
        app.canvas.resizing_node = node;
        try { node.setSize([width, height]); }
        finally { app.canvas.resizing_node = null; }
        await draw();
    };
    const probe = (node) => {
        const p = node._ggImageLoaderPanel;
        const host = p.host.getBoundingClientRect();
        const viewport = p.viewport.getBoundingClientRect();
        const image = p.image.getBoundingClientRect();
        const actions = p.actions.getBoundingClientRect();
        const footer = p.size.getBoundingClientRect();
        const style = getComputedStyle(p.image);
        const reasons = [];
        if (Math.abs(image.width - viewport.width) > 2 || Math.abs(image.height - viewport.height) > 2) reasons.push("图片没有填满预览容器");
        if (style.objectFit !== "contain") reasons.push("图片未按完整比例显示");
        if (actions.bottom > viewport.top + 1 || viewport.bottom > footer.top + 1) reasons.push("图片与操作栏或尺寸行重叠");
        if (host.bottom - footer.bottom < 4 || host.bottom - footer.bottom > 10) reasons.push("尺寸行没有贴合面板底部");
        if (p.host.scrollHeight > p.host.clientHeight + 2) reasons.push("面板内容被裁切");
        if (p.host.offsetWidth > Number(node.size[0]) + 1) reasons.push("预览面板超出节点宽度");
        if (Number(node.size[1]) - Number(p.widget.y) - Number(p.widget.computedHeight) > 25) reasons.push("节点剩余高度没有分配给预览");
        return {
            node: Array.from(node.size),
            preview: [p.viewport.offsetWidth, p.viewport.offsetHeight],
            image: [p.image.offsetWidth, p.image.offsetHeight],
            natural: [p.image.naturalWidth, p.image.naturalHeight],
            reasons,
        };
    };
    const loadFixture = async (node, width, height) => {
        const p = node._ggImageLoaderPanel;
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="steelblue"/><path d="M0 0L' + width + ' ' + height + 'M' + width + ' 0L0 ' + height + '" stroke="white" stroke-width="8"/></svg>';
        p.image.src = "data:image/svg+xml," + encodeURIComponent(svg);
        await p.image.decode();
        await draw();
    };
    let node;
    try {
        if (options.palette) await settings.setSettingValue("Comfy.ColorPalette", options.palette);
        if (options.vue != null) await settings.setSettingValue("Comfy.VueNodes.Enabled", options.vue);
        await wait(1200);
        app.graph.clear();
        app.canvas.ds.scale = 1;
        app.canvas.ds.offset = [0, 0];
        node = window.LiteGraph.createNode("GGImageLoad");
        node.pos = [100, 140];
        app.graph.add(node);
        await wait(650);
        const p = node._ggImageLoaderPanel;
        const imageWidget = node.widgets.find((item) => item.name === "图像");
        const originalImage = original.graph.nodes.find((item) => item.type === "GGImageLoad")?.widgets_values?.[0];
        if (originalImage) imageWidget.value = originalImage;
        check("原生弹性布局生效", typeof p.widget.computeLayoutSize === "function" && typeof p.widget.computeSize !== "function");
        check("四个操作按钮齐全", [...p.actions.children].map((el) => el.textContent).join("|") === "粘贴|蒙版|裁剪|选择文件上传");
        check("仅有一个预览控件", node.widgets.filter((w) => w.name === "gg_image_loader_preview").length === 1);
        for (const [name, width, height] of [["竖图", 1080, 1621], ["横图", 1600, 900], ["方图", 800, 800]]) {
            await loadFixture(node, width, height);
            for (const [w, h] of [[560, 900], [820, 480], [240, 330], [480, 620], [320, 300]]) {
                await resize(node, w, h);
                const item = probe(node);
                results.push({ name: name + " " + w + "×" + h, ...item });
                check(name + " " + w + "×" + h, item.reasons.length === 0 && item.node[0] === w && item.node[1] === h, item.reasons);
            }
        }
        await loadFixture(node, 1080, 1621);
        await resize(node, 560, 900);
        const large = probe(node);
        check("拉高后预览超过旧 360 像素上限", large.preview[1] > 600, large.preview);
        for (let i = 0; i < 12; i++) node.computeSize();
        await draw();
        check("重复测量不会撑大节点", Number(node.size[1]) === 900 && probe(node).reasons.length === 0, Array.from(node.size));
        p.image.style.maxHeight = "360px";
        await draw();
        check("反向验证能发现固定 360 像素回归", probe(node).reasons.includes("图片没有填满预览容器"));
        p.image.style.removeProperty("max-height");
        await draw();
        check("恢复后预览重新填满", probe(node).reasons.length === 0);
        app.ggImageLoader.setup(node);
        app.ggImageLoader.setup(node);
        check("重复初始化不增生面板", node._ggImageLoaderPanel === p && node.widgets.filter((w) => w.name === "gg_image_loader_preview").length === 1);
        const saved = app.graph.serialize();
        const savedNode = saved.nodes.find((item) => String(item.id) === String(node.id));
        check("预览不污染工作流控件值", savedNode.widgets_values.length === 2, savedNode.widgets_values.length);
        const savedValues = JSON.stringify(savedNode.widgets_values);
        window.__ggImageLoaderResizeProgress.phase = "配置存档";
        app.graph.configure(saved);
        window.__ggImageLoaderResizeProgress.phase = "存档已配置";
        await wait(950);
        node = app.graph._nodes.find((item) => String(item.id) === String(savedNode.id));
        const restoredPanel = node._ggImageLoaderPanel;
        if (restoredPanel.image.getAttribute("src")) await restoredPanel.image.decode();
        await draw();
        const restored = probe(node);
        check("读档保留手动宽高并填满预览", restored.node[0] === 560 && restored.node[1] === 900 && restored.reasons.length === 0, restored);
        check("读档图像与遮罩值没有错位", JSON.stringify(node.serialize().widgets_values) === savedValues);
        node._ggImageLoaderPanel.image.removeAttribute("src");
        await resize(node, 320, 300);
        check("未加载图片时操作栏不被裁切", probe(node).reasons.length === 0);
        return window.__ggImageLoaderResizeResult = {
            ok: checks.every((item) => item.ok),
            palette: settings.getSettingValue("Comfy.ColorPalette"),
            vue: window.LiteGraph.vueNodesMode,
            passed: checks.filter((item) => item.ok).length,
            total: checks.length,
            checks,
            cases: results,
        };
    } catch (error) {
        return window.__ggImageLoaderResizeResult = { ok: false, error: String(error), stack: error.stack, checks, cases: results };
    } finally {
        window.__ggImageLoaderResizeProgress.phase = "恢复原页面";
        await settings.setSettingValue("Comfy.VueNodes.Enabled", original.vue);
        await settings.setSettingValue("Comfy.ColorPalette", original.palette);
        app.graph.configure(original.graph);
        app.canvas.ds.scale = original.scale;
        app.canvas.ds.offset = original.offset;
        await draw();
    }
})();
