// 二级页键盘/边缘用例加固验证（接 verify_subpage_slide 的 SUBPAGE_SLIDE_OK 之后）：
// 1) 焦点陷阱：二级页打开后 Tab / Shift+Tab 永远锁在 #gg-top-tools-subpage 内，不漏到被遮的一级页；
//    且在首尾边界会回环（末→首 / 首→末），证明不是“拦截就跳首/尾”的粗暴实现。
// 2) 焦点回退：用 ‹ 返回 / Esc / ← 收掉二级页后，焦点回到触发齿轮（菜单仍在时）；
//    键盘 Enter 打开路径同样回退到触发控件。
// 3) 尺寸兜底：窄屏二级页开着时把视口拉宽（→宽屏），二级页自动收掉且面板复位到 body，
//    不遗留在已隐藏的菜单 / 二级页 body 里（无孤儿面板）。
// 全程零脚本异常。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";
const log = (...a) => console.log("[verify-subpage-a11y]", ...a);

const GEARS = {
    glow: 'button[aria-label="节点光效设置"]',
    collapse: 'button[aria-label="节点折叠设置"]',
    link: 'button[aria-label="连接线快速设置"]',
};
const PANELS = {
    glow: "gg-node-glow-settings-panel",
    collapse: "gg-node-collapse-settings-panel",
    link: "gg-link-style-panel",
};
const TOOL_IDS = {
    glow: "gg-node-glow-buttons",
    collapse: "gg-node-collapse-button",
    link: "gg-link-style-buttons",
};

const pollFor = async (page, fn, arg, { timeout = 12000, interval = 250, label = "" } = {}) => {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
        last = await page.evaluate(fn, arg).catch(() => null);
        if (last) return last;
        await page.waitForTimeout(interval);
    }
    log("pollFor timeout:", label, "last=", JSON.stringify(last));
    return last;
};

const readSubpage = (page) => page.evaluate((panels) => {
    const sub = document.getElementById("gg-top-tools-subpage");
    const body = document.getElementById("gg-top-tools-subpage-body");
    const menu = document.getElementById("gg-top-tools-menu");
    const out = {
        menuOpen: menu?.dataset.open === "true",
        subpageOpen: sub?.classList.contains("gg-top-tools-subpage-open") || sub?.dataset.open === "true",
        activeInSubpage: body ? body.contains(document.activeElement) : false,
        activeAria: document.activeElement?.getAttribute?.("aria-label") || null,
        activeInNav: !!document.activeElement?.closest?.("#gg-top-tools-nav"),
        activeInTopbar: !!document.activeElement?.closest?.("#gg-top-bar") && !document.activeElement?.closest?.("#gg-top-tools-nav"),
    };
    out.panels = {};
    for (const [k, id] of Object.entries(panels)) {
        const p = document.getElementById(id);
        if (!p) { out.panels[k] = { exists: false }; continue; }
        out.panels[k] = {
            parent: p.parentElement ? (p.parentElement.id || p.parentElement.tagName) : null,
            inSubpageBody: body ? body.contains(p) : false,
            inNav: !!p.closest("#gg-top-tools-nav"),
            inBody: p.parentElement === document.body,
            display: p.style.display,
        };
    }
    return out;
}, PANELS);

