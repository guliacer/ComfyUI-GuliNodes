// 设计稿落地专项验收：真机读取 CSS 变量与关键几何，确认 2026-11-08 定稿令牌真的生效。
// 现有 verify_*.cjs 只测布局 / 交互 / 皮肤覆盖，不断言色值与尺寸，所以单列一份。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_design_tokens.cjs
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";

// 与 gg-ui-design.js 的 PALETTES 定稿值同源（设计稿 01/02/07 分节）
const EXPECT = {
  dark: {
    "--gg-canvas": "#0B0E13",
    "--gg-panel": "#131822",
    "--gg-card": "#1A2130",
    "--gg-field": "#0F131B",
    "--gg-divider": "#262F3D",
    "--gg-ink": "#EEF2F8",
    "--gg-muted": "#97A3B6",
    "--gg-faint": "#6B7688",
    "--gg-accent": "#4C8DFF",
    "--gg-picked-border": "#4C8DFF",
    "--gg-ok": "#3DD68C",
    "--gg-warning": "#F5A524",
    "--gg-danger": "#FF6B6B",
  },
  light: {
    "--gg-canvas": "#F1F5FB",
    "--gg-panel": "#F4F7FB",
    "--gg-card": "#FFFFFF",
    "--gg-field": "#FFFFFF",
    "--gg-divider": "#DDE5F0",
    "--gg-ink": "#16202E",
    "--gg-muted": "#4A5A72",
    "--gg-faint": "#6B7A90",
    "--gg-accent": "#2563EB",
    "--gg-picked-border": "#2563EB",
  },
};

const norm = (v) => String(v || "").trim().toLowerCase();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 60000 });
    // 设计层样式表是各扩展按需注入的，等它出现再读，否则全读到空串
    await page.waitForFunction(
      () => !!document.getElementById("gg-design-system"),
      null,
      { timeout: 30000 },
    ).catch(() => {});

    // 设计层有个 2 秒的 syncDocumentTheme 轮询会覆写 data-gg-theme，
    // 所以深浅两套必须在同一次 evaluate 内连续取完，不能跨轮次分两次调用。
    const tokenSnapshot = await page.evaluate((expectByMode) => {
      const root = document.documentElement;
      const original = root.getAttribute("data-gg-theme");
      const out = {};
      for (const [mode, expect] of Object.entries(expectByMode)) {
        root.setAttribute("data-gg-theme", mode);
        const cs = getComputedStyle(root);
        out[mode] = {};
        for (const name of Object.keys(expect)) out[mode][name] = cs.getPropertyValue(name).trim();
      }
      if (original == null) root.removeAttribute("data-gg-theme");
      else root.setAttribute("data-gg-theme", original);
      return out;
    }, EXPECT);

    for (const mode of ["dark", "light"]) {
      const actual = tokenSnapshot[mode] || {};
      for (const [name, want] of Object.entries(EXPECT[mode])) {
        check(`${mode} ${name} = ${want}`, norm(actual[name]) === norm(want), `实际 ${actual[name] || "(空)"}`);
      }
    }

    // 落地口径：主操作实心、次操作幽灵、顶栏 32×32 r8、弹层 r13 / 行 34 r8
    const geometry = await page.evaluate(() => {
      const css = document.getElementById("gg-design-system")?.textContent || "";
      const grab = (selector) => {
        const i = css.indexOf(selector);
        return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
      };
      const menuRow = (() => {
        const el = document.createElement("div");
        el.className = "gg-popover-row";
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.append(el);
        const c = getComputedStyle(el);
        const out = { minHeight: c.minHeight, radius: c.borderTopLeftRadius };
        el.remove();
        return out;
      })();
      const switchBtn = (() => {
        const el = document.createElement("button");
        el.className = "gg-switch";
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.append(el);
        const c = getComputedStyle(el);
        const out = { w: c.width, h: c.height, radius: c.borderTopLeftRadius, bg: c.backgroundColor };
        el.remove();
        return out;
      })();
      const primary = (() => {
        const el = document.createElement("button");
        el.className = "gg-btn is-primary";
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.append(el);
        const c = getComputedStyle(el);
        const out = { bg: c.backgroundColor, color: c.color };
        el.remove();
        return out;
      })();
      const popover = (() => {
        const el = document.createElement("div");
        el.className = "gg-popover";
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.append(el);
        const c = getComputedStyle(el);
        const out = { radius: c.borderTopLeftRadius };
        el.remove();
        return out;
      })();
      return {
        cssPresent: css.length > 0,
        primaryRule: grab(".gg-btn.is-primary {"),
        primary,
        switchBtn,
        popover,
        menuRow,
      };
    });

    check("设计层样式表已注入", geometry.cssPresent);
    check(
      "主操作 = 实心强调色底",
      /background:\s*var\(--gg-accent\)/.test(geometry.primaryRule) && geometry.primary.bg !== "rgba(0, 0, 0, 0)",
      `computed bg=${geometry.primary.bg}`,
    );
    check("主操作文字为白色", norm(geometry.primary.color) === "rgb(255, 255, 255)", `实际 ${geometry.primary.color}`);
    check("顶栏开关 32×32", geometry.switchBtn.w === "32px" && geometry.switchBtn.h === "32px",
      `${geometry.switchBtn.w} × ${geometry.switchBtn.h}`);
    check("顶栏开关圆角 8", geometry.switchBtn.radius === "8px", geometry.switchBtn.radius);
    check("顶栏常态透明底（描边钮、无投影）", /rgba\(0, 0, 0, 0\)|transparent/.test(geometry.switchBtn.bg), geometry.switchBtn.bg);
    check("弹层圆角 13", geometry.popover.radius === "13px", geometry.popover.radius);
    check("菜单行高 34", geometry.menuRow.minHeight === "34px", geometry.menuRow.minHeight);
    check("菜单行圆角 8", geometry.menuRow.radius === "8px", geometry.menuRow.radius);

    check("无本模块脚本异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  } catch (err) {
    check("脚本执行完成", false, String(err).slice(0, 200));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n总结: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log("失败项:");
    for (const f of failed) console.log(`  - ${f.name} :: ${f.detail}`);
    process.exit(1);
  }
})();
