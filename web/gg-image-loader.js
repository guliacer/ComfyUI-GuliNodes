import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ensureGGDesign, applySurface } from "./gg-ui-design.js";
import { refitAfterContentChange } from "./gg-node-autofit.js";
import {
    CROP_RATIO_PRESETS, CUSTOM_RATIO, MIN_SELECTION,
    parseRatioText, transformedBounds, clampRect, fitCenteredRect,
    constrainDragRect, moveSelection, resizeSelection, inverseSelection,
    hitHandle, rectSize,
} from "./gg-image-crop-geometry.js";

const NODE_NAMES = new Set(["GGImageLoad"]);
const IMAGE_WIDGET = "图像";
const MASK_WIDGET = "遮罩文件";
const PREVIEW_WIDGET = "gg_image_loader_preview";
const ACTIONS_HEIGHT = 34;

function isTarget(node) {
    return NODE_NAMES.has(node?.comfyClass) || NODE_NAMES.has(node?.type);
}

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function setWidgetValue(widget, value) {
    if (!widget) return;
    const options = widget.options?.values;
    if (Array.isArray(options) && value && !options.includes(value)) options.push(value);
    widget.value = value;
    widget.callback?.(value);
}

async function uploadFile(file, type = "input") {
    const body = new FormData();
    body.append("image", file);
    body.append("type", type);
    body.append("overwrite", "false");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(`上传失败：HTTP ${response.status}`);
    return await response.json();
}

function uploadedName(item) {
    const subfolder = item?.subfolder ? `${item.subfolder}/` : "";
    return `${subfolder}${item?.name || item?.filename || ""}`;
}

function chooseFile(accept, callback) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        try { await callback(file); }
        catch (error) { console.error("[GGImageLoad] 操作失败", error); alert(error?.message || "图像操作失败。"); }
    }, { once: true });
    document.body.appendChild(input);
    input.click();
}

