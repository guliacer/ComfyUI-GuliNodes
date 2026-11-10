// 收尾校验：确认 --gg-ui-press-bg 令牌被注入（按下态主题正确），气泡定位在按钮下方（不被顶边裁切）。
const { chromium } = require("playwright-core");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://127.0.0.1:8188/";

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    try {
        await page.goto(URL, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => window.app && window.app.canvas && window.app.canvas.ds, null, { timeout: 60000 });
        await page.waitForFunction(() => document.querySelector("#gg-top-tools-button") || document.querySelector(".gg-ui-top-button"), null, { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(1500);

        const token = await page.evaluate(() => {
            const v = getComputedStyle(document.documentElement).getPropertyValue("--gg-ui-press-bg").trim();
            return v || "(empty)";
        });
        console.log("[probe] --gg-ui-press-bg on :root =", token);

        // 悬停一个开关，检查气泡定位是否在按钮下方且 top 在视口内
        const pos = await page.evaluate(() => {
            const el = document.querySelector(".gg-node-glow-btn") || document.querySelector(".gg-link-style-btn");
            if (!el) return { missing: true };
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            return null;
        });
        await page.waitForTimeout(260);
        const bubble = await page.evaluate(() => {
            const b = document.querySelector(".gg-top-button-bubble");
            const el = document.querySelector(".gg-node-glow-btn") || document.querySelector(".gg-link-style-btn");
            if (!b || !el) return { missing: true };
            const r = el.getBoundingClientRect();
            const top = parseFloat(b.style.top);
            return { bubbleTop: top, buttonBottom: r.bottom, below: top >= r.bottom, inViewport: top >= 0 && top < window.innerHeight };
        });
        console.log("[probe] bubble position:", JSON.stringify(bubble));

        const ok = token && token !== "(empty)" && pos === null && bubble && bubble.below && bubble.inViewport;
        console.log(ok ? "TOKEN_POS_OK" : "TOKEN_POS_FAIL");
        await browser.close();
        process.exit(ok ? 0 : 1);
    } catch (e) {
        console.log("[probe] FATAL:", e && e.stack || e);
        try { await browser.close(); } catch {}
        process.exit(2);
    }
})();
