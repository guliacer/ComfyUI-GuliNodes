// 顶栏主开关折叠验证（用户 2026-11-09 要求回退到重构前口径）：
// 4 枚主开关（翻译 / 连接线 / 光效 / 分组）无论宽屏/窄屏都收进 GuliNodes 工具菜单（折叠在内），顶栏不再常驻；
// 菜单在两种宽度下都显示全部 11 项（4 主开关 + 其余 7 项），顶栏 GuliNodes 簇只留入口 + 迷你开关；
// 光效开关切换状态点正常；零脚本异常。
// 用轮询代替固定等待，规避光效组（6s 轮询挂载）与模块加载时序竞态。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";
const log = (...a) => console.log("[verify]", ...a);

const PRIMARY = [
    "gg-comfy-translate-buttons", "gg-link-style-buttons",
    "gg-node-glow-buttons", "gg-group-styler-button",
];

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

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    let checksPassed = false;
    const isUnrelated = (s) => /404|Failed to load resource|gulips|CSP|ComfyUI-GuliPS|bridge/i.test(s);
    const isKnownJobsApiNoise = (s) => /^\[Jobs API\] Error fetching jobs: ZodError/.test(s);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
        if (m.type() === "error" && !isUnrelated(m.text()) && !isKnownJobsApiNoise(m.text())) {
            errors.push("console:" + m.text());
        }
    });

    const checkPrimaryLoc = () => page.evaluate((primary) => {
        const res = {};
        for (const id of primary) {
            const el = document.getElementById(id);
            if (!el) { res[id] = "absent"; continue; }
            res[id] = {
                inTopHost: !!el.closest("#gg-toolbar-top-switch"),
                inMenu: !!el.closest("#gg-top-tools-nav"),
            };
        }
        return res;
    }, PRIMARY);

    const menuVisibleRowCount = () => page.evaluate(() => {
        const nav = document.getElementById("gg-top-tools-nav");
        if (!nav) return -1;
        return Array.from(nav.querySelectorAll(".gg-top-tool-entry"))
            .filter((e) => !e.hidden).length;
    });

    try {
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        await page.waitForFunction(() => document.querySelector("#gg-top-tools-button"), null, { timeout: 60000 });
        await pollFor(page, (primary) => primary.every((id) => document.getElementById(id)) ? true : null,
            PRIMARY, { timeout: 12000, label: "primary-mounted" });

        // ---- WIDE ----
        log("=== WIDE 1600：4 主开关应收进菜单，不进顶栏 ===");
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(600);
        const wideLoc = await checkPrimaryLoc();
        log("primary loc (wide):", JSON.stringify(wideLoc));
        const wideInMenu = PRIMARY.filter((id) => wideLoc[id] && wideLoc[id].inMenu);
        const wideInTop = PRIMARY.filter((id) => wideLoc[id] && wideLoc[id].inTopHost);
        const wideMenuRows = await menuVisibleRowCount();
        log("wide menu visible rows (expect 11):", wideMenuRows);

        // 宽屏：光效开关切换 + 状态点（菜单开着）
        const beforeState = await page.$eval("#gg-node-glow-buttons .gg-node-glow-btn", (el) => el.classList.contains("gg-state-on")).catch(() => null);
        await page.click("#gg-node-glow-buttons .gg-node-glow-btn");
        await page.waitForTimeout(300);
        const afterState = await page.$eval("#gg-node-glow-buttons .gg-node-glow-btn", (el) => el.classList.contains("gg-state-on")).catch(() => null);
        log("glow toggle before/after gg-state-on:", beforeState, afterState);
        if (beforeState !== afterState) { await page.click("#gg-node-glow-buttons .gg-node-glow-btn"); await page.waitForTimeout(200); }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // ---- NARROW ----
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForTimeout(900);
        log("=== NARROW 1000：4 主开关同样在菜单内 ===");
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(600);
        const narrowLoc = await checkPrimaryLoc();
        log("primary loc (narrow):", JSON.stringify(narrowLoc));
        const narrowInMenu = PRIMARY.filter((id) => narrowLoc[id] && narrowLoc[id].inMenu);
        const narrowInTop = PRIMARY.filter((id) => narrowLoc[id] && narrowLoc[id].inTopHost);
        const narrowMenuRows = await menuVisibleRowCount();
        log("narrow menu visible rows (expect 11):", narrowMenuRows);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        const pass = wideInMenu.length === 4 && wideInTop.length === 0 && wideMenuRows === 11
            && narrowInMenu.length === 4 && narrowInTop.length === 0 && narrowMenuRows === 11
            && beforeState !== null && afterState !== null && beforeState !== afterState;
        checksPassed = pass;
        if (!pass) {
            log("detail:", JSON.stringify({ wideInMenu: wideInMenu.length, wideInTop: wideInTop.length, wideMenuRows, narrowInMenu: narrowInMenu.length, narrowInTop: narrowInTop.length, narrowMenuRows, beforeState, afterState }));
        }
    } catch (e) {
        log("FATAL", e && e.stack ? e.stack : String(e));
        errors.push("FATAL:" + String(e));
    } finally {
        log("ERRORS:", errors.length ? JSON.stringify(errors) : "none");
        const allPass = checksPassed && errors.length === 0;
        log(allPass ? "TOPBAR_REFACTOR_OK" : "TOPBAR_REFACTOR_FAIL");
        if (!allPass) process.exitCode = 1;
        await browser.close();
    }
})();
