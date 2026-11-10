// 实时探针：在 8402 的 ComfyUI 上重载页面，悬停各顶栏按钮，校验状态气泡 + 抑制原生 title。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";

const CANDIDATES = [
    "#gg-top-tools-button",
    ".gg-node-glow-btn",
    ".gg-link-style-btn",
    ".gg-group-styler-btn",
    ".gg-comfy-translate-btn",
    ".gg-port-list-top-button",
    ".gg-node-align-top-button",
    ".gg-node-plugin-name-top-button",
];

const log = (...a) => console.log("[probe]", ...a);

(async () => {
    log("launching browser");
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    const isUnrelated = (s) => /404|Failed to load resource|gulips|CSP|ComfyUI-GuliPS|bridge/i.test(s);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !isUnrelated(m.text())) errors.push("console:" + m.text()); });

    try {
        log("goto");
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        log("waiting for app");
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        log("waiting for top buttons");
        await page.waitForFunction(
            () => document.querySelector("#gg-top-tools-button") || document.querySelector(".gg-ui-top-button"),
            null, { timeout: 60000 },
        ).catch(() => log("warn: top button selector timeout"));
        await page.waitForTimeout(1500);

        const present = await page.evaluate((cands) => cands.filter((sel) => document.querySelector(sel)), CANDIDATES);
        log("present selectors:", JSON.stringify(present));

        const findings = [];
        for (const sel of present) {
            const beforeTitle = await page.$eval(sel, (el) => el.title).catch(() => "");
            const dispatchErr = await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (!el) return "missing";
                el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
                return "";
            }, sel).catch((e) => "eval:" + e);
            if (dispatchErr) { findings.push({ sel, error: dispatchErr }); continue; }
            await page.waitForTimeout(260); // > BUBBLE_DELAY(120) + 余量
            const data = await page.evaluate(() => {
                const b = document.querySelector(".gg-top-button-bubble");
                return { shown: !!(b && b.dataset.show === "true"), text: b ? b.textContent : "", top: b ? b.style.top : "" };
            });
            const afterTitle = await page.$eval(sel, (el) => el.title).catch(() => "");
            await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (el) el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
            }, sel);
            await page.waitForTimeout(200);
            const restoredTitle = await page.$eval(sel, (el) => el.title).catch(() => "");
            findings.push({
                sel,
                beforeTitle,
                bubbleShown: data.shown,
                bubbleText: data.text,
                titleSuppressed: afterTitle === "",
                titleRestored: restoredTitle === beforeTitle,
            });
            log("  " + sel + " => " + JSON.stringify({ shown: data.shown, text: data.text, suppressed: afterTitle === "", restored: restoredTitle === beforeTitle }));
        }

        const cssChecks = await page.evaluate(() => {
            const out = { focusRing: false, pressBg: false, bubbleStyle: false };
            for (const sheet of Array.from(document.styleSheets)) {
                let rules; try { rules = sheet.cssRules; } catch { continue; }
                if (!rules) continue;
                for (const r of rules) {
                    const t = r.cssText || "";
                    if (/gg-ui-top-button:focus-visible/.test(t) && /outline:\s*2px/.test(t)) out.focusRing = true;
                    if (/gg-ui-top-button:active/.test(t) && /--gg-ui-press-bg/.test(t)) out.pressBg = true;
                    if (/gg-top-button-bubble/.test(t)) out.bubbleStyle = true;
                }
            }
            return out;
        });
        log("CSS:", JSON.stringify(cssChecks));

        const ok = findings.length > 0
            && findings.every((f) => f.bubbleShown && f.titleSuppressed && f.titleRestored)
            && cssChecks.focusRing && cssChecks.pressBg && cssChecks.bubbleStyle
            && errors.length === 0;
        log("ERRORS:", errors.length ? JSON.stringify(errors.slice(0, 10)) : "none");
        log(ok ? "PROBE_OK" : "PROBE_FAIL");
        await browser.close();
        process.exit(ok ? 0 : 1);
    } catch (e) {
        log("FATAL:", e && e.stack || e);
        try { await browser.close(); } catch {}
        process.exit(2);
    }
})();
