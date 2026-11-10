// 验证 ·08 设计意图：窄屏下 4 枚主开关经 GuliNodes 菜单可达且菜单不超出视口。
// 设计稿原话「≤1080px 收 4 枚开关 into ⋯」——实际架构把所有开关收进 GuliNodes 菜单，
// 顶栏始终保持干净；本脚本确认窄屏下菜单可开、4 开关可见可点、菜单右缘不超出视口。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";
const log = (...a) => console.log("[verify]", ...a);

const PRIMARY = [
    "gg-comfy-translate-buttons",
    "gg-link-style-buttons",
    "gg-node-glow-buttons",
    "gg-group-styler-button",
];

(async () => {
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    let checksPassed = false;
    const isUnrelated = (s) => /404|Failed to load resource|gulips|CSP|ComfyUI-GuliPS|bridge/i.test(s)
        || /^\[Jobs API\] Error fetching jobs: ZodError/.test(s);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !isUnrelated(m.text())) errors.push("console:" + m.text()); });

    try {
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        await page.waitForFunction(
            () => document.querySelector("#gg-top-tools-button"),
            null, { timeout: 60000 },
        ).catch(() => log("warn: entry button missing"));
        await page.waitForTimeout(2000);

        // 打开 GuliNodes 菜单
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(700);

        const result = await page.evaluate((primary) => {
            const nav = document.getElementById("gg-top-tools-nav");
            const menu = document.getElementById("gg-top-tools-menu");
            if (!nav || !menu) return { ok: false, reason: "menu/nav missing" };
            const navRect = nav.getBoundingClientRect();
            const menuOpen = menu.dataset.open === "true";
            const visible = nav.offsetParent !== null;
            const found = {};
            for (const id of primary) {
                const el = document.getElementById(id);
                const btn = el ? el.querySelector(".gg-ui-top-button") : null;
                found[id] = {
                    inNav: !!el && !!el.closest("#gg-top-tools-nav"),
                    hasToggle: !!btn,
                    toggleVisible: !!btn && btn.offsetParent !== null,
                };
            }
            return {
                ok: true,
                menuOpen,
                navVisible: visible,
                navRight: Math.round(navRect.right),
                navLeft: Math.round(navRect.left),
                viewportWidth: window.innerWidth,
                fitsViewport: navRect.right <= window.innerWidth + 1 && navRect.left >= -1,
                found,
            };
        }, PRIMARY);

        log(JSON.stringify(result, null, 2));

        // 反向验证：关掉菜单后顶部栏（topSwitch）不含 4 开关（证明它们本就在菜单里，不占顶栏）
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        const topbarStillClean = await page.evaluate((primary) => {
            const topSwitch = document.getElementById("gg-toolbar-top-switch");
            if (!topSwitch) return true;
            return !primary.some((id) => document.getElementById(id)?.closest("#gg-toolbar-top-switch"));
        }, PRIMARY);
        log("topbar clean after close:", topbarStillClean);

        const pass = result.ok && result.menuOpen && result.navVisible && result.fitsViewport
            && Object.values(result.found).every((f) => f.inNav && f.hasToggle && f.toggleVisible)
            && topbarStillClean;
        checksPassed = pass;
    } catch (e) {
        log("FATAL", e && e.stack ? e.stack : String(e));
        errors.push("FATAL:" + String(e));
    } finally {
        log("ERRORS:", errors.length ? JSON.stringify(errors) : "none");
        const allPass = checksPassed && errors.length === 0;
        log(allPass ? "NARROW_MENU_OK" : "NARROW_MENU_FAIL");
        if (!allPass) process.exitCode = 1;
        await browser.close();
    }
})();
