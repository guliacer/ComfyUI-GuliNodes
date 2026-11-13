// 验证 GG 多行文本框右下角的字数角标。
// 覆盖：初始 0 字、输入实时更新、空白不计入、emoji 按 1 个字、非 GG 节点不出现。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => window.app?.canvas?.ctx && window.LiteGraph, null, { timeout: 90000 });
    await page.waitForTimeout(1200);

    const data = await page.evaluate(async () => {
      const app = window.app;
      app.graph.clear();
      const text = window.LiteGraph.createNode("GGTextDisplayCopy");
      app.graph.add(text);
      text.pos = [80, 80];
      const plain = window.LiteGraph.createNode("CLIPTextEncode");
      app.graph.add(plain);
      plain.pos = [520, 80];
      const concat = window.LiteGraph.createNode("GGTextConcat");
      app.graph.add(concat);
      concat.pos = [80, 420];
      await new Promise((resolve) => setTimeout(resolve, 900));

      const counters = () => [...document.querySelectorAll(".gg-text-count")].map((el) => ({
        text: el.textContent,
        parentHasTextarea: !!el.parentElement?.querySelector(":scope > textarea"),
        theme: el.dataset.theme,
      }));
      const counterFor = (target) => [...document.querySelectorAll(".gg-text-count")]
        .find((el) => el.parentElement?.querySelector(":scope > textarea") === target) ?? null;

      const textarea = text.widgets.find((widget) => widget.name === "文本").element;
      const initialText = counterFor(textarea)?.textContent ?? null;
      const initialAll = counters();

      textarea.value = "你好，世界\nhello world";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const typedText = counterFor(textarea)?.textContent ?? null;
      const typedAll = counters();

      textarea.value = "😀 一 二";
      await new Promise((resolve) => setTimeout(resolve, 700));
      const programmaticText = counterFor(textarea)?.textContent ?? null;

      const concatBefore = counters().length;
      const concatTextarea = concat.widgets.find((widget) => widget.name === "文本1" && widget.element?.tagName === "TEXTAREA")?.element;
      if (concatTextarea) {
        concatTextarea.value = "abc";
        concatTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const concatAfter = counters().length;

      const plainTextarea = plain.widgets.find((widget) => widget.element?.tagName === "TEXTAREA")?.element;
      return {
        initialText,
        initialAll,
        typedText,
        typedAll,
        programmaticText,
        plainCounters: plainTextarea ? (counterFor(plainTextarea) ? 1 : 0) : -1,
        concatBefore,
        concatAfter,
      };
    });

    check("初始为空时显示「0 字」", data.initialText === "0 字", data.initialText);
    check("计数角标挂在文本框父容器内", data.initialAll.length > 0 && data.initialAll.every((item) => item.parentHasTextarea), data.initialAll);
    check("输入后实时更新（空白不计入）", data.typedText === "15 字", data.typedText);
    check("程序化改值也会同步", data.programmaticText === "3 字", data.programmaticText);
    check("emoji 按 1 个字统计", data.programmaticText === "3 字", data.programmaticText);
    check("非 GG 节点不会出现计数角标", data.plainCounters === 0, { plainCounters: data.plainCounters });
    check("文本拼接新增可见槽位后也带角标", data.concatAfter === data.concatBefore + 1, {
      before: data.concatBefore, after: data.concatAfter,
    });
    check("角标带主题标记", data.typedAll.every((item) => item.theme === "light" || item.theme === "dark"), data.typedAll);
    check("无未捕获页面错误", pageErrors.length === 0, pageErrors.slice(0, 3));
  } finally {
    await browser.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
