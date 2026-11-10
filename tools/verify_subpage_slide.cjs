// 二级页侧滑验证（设计稿 5 ·03 行三态与二级页 / ·07 统一规格）：
// 1) 宽屏：齿轮在顶栏（菜单关闭）→ 设置面板仍自浮动，不进二级页；
// 2) 窄屏（≤1080，齿轮被吸收进菜单）→ 点齿轮二级页从右滑入，同宽、覆盖一级页；
//    面板真正挂进 #gg-top-tools-subpage-body（不做嵌套浮层），一级页行标记展开，焦点落首个控件；
// 3) 返回 / Esc / ← 都能收掉二级页，面板复位隐藏；
// 4) Esc 优先收二级页、再按才关菜单（subpage-first）；
// 5) 三种带齿轮的入口（光效 / 折叠 / 连接线）都走二级页；
// 6) 全程零脚本异常。
// 用轮询代替固定等待，规避光效组（6s 轮询挂载）与模块加载时序竞态。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";
const log = (...a) => console.log("[verify-subpage]", ...a);

const PRIMARY = [
    "gg-comfy-translate-buttons", "gg-link-style-buttons",
    "gg-node-glow-buttons", "gg-group-styler-button",
];

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
const SUBPAGE_TITLES = {
    glow: "节点光效",
    collapse: "节点折叠",
    link: "连接线",
};
const PANEL_TITLE_SELECTORS = {
    glow: ".gg-node-glow-settings-title",
    collapse: ".gg-collapse-settings-title",
    link: ".gg-link-style-panel-head",
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

const readSubpage = (page) => page.evaluate(({ panels, titleSelectors }) => {
    const sub = document.getElementById("gg-top-tools-subpage");
    const body = document.getElementById("gg-top-tools-subpage-body");
    const menu = document.getElementById("gg-top-tools-menu");
    const out = {
        menuOpen: menu?.dataset.open === "true",
        subpageExists: !!sub,
        subpageOpen: sub?.classList.contains("gg-top-tools-subpage-open") || sub?.dataset.open === "true",
        subpageTransform: sub ? getComputedStyle(sub).transform : null,
        subpageTitle: document.querySelector(".gg-top-tools-subpage-title")?.textContent?.trim() || "",
        subpageSameWidth: !!sub && !!menu && Math.abs(sub.offsetWidth - menu.clientWidth) <= 1,
        subpageHeaderCorrect: (() => {
            const header = document.getElementById("gg-top-tools-subpage-header");
            const title = document.getElementById("gg-top-tools-subpage-title");
            const back = document.getElementById("gg-top-tools-subpage-back");
            if (!header || !title || !back) return false;
            const headerRect = header.getBoundingClientRect();
            const titleRect = title.getBoundingClientRect();
            const backRect = back.getBoundingClientRect();
            return !!header && !!title
                && getComputedStyle(header).display === "flex"
                && getComputedStyle(header).flexDirection === "row"
                && getComputedStyle(header).position === "relative"
                && getComputedStyle(title).position === "absolute"
                && getComputedStyle(title).textAlign === "center"
                && Math.abs((titleRect.left + titleRect.width / 2) - (headerRect.left + headerRect.width / 2)) <= 1
                && titleRect.left >= headerRect.left && titleRect.right <= headerRect.right
                && (titleRect.right <= backRect.left || titleRect.left >= backRect.right);
        })(),
        subpageTitleCenterOffset: (() => {
            const header = document.getElementById("gg-top-tools-subpage-header");
            const title = document.getElementById("gg-top-tools-subpage-title");
            if (!header || !title) return null;
            const h = header.getBoundingClientRect(), t = title.getBoundingClientRect();
            return Math.round((t.left + t.width / 2) - (h.left + h.width / 2));
        })(),
    };
    out.panels = {};
    for (const [k, id] of Object.entries(panels)) {
        const p = document.getElementById(id);
        if (!p) { out.panels[k] = { exists: false }; continue; }
        const r = p.getBoundingClientRect();
        out.panels[k] = {
            exists: true,
            embedded: p.dataset.ggTopDetailPanel === "true",
            inSubpageBody: body ? body.contains(p) : false,
            inMenu: !!p.closest("#gg-top-tools-nav"),
            inBodyDirect: p.parentElement === document.body,
            display: p.style.display,
            visible: r.width > 0 && r.height > 0 && (p.style.display === "block" || getComputedStyle(p).display !== "none"),
            ownTitleVisible: (() => {
                const title = p.querySelector(titleSelectors[k]);
                return !!title && getComputedStyle(title).display !== "none" && title.getClientRects().length > 0;
            })(),
        };
    }
    const nav = document.getElementById("gg-top-tools-nav");
    out.expandedEntry = nav ? (nav.querySelector('.gg-top-tool-entry[data-expanded="true"]')?.dataset.toolId || null) : null;
    out.activeInSubpage = body ? body.contains(document.activeElement) : false;
    return out;
}, { panels: PANELS, titleSelectors: PANEL_TITLE_SELECTORS });

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
        await pollFor(page, (primary) => {
            for (const id of primary) if (!document.getElementById(id)) return null;
            return true;
        }, PRIMARY, { timeout: 12000, label: "groups-mounted" });

        // ===== WIDE：顶栏重构已回退，4 主开关折叠进菜单，顶栏不再常驻 =====
        log("=== WIDE 1600：主开关折叠进菜单，顶栏不常驻 ===");
        await pollFor(page, () => document.getElementById("gg-node-glow-buttons") ? true : null,
            null, { timeout: 8000, label: "glow-group-mounted" });
        await page.click("#gg-top-tools-button");
        await page.waitForFunction(() => document.getElementById("gg-top-tools-menu")?.dataset.open === "true", null, { timeout: 5000 });
        await pollFor(page, () => document.getElementById("gg-node-glow-buttons")?.closest("#gg-top-tools-nav") ? true : null,
            null, { timeout: 8000, label: "wide-glow-in-menu" });
        const wideGlow = await page.evaluate(() => {
            const g = document.getElementById("gg-node-glow-buttons");
            const p = document.getElementById("gg-node-glow-settings-panel");
            return {
                inMenu: !!g?.closest("#gg-top-tools-nav"),
                inTopHost: !!g?.closest("#gg-toolbar-top-switch"),
                panelHidden: !p || p.style.display === "none" || p.dataset.ggTopDetailPanel !== "true",
            };
        });
        // 主开关折叠进菜单（inMenu 且不在顶栏主机位），菜单关闭时面板隐藏、未进二级页
        results.wideGlowInMenu = wideGlow.inMenu === true && wideGlow.inTopHost === false && wideGlow.panelHidden === true;
        log("wide glow group (expect in menu, not top host, panel hidden):", JSON.stringify(wideGlow));
        // 顶栏不常驻：菜单关闭时齿轮不可达（折叠在菜单内），不应弹出浮动/二级页面板
        results.wideGlowClosed = wideGlow.panelHidden === true;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // ===== NARROW：齿轮进菜单 → 二级页侧滑 =====
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForTimeout(1600);
        log("=== NARROW 1000：齿轮进菜单 → 二级页侧滑 ===");
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(500);
        const menuOpen = await page.evaluate(() => document.getElementById("gg-top-tools-menu")?.dataset.open === "true");
        results.menuOpens = menuOpen;
        log("menuOpen:", menuOpen);
        // 等齿轮进入菜单（菜单已开，controls 已渲染）
        await pollFor(page, () => document.querySelector('#gg-top-tools-nav button[aria-label="节点光效设置"]') ? true : null,
            null, { timeout: 8000, label: "glow-gear-in-menu" });

        for (const key of ["glow", "collapse", "link"]) {
            const gearSel = `#gg-top-tools-nav ${GEARS[key]}`;
            await page.click(gearSel, { force: true });
            await page.waitForTimeout(450); // 等 180ms 滑入过渡
            const open = await readSubpage(page);
            const okOpen = open.subpageOpen === true
                && open.subpageTitle === SUBPAGE_TITLES[key]
                && open.subpageSameWidth === true
                && open.subpageHeaderCorrect === true
                && open.panels[key].embedded === true
                && open.panels[key].inSubpageBody === true
                && open.panels[key].visible === true
                && open.panels[key].ownTitleVisible === false
                && open.expandedEntry === TOOL_IDS[key]
                && open.activeInSubpage === true; // 焦点落首个控件
            results[`${key}_open`] = okOpen;
            log(`${key} open:`, JSON.stringify({ subpageOpen: open.subpageOpen, title: open.subpageTitle, sameWidth: open.subpageSameWidth, headerCorrect: open.subpageHeaderCorrect, titleCenterOffset: open.subpageTitleCenterOffset, embedded: open.panels[key].embedded, inBody: open.panels[key].inSubpageBody, visible: open.panels[key].visible, ownTitleVisible: open.panels[key].ownTitleVisible, expanded: open.expandedEntry, focus: open.activeInSubpage }));

            // Esc 收掉二级页（菜单应保持打开）
            await page.keyboard.press("Escape");
            await page.waitForTimeout(450);
            const afterEsc = await readSubpage(page);
            results[`${key}_escClose`] = afterEsc.subpageOpen === false && afterEsc.menuOpen === true;
            log(`${key} after Esc: subpageOpen=`, afterEsc.subpageOpen, "menuOpen=", afterEsc.menuOpen);

            // 再开一次，用返回按钮（‹ 返回）收掉
            await page.click(gearSel, { force: true });
            await page.waitForTimeout(450);
            results[`${key}_reopen`] = (await readSubpage(page)).subpageOpen === true;
            await page.click("#gg-top-tools-subpage-back");
            await page.waitForTimeout(450);
            const afterBack = await readSubpage(page);
            results[`${key}_backClose`] = afterBack.subpageOpen === false;
            log(`${key} after back: subpageOpen=`, afterBack.subpageOpen);

            // ← 收掉（先重开）
            await page.click(gearSel, { force: true });
            await page.waitForTimeout(450);
            await page.keyboard.press("ArrowLeft");
            await page.waitForTimeout(450);
            const afterLeft = await readSubpage(page);
            results[`${key}_leftClose`] = afterLeft.subpageOpen === false;
            log(`${key} after ArrowLeft: subpageOpen=`, afterLeft.subpageOpen);
        }

        // Esc subpage-first：开光效二级页 → 第一次 Esc 只收二级页（菜单仍在）→ 第二次 Esc 关菜单
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`);
        await page.waitForTimeout(450);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(450);
        const firstEsc = await readSubpage(page);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(450);
        const secondEsc = await readSubpage(page);
        results.escSubpageFirst = firstEsc.subpageOpen === false && firstEsc.menuOpen === true
            && secondEsc.subpageOpen === false && secondEsc.menuOpen === false;
        log("esc subpage-first: firstEsc(subOpen,menuOpen)=", firstEsc.subpageOpen, firstEsc.menuOpen, "secondEsc=", secondEsc.menuOpen);

        // ===== MOBILE 375：标题以二级页整体为中心，不偏向返回按钮之后的剩余空间 =====
        await page.setViewportSize({ width: 375, height: 812 });
        await page.waitForTimeout(500);
        await page.click("#gg-top-tools-button");
        await page.waitForFunction(() => document.getElementById("gg-top-tools-menu")?.dataset.open === "true", null, { timeout: 5000 });
        await page.click(`#gg-top-tools-nav ${GEARS.glow}`, { force: true });
        await page.waitForTimeout(450);
        const mobileHeader = await readSubpage(page);
        results.mobileHeaderCentered = mobileHeader.subpageOpen === true
            && mobileHeader.subpageSameWidth === true
            && mobileHeader.subpageHeaderCorrect === true
            && mobileHeader.subpageTitleCenterOffset === 0;
        log("mobile 375 header centered:", JSON.stringify({ title: mobileHeader.subpageTitle, offset: mobileHeader.subpageTitleCenterOffset, correct: mobileHeader.subpageHeaderCorrect }));
    } catch (e) {
        log("FATAL", e && e.stack ? e.stack : String(e));
        results.FATAL = String(e);
    } finally {
        log("ERRORS:", errors.length ? JSON.stringify(errors) : "none");
        const required = ["wideGlowInMenu", "wideGlowClosed", "menuOpens",
            "glow_open", "glow_escClose", "glow_backClose", "glow_leftClose",
            "collapse_open", "collapse_escClose", "collapse_backClose", "collapse_leftClose",
            "link_open", "link_escClose", "link_backClose", "link_leftClose",
            "escSubpageFirst", "mobileHeaderCentered"];
        const allPass = required.every((k) => results[k] === true) && errors.length === 0;
        log("RESULTS:", JSON.stringify(results));
        log(allPass ? "SUBPAGE_SLIDE_OK" : "SUBPAGE_SLIDE_FAIL");
        if (!allPass) process.exitCode = 1;
        await browser.close();
    }
})();
