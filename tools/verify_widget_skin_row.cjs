// 节点控件皮肤行内分段控件紧凑化验证（用户 2026-11-09：三个按钮占比太大、菜单名看不清）：
// 打开 GuliNodes 工具菜单，检查「节点控件皮肤」行：
//   1) 左侧标签完整可读（scrollWidth <= clientWidth，无省略号截断）；
//   2) 标签宽度足够（≥ 70px，6 字中文标签不该被压成「节…」）；
//   3) 右侧三档分段控件整体不溢出菜单（控件右缘 ≤ 菜单右缘内边距）；
//   4) 三档按钮齐全、且恰好一档处于选中（aria-pressed=true）。
// 在宽屏(1600)与窄屏(1000)各验一遍；零脚本异常（排除环境噪音）。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";
const log = (...a) => console.log("[verify]", ...a);

const pollFor = async (page, fn, arg, { timeout = 15000, interval = 250, label = "" } = {}) => {
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

const measureRow = () => {
    const row = document.querySelector('#gg-top-tools-nav .gg-top-tool-entry[data-tool-id="gg-widget-skin-buttons"] .gg-top-tool-row');
    if (!row) return null;
    const label = row.querySelector(".gg-top-tool-row-label");
    const controls = row.querySelector(".gg-top-tool-controls");
    const seg = document.getElementById("gg-widget-skin-buttons");
    const menu = document.getElementById("gg-top-tools-menu");
    if (!label || !controls || !seg || !menu) return null;
    const rl = label.getBoundingClientRect();
    const rc = controls.getBoundingClientRect();
    const rs = seg.getBoundingClientRect();
    const rm = menu.getBoundingClientRect();
    const buttons = Array.from(seg.querySelectorAll(".gg-seg > button"));
    const pressed = buttons.filter((b) => b.getAttribute("aria-pressed") === "true").length;
    return {
        labelText: label.textContent,
        labelTruncated: label.scrollWidth > label.clientWidth + 1,
        labelWidth: Math.round(rl.width),
        labelRight: Math.round(rl.right),
        controlsLeft: Math.round(rc.left),
        segWidth: Math.round(rs.width),
        segRight: Math.round(rs.right),
        menuRight: Math.round(rm.right),
        segOverflow: rs.right > rm.right - 1,
        buttonCount: buttons.length,
        pressedCount: pressed,
        overlap: rl.right > rc.left + 1,
    };
};

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    const isUnrelated = (s) => /404|Failed to load resource|gulips|CSP|ComfyUI-GuliPS|bridge/i.test(s);
    const isKnownJobsApiNoise = (s) => /^\[Jobs API\] Error fetching jobs: ZodError/i.test(s);
    page.on("pageerror", (e) => {
        const text = String(e);
        if (!isKnownJobsApiNoise(text)) errors.push(text);
    });
    page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (!isUnrelated(text) && !isKnownJobsApiNoise(text)) errors.push("console:" + text);
    });

    const results = {};
    try {
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        await pollFor(page, () => document.getElementById("gg-widget-skin-buttons") ? true : null, null, { timeout: 15000, label: "skin-mounted" });
        await page.waitForFunction(() => document.querySelector("#gg-top-tools-button"), null, { timeout: 60000 });

        // ---- WIDE ----
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(700);
        results.wide = await page.evaluate(measureRow);
        log("WIDE row:", JSON.stringify(results.wide));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // ---- NARROW ----
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForTimeout(900);
        await page.click("#gg-top-tools-button");
        await page.waitForTimeout(700);
        results.narrow = await page.evaluate(measureRow);
        log("NARROW row:", JSON.stringify(results.narrow));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        const checks = [];
        for (const [k, r] of Object.entries(results)) {
            if (!r) { checks.push([k, false, "row-not-found"]); continue; }
            checks.push([`${k}:label-text`, r.labelText === "节点控件皮肤", r.labelText]);
            checks.push([`${k}:not-truncated`, !r.labelTruncated, r.labelTruncated]);
            checks.push([`${k}:label-wide`, r.labelWidth >= 70, r.labelWidth]);
            checks.push([`${k}:no-overlap`, !r.overlap, r.overlap]);
            checks.push([`${k}:seg-fit`, !r.segOverflow, r.segOverflow]);
            checks.push([`${k}:three-buttons`, r.buttonCount === 3, r.buttonCount]);
            checks.push([`${k}:one-pressed`, r.pressedCount === 1, r.pressedCount]);
        }
        let pass = errors.length === 0;
        for (const [name, ok, val] of checks) {
            if (!ok) pass = false;
            log(ok ? "  ok " : "  FAIL", name, "=", JSON.stringify(val));
        }
        log(pass ? "WIDGET_SKIN_ROW_OK" : "WIDGET_SKIN_ROW_FAIL");
    } catch (e) {
        log("FATAL", e && e.stack ? e.stack : String(e));
    } finally {
        log("ERRORS:", errors.length ? JSON.stringify(errors) : "none");
        await browser.close();
    }
})();