// 在二级页里连按 Tab / Shift+Tab n 次，断言两点：
//  (1) alwaysInside：焦点始终在 #gg-top-tools-subpage 内（不漏到被遮的一级页）；
//  (2) cycled：焦点回环（同一节点被再次聚焦），证明边界处真的“绕回”而非停在某处。
// 用节点引用相等判定回环，避免 aria-label 重复造成误判；n 取 40 覆盖绝大多数设置面板。
const tabCycle = async (page, count, shift) => {
    const seen = { alwaysInside: true, cycled: false, count: 0 };
    const visited = new Set();
    for (let i = 0; i < count; i++) {
        await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
        await page.waitForTimeout(40);
        const info = await page.evaluate(() => {
            const sub = document.getElementById("gg-top-tools-subpage");
            const active = document.activeElement;
            return { inside: sub.contains(active), ref: active };
        });
        if (!info.inside) seen.alwaysInside = false;
        if (info.ref) {
            if (visited.has(info.ref)) seen.cycled = true; // 同一节点再次出现 → 回环
            visited.add(info.ref);
        }
        seen.count++;
    }
    return seen;
};

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    const isUnrelated = (s) => /404|Failed to load resource|gulips|CSP|ComfyUI-GuliPS|bridge/i.test(s)
        || /^\[Jobs API\] Error fetching jobs: ZodError/.test(s);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !isUnrelated(m.text())) errors.push("console:" + m.text()); });

    const results = {};
    try {
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        await page.waitForFunction(() => document.querySelector("#gg-top-tools-button"), null, { timeout: 60000 });

        // 切到窄屏，开菜单
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForTimeout(1600);
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(500);
        await pollFor(page, () => document.querySelector('#gg-top-tools-nav button[aria-label="节点光效设置"]') ? true : null,
            null, { timeout: 8000, label: "glow-gear-in-menu" });

        // ===== 焦点陷阱：光效二级页 Tab / Shift+Tab 锁死在内 =====
        log("=== 焦点陷阱（glow 二级页）===");
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(450);
        const opened = await readSubpage(page);
        results.focusTrap_opened = opened.subpageOpen === true && opened.activeInSubpage === true;
        log("glow subpage open:", JSON.stringify({ subpageOpen: opened.subpageOpen, focusInSub: opened.activeInSubpage }));

        const forward = await tabCycle(page, 40, false);
        results.focusTrap_forwardAlwaysInside = forward.alwaysInside;
        results.focusTrap_forwardWrap = forward.cycled; // 回环：同一节点再次出现
        log("Tab forward 40x: alwaysInside=", forward.alwaysInside, "cycled=", forward.cycled);

        const backward = await tabCycle(page, 40, true);
        results.focusTrap_backwardAlwaysInside = backward.alwaysInside;
        results.focusTrap_backwardWrap = backward.cycled;
        log("Shift+Tab 40x: alwaysInside=", backward.alwaysInside, "cycled=", backward.cycled);

        // ===== 焦点回退：‹ 返回 → 焦点回触发齿轮 =====
        log("=== 焦点回退（返回 / Esc / ← / Enter）===");
        // 用返回按钮收
        await page.click("#gg-top-tools-subpage-back");
        await page.waitForTimeout(450);
        const afterBack = await readSubpage(page);
        results.focusReturn_back = afterBack.subpageOpen === false
            && afterBack.activeAria === "节点光效设置"
            && afterBack.activeInNav === true;
        log("after back: subOpen=", afterBack.subpageOpen, "activeAria=", afterBack.activeAria, "inNav=", afterBack.activeInNav);

        // 重开 → Esc 收 → 焦点回触发齿轮
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(450);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(450);
        const afterEsc = await readSubpage(page);
        results.focusReturn_esc = afterEsc.subpageOpen === false
            && afterEsc.activeAria === "节点光效设置"
            && afterEsc.activeInNav === true;
        log("after Esc: subOpen=", afterEsc.subpageOpen, "activeAria=", afterEsc.activeAria, "inNav=", afterEsc.activeInNav);

        // 重开 → ← 收 → 焦点回触发齿轮
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(450);
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(450);
        const afterLeft = await readSubpage(page);
        results.focusReturn_left = afterLeft.subpageOpen === false
            && afterLeft.activeAria === "节点光效设置"
            && afterLeft.activeInNav === true;
        log("after ArrowLeft: subOpen=", afterLeft.subpageOpen, "activeAria=", afterLeft.activeAria, "inNav=", afterLeft.activeInNav);

        // 键盘 Enter 打开路径 → 焦点回退同样命中触发行（行被聚焦），而非跑到隐藏元素
        // 先回到一级页（此时二级页已关），把焦点放到光效行，再 Enter 开
        const rowFocusable = await page.evaluate(() => {
            const row = document.querySelector('#gg-top-tools-nav .gg-top-tool-entry[data-tool-id="gg-node-glow-buttons"] > .gg-top-tool-row');
            if (row) { row.focus(); return true; }
            return false;
        });
        results.keyboardRowFocusable = rowFocusable === true;
        await page.keyboard.press("Enter");
        await page.waitForTimeout(450);
        const afterEnter = await readSubpage(page);
        results.enterOpenedSubpage = afterEnter.subpageOpen === true;
        // 收掉 → 焦点应回到行（或至少不在隐藏元素，回到导航内）
        await page.click("#gg-top-tools-subpage-back");
        await page.waitForTimeout(450);
        const afterEnterClose = await readSubpage(page);
        results.focusReturn_enter = afterEnterClose.subpageOpen === false && afterEnterClose.activeInNav === true;
        log("keyboard Enter open:", afterEnter.subpageOpen, "after close: activeInNav=", afterEnterClose.activeInNav);

        // ===== 尺寸兜底：窄屏二级页开着 → 拉宽 → 自动收 + 面板复位 body =====
        log("=== 尺寸兜底（窄→宽，二级页开着）===");
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(450);
        const beforeResize = await readSubpage(page);
        results.resize_beforeSubpageOpen = beforeResize.subpageOpen === true;
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.waitForTimeout(500); // 等 resize 事件 + applyPrimaryPlacement + 收尾
        const afterResize = await readSubpage(page);
        results.resize_subpageClosed = afterResize.subpageOpen === false;
        results.resize_panelRestored = afterResize.panels.glow.inBody === true
            && afterResize.panels.glow.inSubpageBody === false
            && afterResize.panels.glow.display === "none";
        log("after resize wide: subOpen=", afterResize.subpageOpen, "glow panel=", JSON.stringify(afterResize.panels.glow));

        // ===== 减少动态效果偏好：滑入/滑出改为瞬切，但开关与焦点回退行为不变 =====
        log("=== prefers-reduced-motion 瞬切路径 ===");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForTimeout(1600); // 重新进入窄屏并搬运开关（菜单此前仍开）
        const menuStillOpen = await page.evaluate(() => document.getElementById("gg-top-tools-menu")?.dataset.open === "true");
        if (!menuStillOpen) { await page.click("#gg-top-tools-button"); await page.waitForTimeout(500); }
        await pollFor(page, () => document.querySelector('#gg-top-tools-nav button[aria-label="节点光效设置"]') ? true : null,
            null, { timeout: 8000, label: "rm-glow-gear-in-menu" });
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(250); // 瞬切无需等 180ms 过渡
        const rmOpen = await readSubpage(page);
        results.reducedMotion_open = rmOpen.subpageOpen === true && rmOpen.activeInSubpage === true;
        await page.click("#gg-top-tools-subpage-back");
        await page.waitForTimeout(350); // 关：240ms 兜底复位面板
        const rmClose = await readSubpage(page);
        results.reducedMotion_close = rmClose.subpageOpen === false
            && rmClose.activeAria === "节点光效设置"
            && rmClose.activeInNav === true;
        log("reduced-motion open:", rmOpen.subpageOpen, "close:", rmClose.subpageOpen, "focusAria=", rmClose.activeAria);
    } catch (e) {
        log("FATAL", e && e.stack ? e.stack : String(e));
        results.FATAL = String(e);
    } finally {
        log("ERRORS:", errors.length ? JSON.stringify(errors) : "none");
        const required = [
            "focusTrap_opened",
            "focusTrap_forwardAlwaysInside", "focusTrap_forwardWrap",
            "focusTrap_backwardAlwaysInside", "focusTrap_backwardWrap",
            "focusReturn_back", "focusReturn_esc", "focusReturn_left",
            "keyboardRowFocusable", "enterOpenedSubpage", "focusReturn_enter",
            "resize_beforeSubpageOpen", "resize_subpageClosed", "resize_panelRestored",
            "reducedMotion_open", "reducedMotion_close",
        ];
        const allPass = required.every((k) => results[k] === true) && errors.length === 0;
        log("RESULTS:", JSON.stringify(results));
        log(allPass ? "SUBPAGE_A11Y_OK" : "SUBPAGE_A11Y_FAIL");
        if (!allPass) process.exitCode = 1;
        await browser.close();
    }
})();