// 上传接口返回 {name,...}，而工作流里保存的是 {filename,...}；两种都要认，
// 否则选完图 / 裁完图后 viewUrl 为空，预览停在上张图。
function viewUrl(item) {
    const filename = item?.filename || item?.name;
    if (!filename) return "";
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}${app.getRandParam?.() || ""}`);
}

function createPreview(node) {
    const host = document.createElement("div");
    host.className = "gg-image-loader-preview gg-surface";
    ensureGGDesign();
    applySurface(host);
    Object.assign(host.style, { width: "100%", boxSizing: "border-box", padding: "6px", display: "flex", flexDirection: "column", gap: "6px", overflow: "hidden" });

    const actions = document.createElement("div");
    actions.className = "gg-image-loader-actions";
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;flex:0 0 auto;";
    host.appendChild(actions);

    const image = document.createElement("img");
    image.alt = "图像预览";
    image.style.cssText = "display:block;width:100%;max-height:360px;object-fit:contain;border-radius:6px;background:var(--gg-field);flex:0 0 auto;";
    host.appendChild(image);

    const size = document.createElement("div");
    size.className = "gg-image-loader-size";
    size.style.cssText = "text-align:center;color:var(--gg-muted);font-size:12px;flex:0 0 auto;";
    host.appendChild(size);

    const widget = node.addDOMWidget?.(PREVIEW_WIDGET, "gg_image_loader_preview", host, { serialize: false, hideOnZoom: false });
    if (widget) {
        // addDOMWidget 不会把 options.serialize 落到 widget 上；不显式声明就会被
        // 写进 widgets_values，读档时把图像/遮罩两个控件的值挤错位。
        widget.serialize = false;
        if (widget.options) widget.options.serialize = false;
        widget.computeSize = () => {
            const width = node.size?.[0] || 300;
            const buttons = actions.offsetHeight || ACTIONS_HEIGHT;
            const imageHeight = image.naturalHeight ? Math.min(360, image.clientHeight || 220) : 80;
            return [width, buttons + imageHeight + 24];
        };
    }
    return { host, actions, image, size, widget, node };
}

function actionButton(label, handler) {
    const button = document.createElement("button");
    button.className = "gg-btn gg-image-loader-action";
    button.textContent = label;
    button.style.cssText = "flex:1 1 auto;min-width:64px;padding:4px 6px;white-space:nowrap;";
    // DOM 面板在画布里，不拦下 pointerdown 会被当成拖节点。
    for (const type of ["pointerdown", "mousedown", "dblclick"]) {
        button.addEventListener(type, (event) => event.stopPropagation());
    }
    button.addEventListener("click", (event) => { event.stopPropagation(); Promise.resolve(handler()).catch((error) => { console.error("[GGImageLoad] 操作失败", error); alert(error?.message || "图像操作失败。"); }); });
    return button;
}

function updatePreview(panel, item, width, height) {
    if (!panel || !item) return;
    const url = viewUrl(item);
    if (!url) return;
    if (width && height) panel.size.textContent = `${width} × ${height}`;
    panel.image.onload = () => {
        const naturalWidth = panel.image.naturalWidth;
        const naturalHeight = panel.image.naturalHeight;
        if (naturalWidth && naturalHeight) panel.size.textContent = `${naturalWidth} × ${naturalHeight}`;
        refitAfterContentChange(panel.node);
        panel.node.setDirtyCanvas?.(true, true);
    };
    panel.image.src = url;
}

async function pasteImage(node, panel) {
    if (!navigator.clipboard?.read) throw new Error("当前浏览器不支持读取剪贴板图像，请使用文件上传。");
    const items = await navigator.clipboard.read();
    for (const item of items) {
        const type = item.types.find((value) => value.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const file = new File([blob], `pasted_${Date.now()}.png`, { type });
        const uploaded = await uploadFile(file);
        setWidgetValue(getWidget(node, IMAGE_WIDGET), uploadedName(uploaded));
        updatePreview(panel, uploaded, 0, 0);
        node.setDirtyCanvas?.(true, true);
        return;
    }
    throw new Error("剪贴板中没有图像。");
}

async function uploadMain(node, panel, file) {
    const uploaded = await uploadFile(file);
    setWidgetValue(getWidget(node, IMAGE_WIDGET), uploadedName(uploaded));
    updatePreview(panel, uploaded, 0, 0);
    node.setDirtyCanvas?.(true, true);
}

async function uploadMask(node, file) {
    const uploaded = await uploadFile(file);
    setWidgetValue(getWidget(node, MASK_WIDGET), uploadedName(uploaded));
    node.setDirtyCanvas?.(true, true);
}

function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图像导出失败。")), "image/png"));
}

function cropImage(node, panel) {
    const source = panel?.image?.src;
    if (!source) { alert("请先选择图像。"); return; }

    ensureGGDesign();
    const modal = document.createElement("div");
    modal.className = "gg-image-loader-crop gg-surface gg-popover";
    applySurface(modal);
    // 四个方向分开写：inset 简写在部分前端环境里只落 top/left，弹窗会退化成内容宽。
    Object.assign(modal.style, {
        position: "fixed", top: "5vh", left: "6vw", right: "6vw", bottom: "5vh",
        width: "auto", height: "auto", margin: "0", zIndex: "100001", padding: "12px",
        display: "flex", flexDirection: "column", gap: "8px", minWidth: "320px",
        boxSizing: "border-box",
    });

    const title = document.createElement("div");
    title.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;";
    const titleText = document.createElement("strong");
    titleText.textContent = "图像裁剪";
    const hint = document.createElement("span");
    hint.style.cssText = "color:var(--gg-muted);font-size:12px;flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    hint.textContent = "拖动新建选区 · 拖动内部移动 · 拖动边框 / 四角缩放";
    title.append(titleText, hint);

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:0 0 auto;";
    const ratioSelect = document.createElement("select");
    ratioSelect.className = "gg-field";
    ratioSelect.title = "裁剪比例";
    ratioSelect.style.cssText = "min-width:130px;flex:0 0 auto;";
    for (const preset of CROP_RATIO_PRESETS) {
        const option = document.createElement("option");
        option.textContent = preset.label;
        option.value = String(preset.value);
        ratioSelect.appendChild(option);
    }
    const customOption = document.createElement("option");
    customOption.textContent = "自定义比例";
    customOption.value = String(CUSTOM_RATIO);
    ratioSelect.appendChild(customOption);
    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.className = "gg-field";
    customInput.placeholder = "宽:高";
    customInput.value = "4:3";
    customInput.style.cssText = "display:none;width:72px;flex:0 0 auto;";
    toolbar.append(ratioSelect, customInput);

    const stage = document.createElement("div");
    stage.style.cssText = "flex:1 1 auto;min-height:120px;display:flex;align-items:center;justify-content:center;background:var(--gg-field);border-radius:6px;overflow:hidden;";
    const canvas = document.createElement("canvas");
    // 不用 object-fit：canvas 的布局框必须严格等于位图显示框，
    // 否则 getBoundingClientRect 会带上留白，指针坐标换算成图像像素就会偏。
    canvas.style.cssText = "display:block;flex:0 0 auto;cursor:crosshair;touch-action:none;";
    stage.appendChild(canvas);

    const info = document.createElement("div");
    info.className = "gg-image-loader-crop-info";
    info.style.cssText = "color:var(--gg-muted);font-size:12px;text-align:center;min-height:16px;flex:0 0 auto;";
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex:0 0 auto;";
    const cancel = document.createElement("button");
    cancel.className = "gg-btn";
    cancel.textContent = "取消";
    const apply = document.createElement("button");
    apply.className = "gg-btn is-primary";
    apply.textContent = "应用裁剪";
    footer.append(cancel, apply);
    modal.append(title, toolbar, stage, info, footer);
    document.body.appendChild(modal);

    const original = new Image();
    const state = {
        original, work: null, rect: null, ratio: 0, custom: "4:3", useCustom: false, inverse: false,
        rotation: 0, flipX: false, flipY: false, drag: null, history: [], future: [],
    };
    const bounds = () => state.work ? [state.work.width, state.work.height] : [0, 0];
    const fullRect = () => [0, 0, ...bounds()];

    const snapshot = () => ({
        rect: state.rect && [...state.rect], ratio: state.ratio, custom: state.custom, useCustom: state.useCustom,
        inverse: state.inverse, rotation: state.rotation, flipX: state.flipX, flipY: state.flipY,
    });
    const saveHistory = () => {
        state.history.push(snapshot());
        if (state.history.length > 30) state.history.shift();
        state.future.length = 0;
    };
    const syncControls = () => {
        const preset = CROP_RATIO_PRESETS.find((item) => Math.abs(item.value - state.ratio) < 1e-9);
        ratioSelect.value = state.useCustom ? String(CUSTOM_RATIO) : (preset ? String(preset.value) : "0");
        customInput.style.display = state.useCustom ? "inline-block" : "none";
        customInput.value = state.custom;
        inverseButton.setAttribute("aria-pressed", state.inverse ? "true" : "false");
    };
    const restore = (item) => {
        const beforeRotation = state.rotation;
        const beforeFlip = `${state.flipX}/${state.flipY}`;
        Object.assign(state, { ...item, rect: item.rect && [...item.rect] });
        if (beforeRotation !== state.rotation || beforeFlip !== `${state.flipX}/${state.flipY}`) rebuildWorking();
        syncControls();
        render();
    };

    const rebuildWorking = () => {
        const sourceWidth = original.naturalWidth;
        const sourceHeight = original.naturalHeight;
        if (!sourceWidth || !sourceHeight) return;
        const [width, height] = transformedBounds([sourceWidth, sourceHeight], state.rotation);
        const work = document.createElement("canvas");
        work.width = width;
        work.height = height;
        const ctx = work.getContext("2d");
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.rotate(state.rotation * Math.PI / 180);
        ctx.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1);
        ctx.drawImage(original, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
        ctx.restore();
        state.work = work;
        // 旋转 90/270 换了坐标系，旧选区不再对应同一块画面。
        state.rect = fullRect();
    };

    const fitCanvas = () => {
        const work = state.work;
        if (!work) return;
        const box = stage.getBoundingClientRect();
        const scale = Math.min(box.width / work.width || 1, box.height / work.height || 1, 1);
        canvas.style.width = `${Math.max(1, Math.floor(work.width * scale))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(work.height * scale))}px`;
    };
    const displayScale = () => canvas.clientWidth ? state.work.width / canvas.clientWidth : 1;
    const point = (event) => {
        const box = canvas.getBoundingClientRect();
        return [(event.clientX - box.left) * canvas.width / Math.max(1, box.width),
            (event.clientY - box.top) * canvas.height / Math.max(1, box.height)];
    };
    const render = () => {
        const work = state.work;
        if (!work) return;
        canvas.width = work.width;
        canvas.height = work.height;
        fitCanvas();
        const ctx = canvas.getContext("2d");
        ctx.drawImage(work, 0, 0);
        const rect = clampRect(state.rect || fullRect(), bounds());
        const [x0, y0, x1, y1] = rect;
        const scale = displayScale();
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.52)";
        ctx.beginPath();
        ctx.rect(0, 0, work.width, work.height);
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.fill("evenodd");
        ctx.strokeStyle = "#f5d66b";
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const handleSize = 8 * scale;
        ctx.fillStyle = "#f5d66b";
        for (const [hx, hy] of [[x0, y0], [(x0 + x1) / 2, y0], [x1, y0], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2], [x0, y1], [(x0 + x1) / 2, y1], [x1, y1]]) {
            ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        }
        ctx.restore();
        const [width, height] = rectSize(rect);
        const mode = state.inverse ? ` · 反选（输出整图 ${work.width} × ${work.height}）` : "";
        info.textContent = `选区：${x0.toFixed(0)}, ${y0.toFixed(0)} → ${width} × ${height}${mode}`;
    };

    const makeButton = (label, handler) => {
        const button = document.createElement("button");
        button.className = "gg-btn";
        button.textContent = label;
        button.addEventListener("click", handler);
        toolbar.appendChild(button);
        return button;
    };
    const inverseButton = makeButton("反选", () => {
        saveHistory();
        state.inverse = !state.inverse;
        syncControls();
        render();
    });
    inverseButton.title = "保留整图，用遮罩标出选区之外的区域";
    ratioSelect.addEventListener("change", () => {
        if (ratioSelect.value === String(CUSTOM_RATIO)) {
            state.useCustom = true;
            state.custom = customInput.value;
            state.ratio = parseRatioText(customInput.value);
            if (!state.ratio) alert("比例格式应为 宽:高，例如 4:3。");
        } else {
            state.useCustom = false;
            state.ratio = Number(ratioSelect.value);
        }
        saveHistory();
        state.rect = fitCenteredRect(bounds(), state.ratio);
        syncControls();
        render();
    });
    customInput.addEventListener("change", () => {
        state.useCustom = true;
        state.custom = customInput.value;
        state.ratio = parseRatioText(customInput.value);
        saveHistory();
        state.rect = fitCenteredRect(bounds(), state.ratio);
        syncControls();
        render();
    });

    makeButton("居中", () => { saveHistory(); state.rect = fitCenteredRect(bounds(), state.ratio); render(); });
    makeButton("适应图像", () => { saveHistory(); state.rect = fullRect(); render(); });
    makeButton("旋转 90°", () => { saveHistory(); state.rotation = (state.rotation + 90) % 360; rebuildWorking(); syncControls(); render(); });
    makeButton("水平翻转", () => { saveHistory(); state.flipX = !state.flipX; rebuildWorking(); syncControls(); render(); });
    makeButton("垂直翻转", () => { saveHistory(); state.flipY = !state.flipY; rebuildWorking(); syncControls(); render(); });
    makeButton("撤销", () => { if (!state.history.length) return; state.future.push(snapshot()); restore(state.history.pop()); });
    makeButton("重做", () => { if (!state.future.length) return; state.history.push(snapshot()); restore(state.future.pop()); });
    makeButton("重置", () => {
        saveHistory();
        Object.assign(state, { ratio: 0, custom: "4:3", useCustom: false, inverse: false, rotation: 0, flipX: false, flipY: false });
        rebuildWorking();
        syncControls();
        render();
    });

    canvas.addEventListener("pointerdown", (event) => {
        if (!state.work) return;
        const p = point(event);
        const rect = clampRect(state.rect || fullRect(), bounds());
        const tolerance = 10 * displayScale();
        const handle = hitHandle(rect, p, tolerance);
        const inside = p[0] > rect[0] && p[0] < rect[2] && p[1] > rect[1] && p[1] < rect[3];
        saveHistory();
        state.drag = handle ? { mode: "resize", handle } : inside ? { mode: "move", origin: p, rect: [...rect] } : { mode: "create", origin: p };
        try { canvas.setPointerCapture?.(event.pointerId); } catch { /* 合成事件没有可捕获的指针 */ }
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!state.drag || !state.work) return;
        const p = point(event);
        const { mode } = state.drag;
        if (mode === "create") state.rect = constrainDragRect(state.drag.origin, p, state.ratio, bounds());
        else if (mode === "move") state.rect = moveSelection(state.drag.rect, [p[0] - state.drag.origin[0], p[1] - state.drag.origin[1]], bounds());
        else state.rect = resizeSelection(clampRect(state.rect || fullRect(), bounds()), state.drag.handle, p, state.ratio, bounds());
        render();
    });
    const endDrag = () => { if (!state.drag) return; state.drag = null; render(); };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    const onResize = () => { if (state.work) { fitCanvas(); render(); } };
    window.addEventListener("resize", onResize);
    const close = () => {
        window.removeEventListener("resize", onResize);
        document.removeEventListener("keydown", onKeyDown);
        modal.remove();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") { close(); return; }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) { if (state.future.length) { state.history.push(snapshot()); restore(state.future.pop()); } }
            else if (state.history.length) { state.future.push(snapshot()); restore(state.history.pop()); }
        }
    };
    document.addEventListener("keydown", onKeyDown);
    cancel.addEventListener("click", close);

    apply.addEventListener("click", async () => {
        if (!state.work) return;
        apply.disabled = true;
        try {
            const work = state.work;
            const [width, height] = bounds();
            const rect = clampRect(state.rect || fullRect(), bounds());
            const [cropWidth, cropHeight] = rectSize(rect);
            if (cropWidth < MIN_SELECTION || cropHeight < MIN_SELECTION) { alert("裁剪区域太小，请重新拖出选区。"); return; }

            const out = document.createElement("canvas");
            let mask = null;
            if (state.inverse) {
                const selection = inverseSelection(rect, bounds());
                out.width = work.width;
                out.height = work.height;
                out.getContext("2d").drawImage(work, 0, 0);
                mask = document.createElement("canvas");
                mask.width = work.width;
                mask.height = work.height;
                const maskCtx = mask.getContext("2d");
                maskCtx.fillStyle = "#ffffff";
                maskCtx.fillRect(0, 0, work.width, work.height);
                maskCtx.fillStyle = "#000000";
                const [mx0, my0, mx1, my1] = selection.maskRect;
                maskCtx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
            } else {
                out.width = cropWidth;
                out.height = cropHeight;
                out.getContext("2d").drawImage(work, rect[0], rect[1], cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            }

            const uploaded = await uploadFile(new File([await canvasBlob(out)], `crop_${Date.now()}.png`, { type: "image/png" }));
            if (mask) {
                const uploadedMask = await uploadFile(new File([await canvasBlob(mask)], `crop_mask_${Date.now()}.png`, { type: "image/png" }));
                setWidgetValue(getWidget(node, MASK_WIDGET), uploadedName(uploadedMask));
            }
            setWidgetValue(getWidget(node, IMAGE_WIDGET), uploadedName(uploaded));
            updatePreview(panel, uploaded, out.width, out.height);
            node.setDirtyCanvas?.(true, true);
            close();
        } catch (error) {
            console.error("[GGImageLoad] 应用裁剪失败", error);
            alert(error?.message || "应用裁剪失败。");
        } finally {
            apply.disabled = false;
        }
    });

    original.onload = () => {
        rebuildWorking();
        syncControls();
        render();
    };
    original.src = source;
}

function setupNode(node) {
    if (!isTarget(node)) return;
    // 装过一次就不再重建。判据只看 widget 是否存在 —— 不能用 host.isConnected：
    // addDOMWidget 之后 host 要到下一帧才挂进文档，首帧必然是 false。
    if (node._ggImageLoaderInstalled && node._ggImageLoaderPanel?.widget) return;

    try {
        ensureGGDesign();
        const panel = createPreview(node);
        if (!panel?.widget) {
            // addDOMWidget 未就绪或被前端拒绝：不置位，留给下一次生命周期重试
            panel?.host?.remove?.();
            node._ggImageLoaderPanel = null;
            node._ggImageLoaderInstalled = false;
            return;
        }
        node._ggImageLoaderPanel = panel;
        // 按钮放在 DOM 面板里，不往 node.widgets 里插控件、也不重排 widgets：
        // widgets_values 是按控件下标存的位置数组，插入或换序会让读档错位。
        panel.actions.replaceChildren(
            actionButton("粘贴", () => pasteImage(node, panel)),
            actionButton("蒙版", () => new Promise((resolve, reject) => chooseFile("image/png,image/jpeg,image/webp", (file) => uploadMask(node, file).then(resolve, reject)))),
            actionButton("裁剪", () => cropImage(node, panel)),
            actionButton("选择文件上传", () => new Promise((resolve, reject) => chooseFile("image/*", (file) => uploadMain(node, panel, file).then(resolve, reject)))),
        );
        refitAfterContentChange(node);
        const imageWidget = getWidget(node, IMAGE_WIDGET);
        if (imageWidget?.value) {
            const value = String(imageWidget.value);
            const parts = value.split("/");
            updatePreview(panel, { filename: parts.pop(), subfolder: parts.join("/"), type: "input" }, 0, 0);
        }
        node._ggImageLoaderInstalled = true;
        node.setDirtyCanvas?.(true, true);
    } catch (error) {
        console.error("[GGImageLoad] 面板初始化失败，将在下次生命周期重试", error);
        node._ggImageLoaderInstalled = false;
    }
}

// 挂载兜底：面板建好但没进文档（例如读档时 DOM 层还没就绪）时重试一次。
function ensureMounted(node) {
    if (!isTarget(node)) return;
    const panel = node._ggImageLoaderPanel;
    if (!panel?.widget) {
        setupNode(node);
        return;
    }
    if (panel.host?.isConnected) return;
    if ((node._ggLoaderMountRetry || 0) >= 2) return;
    node._ggLoaderMountRetry = (node._ggLoaderMountRetry || 0) + 1;
    node._ggImageLoaderInstalled = false;
    setupNode(node);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.ImageLoader",
    nodeCreated(node) { setTimeout(() => setupNode(node), 0); },
    loadedGraphNode(node) { setTimeout(() => setupNode(node), 0); },
    // 读档完成后再兜一次：DOM 定位层此时才就绪，面板没挂上就在这里补齐
    async afterConfigureGraph() {
        const nodes = app.graph?._nodes || [];
        for (const node of nodes) {
            if (!isTarget(node)) continue;
            setTimeout(() => setupNode(node), 0);
            requestAnimationFrame(() => ensureMounted(node));
        }
    },
});

// 与 app.ggRepairPortGeometry 同一套风格：留一个幂等入口，现场排查和回归脚本
// 都能在同一节点上重复驱动，不必依赖「再造一个节点」碰运气。
app.ggImageLoader = { setup: setupNode, ensureMounted };
