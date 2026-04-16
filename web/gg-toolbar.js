import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI.GGNodes.Toolbar",
    async setup() {
        // 创建单个工具栏面板，内部使用上下布局
        const panel = document.createElement("div");
        panel.id = "gg-nodes-panel";
        panel.style.cssText = `
            position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
            background: #ffffff; padding: 8px 12px; border-radius: 12px;
            z-index: 99999; font-size: 13px;
            user-select: none; display: flex; flex-direction: column; gap: 8px;
            border: 1px solid #e0e0e0; cursor: grab; box-shadow: none;
            max-width: 90vw;
            align-items: center;
        `;

        panel.innerHTML = `
            
            <!-- 尺寸调节工具栏 -->
            <div class="main-section" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;">
                <button id="btn-same-width" class="tool-btn" data-tooltip="自动宽度" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 12h8"/></svg>
                </button>
                <button id="btn-same-height" class="tool-btn" data-tooltip="自动高度" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8v8"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-left" class="tool-btn" data-tooltip="最左对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h14"/><path d="M3 18h10"/></svg>
                </button>
                <button id="btn-align-right" class="tool-btn" data-tooltip="最右对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M7 12h14"/><path d="M11 18h10"/></svg>
                </button>
                <button id="btn-align-hcenter" class="tool-btn" data-tooltip="水平居中" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M9 6v12"/><path d="M15 6v12"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-top" class="tool-btn" data-tooltip="最顶对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18"/><path d="M12 3v14"/><path d="M18 3v10"/></svg>
                </button>
                <button id="btn-align-bottom" class="tool-btn" data-tooltip="最底对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21v-18"/><path d="M12 21v-14"/><path d="M18 21v-10"/></svg>
                </button>
                <button id="btn-align-vcenter" class="tool-btn" data-tooltip="垂直居中" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M6 8h12"/><path d="M6 16h12"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-spacing" class="tool-btn" data-tooltip="自动间距" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-fit" class="tool-btn" data-tooltip="自适应尺寸（紧凑）" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M8 8h8v8H8z"/></svg>
                </button>
            </div>
        `;

        document.body.appendChild(panel);

        // 创建迷你图标
        const miniIcon = document.createElement("button");
        miniIcon.id = "gg-nodes-mini";
        miniIcon.style.cssText = `
            position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
            width: 32px; height: 32px; background: #ffffff; border: 1px solid #e0e0e0; 
            border-radius: 6px; color: #555555; cursor: pointer; display: none; 
            align-items: center; justify-content: center; z-index: 99999;
        `;
        miniIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M8 8h8v8H8z"/></svg>`;
        document.body.appendChild(miniIcon);

        const toast = document.createElement("div");
        toast.style.cssText = `
            position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
            padding: 12px 24px; border-radius: 9999px; font-size: 14px; font-weight: 600;
            z-index: 100000; white-space: nowrap; color: #fff; pointer-events: none; display: none; opacity: 0;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        `;
        document.body.appendChild(toast);

        function showToast(msg, type = "error") {
            toast.textContent = msg;
            toast.style.background = type === "error" ? "#ff4444" : "#00cc99";
            toast.style.display = "block";
            toast.style.opacity = "1";
            setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => { toast.style.display = "none"; }, 250); }, 1600);
        }

        const tooltip = document.createElement("div");
        tooltip.style.cssText = `
            position: fixed; background: #333; color: #fff; font-size: 12px; padding: 6px 12px;
            border-radius: 8px; pointer-events: none; z-index: 100001; white-space: nowrap;
            display: none; opacity: 0; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        `;
        document.body.appendChild(tooltip);

        let tooltipTimeout;
        const showTooltip = (e, text) => {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = setTimeout(() => {
                const rect = panel.getBoundingClientRect();
                tooltip.textContent = text;
                tooltip.style.left = `${rect.left + rect.width / 2}px`;
                tooltip.style.top = `${rect.top - 30}px`;
                tooltip.style.transform = "translateX(-50%)";
                tooltip.style.display = "block";
                tooltip.style.opacity = "1";
            }, 150);
        };

        // 为面板添加鼠标悬停事件
        panel.addEventListener("mouseover", e => {
            const btn = e.target.closest(".tool-btn");
            if (btn && btn.dataset.tooltip) showTooltip(e, btn.dataset.tooltip);
        });
        panel.addEventListener("mouseout", () => {
            clearTimeout(tooltipTimeout);
            tooltip.style.opacity = "0";
            setTimeout(() => { tooltip.style.display = "none"; }, 150);
        });

        let lastPosition = { left: "50%", bottom: "30px" };

        const hidePanel = () => {
            lastPosition = { left: panel.style.left, top: panel.style.top, bottom: panel.style.bottom };
            panel.style.display = "none";
            miniIcon.style.display = "flex";
        };

        const showPanel = () => {
            panel.style.display = "flex";
            panel.style.left = lastPosition.left || "50%";
            panel.style.top = lastPosition.top || "auto";
            panel.style.bottom = lastPosition.bottom || "30px";
            panel.style.transform = lastPosition.top ? "none" : "translateX(-50%)";
            miniIcon.style.display = "none";
        };

        // 为面板添加右键菜单事件
        panel.addEventListener("contextmenu", e => { e.preventDefault(); hidePanel(); });
        miniIcon.addEventListener("contextmenu", e => { e.preventDefault(); showPanel(); });

        // 为面板添加拖拽功能
        let isDragging = false, offsetX, offsetY;
        
        panel.addEventListener("mousedown", e => {
            if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panel.style.cursor = "grabbing";
            panel.style.transform = "none";
        });

        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
            panel.style.bottom = "auto";
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                panel.style.cursor = "grab";
                lastPosition = { left: panel.style.left, top: panel.style.top, bottom: "auto" };
                localStorage.setItem("ggNodes_pos", JSON.stringify(lastPosition));
            }
        });

        // 加载保存的位置
        const saved = localStorage.getItem("ggNodes_pos");
        if (saved) {
            try {
                const p = JSON.parse(saved);
                panel.style.left = p.left;
                panel.style.top = p.top;
                panel.style.bottom = "auto";
                panel.style.transform = "none";
            } catch (e) {
                console.error("Failed to load panel position:", e);
            }
        }

        function getSelectedNodes() {
            console.log("尝试获取选中节点:");
            console.log("app对象:", app);
            console.log("app.graph:", app.graph);
            console.log("app.canvas:", app.canvas);
            
            // 尝试从多个来源获取选中节点
            if (app.graph && app.graph.selected_nodes && app.graph.selected_nodes.length > 0) {
                console.log("从app.graph.selected_nodes获取:", app.graph.selected_nodes.length);
                console.log("选中节点详情:", app.graph.selected_nodes);
                return app.graph.selected_nodes;
            }
            
            if (app.canvas && app.canvas.selected_nodes && app.canvas.selected_nodes.length > 0) {
                console.log("从app.canvas.selected_nodes获取:", app.canvas.selected_nodes.length);
                return app.canvas.selected_nodes;
            }
            
            if (app.graph && app.graph._nodes) {
                const selected = app.graph._nodes.filter(n => n.selected);
                console.log("从app.graph._nodes.filter获取:", selected.length);
                if (selected.length > 0) {
                    console.log("选中节点详情:", selected);
                    return selected;
                }
            }
            
            // 尝试其他可能的方式
            if (app.graph && app.graph.getSelection) {
                const selection = app.graph.getSelection();
                console.log("从app.graph.getSelection获取:", selection ? selection.length : 0);
                if (selection && selection.length > 0) {
                    console.log("选中节点详情:", selection);
                    return selection;
                }
            }
            
            // 尝试通过全局变量获取
            if (window.canvas && window.canvas.selected_nodes && window.canvas.selected_nodes.length > 0) {
                console.log("从window.canvas.selected_nodes获取:", window.canvas.selected_nodes.length);
                return window.canvas.selected_nodes;
            }
            
            // 尝试通过LiteGraph的方式获取
            if (window.LiteGraph && window.LiteGraph.getSelectedNodes) {
                const selected = window.LiteGraph.getSelectedNodes();
                console.log("从window.LiteGraph.getSelectedNodes获取:", selected ? selected.length : 0);
                if (selected && selected.length > 0) {
                    console.log("选中节点详情:", selected);
                    return selected;
                }
            }
            
            console.log("未找到选中节点");
            return [];
        }

        document.getElementById("btn-same-width").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            const maxW = Math.max(...nodes.map(n => n.size[0]));
            nodes.forEach(n => n.size[0] = maxW);
            app.graph.setDirtyCanvas(true);
        };

        document.getElementById("btn-same-height").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            const maxH = Math.max(...nodes.map(n => n.size[1]));
            nodes.forEach(n => n.size[1] = maxH);
            app.graph.setDirtyCanvas(true);
        };

        function alignNodes(mode) {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            if (mode === "left") { const ref = Math.min(...nodes.map(n => n.pos[0])); nodes.forEach(n => n.pos[0] = ref); }
            else if (mode === "right") { const ref = Math.max(...nodes.map(n => n.pos[0] + n.size[0])); nodes.forEach(n => n.pos[0] = ref - n.size[0]); }
            else if (mode === "top") { const ref = Math.min(...nodes.map(n => n.pos[1])); nodes.forEach(n => n.pos[1] = ref); }
            else if (mode === "bottom") { const ref = Math.max(...nodes.map(n => n.pos[1] + n.size[1])); nodes.forEach(n => n.pos[1] = ref - n.size[1]); }
            else if (mode === "hcenter") { const centerY = nodes.reduce((sum, n) => sum + n.pos[1] + n.size[1]/2, 0) / nodes.length; nodes.forEach(n => n.pos[1] = centerY - n.size[1]/2); }
            else if (mode === "vcenter") { const centerX = nodes.reduce((sum, n) => sum + n.pos[0] + n.size[0]/2, 0) / nodes.length; nodes.forEach(n => n.pos[0] = centerX - n.size[0]/2); }
            app.graph.setDirtyCanvas(true);
        }

        document.getElementById("btn-align-left").onclick = () => alignNodes("left");
        document.getElementById("btn-align-right").onclick = () => alignNodes("right");
        document.getElementById("btn-align-hcenter").onclick = () => alignNodes("hcenter");
        document.getElementById("btn-align-top").onclick = () => alignNodes("top");
        document.getElementById("btn-align-bottom").onclick = () => alignNodes("bottom");
        document.getElementById("btn-align-vcenter").onclick = () => alignNodes("vcenter");

        document.getElementById("btn-auto-spacing").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 3) return showToast("请至少选中3个节点", "error");
            const isVertical = Math.abs(nodes[1].pos[1] - nodes[0].pos[1]) > Math.abs(nodes[1].pos[0] - nodes[0].pos[0]);
            nodes.sort((a, b) => isVertical ? a.pos[1] - b.pos[1] : a.pos[0] - b.pos[0]);
            const gap = isVertical ? nodes[1].pos[1] - (nodes[0].pos[1] + nodes[0].size[1]) : nodes[1].pos[0] - (nodes[0].pos[0] + nodes[0].size[0]);
            let current = isVertical ? nodes[0].pos[1] + nodes[0].size[1] : nodes[0].pos[0] + nodes[0].size[0];
            for (let i = 1; i < nodes.length; i++) {
                if (isVertical) { current += gap; nodes[i].pos[1] = current; current += nodes[i].size[1]; }
                else { current += gap; nodes[i].pos[0] = current; current += nodes[i].size[0]; }
            }
            app.graph.setDirtyCanvas(true);
        };

        document.getElementById("btn-auto-fit").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length === 0) return showToast("请至少选中1个节点", "error");
            nodes.forEach(n => n.size = [210, n.size[1]]);
            app.graph.setDirtyCanvas(true);
        };

        // 迷你图标点击事件
        miniIcon.onclick = showPanel;

        // 点击外部区域不关闭面板，避免误操作
        // document.addEventListener('click', (e) => {
        //     if (!panel.contains(e.target) && e.target !== miniIcon) {
        //         hidePanel();
        //     }
        // });
    }
});