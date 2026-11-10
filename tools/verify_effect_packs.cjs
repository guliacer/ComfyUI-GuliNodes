// 效果补充包专项验收：5 种新连线 + 1 种新光效 + 8 套配方 + 卸载回退。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/verify_effect_packs.cjs
//
// 关键判据：每种效果都要用 mock canvas ctx 真正跑一遍绘制，记录绘制调用数，
// 不能只看「注册进数组了」——那只证明挂载，不证明画得出东西。
const { chromium } = require("playwright-core");

const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const LINK_NAMES = [
  "数据雨", "光斑串", "光点队列", "扫描带", "光栅栈",
];
const GLOW_NAMES = ["heartbeat"];
const AVAILABLE_GLOW_NAMES = ["stardust", "rainbow", "musicNote", "cosmicDust", "heart", ...GLOW_NAMES];
const REMOVED_LINK_NAMES = ["声波", "电弧链", "光纤束", "液态光", "神经脉冲", "磁力线", "丝带", "闪电", "流星", "激光", "虚空"];
const REMOVED_GLOW_NAMES = ["fireflies", "spark", "nebula", "sweep", "aurora", "prism", "matrix"];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const pageErrors = [];
  const moduleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/gulips\.bridge|report-only|vite:preloadError|Failed to load resource/i.test(t)) return;
    if (/style-pack|glow-pack|gg-node-glow|gg-link-style/i.test(t)) moduleErrors.push(t);
  });

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
    await page.waitForTimeout(4000);

    const state = await page.evaluate(async ({ linkNames, glowNames, removedLinkNames, removedGlowNames }) => {
      const link = await import("/extensions/ComfyUI-GuliNodes/gg-link-style.js");
      const glow = await import("/extensions/ComfyUI-GuliNodes/gg-node-glow.js");
      const pack = await import("/extensions/ComfyUI-GuliNodes/gg-node-glow-pack.js");
      const readSetting = (id) => {
        try {
          const value = app.extensionManager?.setting?.get?.(id);
          return value === undefined ? app.ui?.settings?.getSettingValue?.(id, undefined) : value;
        } catch { return undefined; }
      };
      const writeSetting = async (id, value) => {
        if (app.extensionManager?.setting?.set) return app.extensionManager.setting.set(id, value);
        app.ui?.settings?.setSettingValue?.(id, value);
      };
      const settingIds = [
        "GuliNodes.nodeGlow.mode", "GuliNodes.nodeGlow.effectPool",
        "GuliNodes.linkStyle.dashStyle", "GuliNodes.linkStyle.colorMode",
        "GuliNodes.linkStyle.customColor", "GuliNodes.enableLinkStylePack",
        "GuliNodes.enableNodeGlowPack",
      ];
      const originalSettings = new Map(settingIds.map((id) => [id, readSetting(id)]));

      // ---- mock ctx：记录所有绘制调用，遇到非法数值直接抛 ----
      const mkCtx = () => {
        const calls = { stroke: 0, fill: 0, arc: 0, moveTo: 0, lineTo: 0, badNumbers: 0 };
        const guard = (...vals) => {
          for (const v of vals) if (typeof v === "number" && !Number.isFinite(v)) calls.badNumbers += 1;
        };
        const ctx = {
          globalAlpha: 1, strokeStyle: "", fillStyle: "", lineWidth: 1, shadowBlur: 0,
          lineCap: "", lineJoin: "", globalCompositeOperation: "source-over",
          save() {}, restore() {}, beginPath() {}, closePath() {},
          setLineDash() {}, clip() {}, rect() {},
          moveTo(x, y) { guard(x, y); calls.moveTo += 1; },
          lineTo(x, y) { guard(x, y); calls.lineTo += 1; },
          quadraticCurveTo(...v) { guard(...v); },
          bezierCurveTo(...v) { guard(...v); },
          arc(...v) { guard(...v); calls.arc += 1; },
          ellipse(...v) { guard(...v); },
          stroke() { calls.stroke += 1; },
          fill() { calls.fill += 1; },
          fillRect(...v) { guard(...v); calls.fill += 1; },
          translate(...v) { guard(...v); }, rotate(...v) { guard(...v); },
          createLinearGradient() { return { addColorStop() {} }; },
        };
        return { ctx, calls };
      };

      // ---- 5 种新连线：逐个真跑绘制 ----
      const cfg = {
        opacity: 0.8, lineWidth: 2.5, pathStyle: "曲线", speed: 1.5,
        glow: false, scale: 1, dashStyle: "",
      };
      const linkDraw = {};
      for (const name of linkNames) {
        const drawer = link.EXTRA_DASH_DRAWERS.get(name);
        if (!drawer) { linkDraw[name] = { missing: true }; continue; }
        const { ctx, calls } = mkCtx();
        try {
          drawer(ctx, [0, 0], [220, 90], "#4C8DFF", { ...cfg, dashStyle: name }, null);
          linkDraw[name] = { ...calls, threw: false };
        } catch (e) {
          linkDraw[name] = { ...calls, threw: String(e) };
        }
      }

      // ---- 1 种新光效：逐个真跑绘制 ----
      const node = { id: "verify-1", type: "GGTest", title: "测试", size: [240, 160], flags: {} };
      const rect = { left: 0, top: 0, right: 240, bottom: 160, width: 240, height: 160, collapsed: false };
      const glowDraw = {};
      for (const name of glowNames) {
        const drawer = glow.EXTRA_GLOW_DRAWERS.get(name);
        if (!drawer) { glowDraw[name] = { missing: true }; continue; }
        // 取多个周期点覆盖心跳双环的相位。
        const merged = { stroke: 0, fill: 0, arc: 0, badNumbers: 0, threw: false };
        for (const t of [20, 75, 100, 1500, 3100]) {
          const { ctx, calls } = mkCtx();
          try {
            drawer({ ctx, node, rect, now: t, scale: 1, palette: {}, intensityScale: 1, isLight: false });
            merged.stroke += calls.stroke; merged.fill += calls.fill;
            merged.arc += calls.arc; merged.badNumbers += calls.badNumbers;
          } catch (e) { merged.threw = String(e); }
        }
        glowDraw[name] = merged;
      }

      // ---- 旧设置迁移与保留项 ----
      let migrations;
      try {
        await writeSetting("GuliNodes.nodeGlow.effectPool", ["nebula", "heartbeat"]);
        await glow.migrateRemovedEffectPool();
        const partialPool = readSetting("GuliNodes.nodeGlow.effectPool");
        await writeSetting("GuliNodes.nodeGlow.effectPool", ["fireflies"]);
        await glow.migrateRemovedEffectPool();
        const emptyPool = readSetting("GuliNodes.nodeGlow.effectPool");
        await writeSetting("GuliNodes.linkStyle.dashStyle", "虚空");
        await link.migrateRemovedDashStyle();
        const removedDash = readSetting("GuliNodes.linkStyle.dashStyle");
        await writeSetting("GuliNodes.linkStyle.dashStyle", "极光");
        await link.migrateRemovedDashStyle();
        const retainedAurora = readSetting("GuliNodes.linkStyle.dashStyle");
        migrations = { partialPool, emptyPool, removedDash, retainedAurora };
      } finally {
        for (const id of ["GuliNodes.nodeGlow.effectPool", "GuliNodes.linkStyle.dashStyle"]) {
          const value = originalSettings.get(id);
          if (value !== undefined) await writeSetting(id, value);
        }
      }

      // ---- 配方 ----
      const recipes = pack.RECIPES.map((r) => ({ name: r.name, glow: r.glow, link: r.link, color: r.color }));

      // ---- 配方真能一键写入五个设置 ----
      const recipeSetting = (app.extensions || [])
        .find((x) => x.name === "ComfyUI.GGNodes.NodeGlowPack")
        ?.settings?.find((s) => s.id === "GuliNodes.effectRecipe");
      let recipeApplied = null;
      if (recipeSetting) {
        try {
          recipeSetting.onChange?.("极简冷静");
          await new Promise((r) => setTimeout(r, 250));
          recipeApplied = {
            mode: readSetting("GuliNodes.nodeGlow.mode"),
            pool: readSetting("GuliNodes.nodeGlow.effectPool"),
            dash: readSetting("GuliNodes.linkStyle.dashStyle"),
            colorMode: readSetting("GuliNodes.linkStyle.colorMode"),
            color: readSetting("GuliNodes.linkStyle.customColor"),
          };
        } finally {
          for (const id of settingIds.slice(0, 5)) {
            const value = originalSettings.get(id);
            if (value !== undefined) await writeSetting(id, value);
          }
        }
      }

      // ---- 关掉开关：卸载应干净回退 ----
      const packSettings = (app.extensions || [])
        .filter((ext) => /GGNodes\.(LinkStylePack|NodeGlowPack)/.test(ext.name))
        .flatMap((ext) => ext.settings || [])
        .filter((item) => /Pack$/.test(item.id || ""));
      for (const item of packSettings) { try { item.onChange?.(true); } catch {} }
      const allBefore = link.ALL_DASH_STYLES.length;
      const extraBefore = glow.EXTRA_GLOW_EFFECTS.length;
      const availableLinkStyles = [...link.ALL_DASH_STYLES];
      const linkAnimatedBefore = link.ANIMATED_STYLES.includes("数据雨");
      const coreAuroraPresent = link.ALL_DASH_STYLES.includes("极光");
      for (const item of packSettings) { try { item.onChange?.(false); } catch {} }
      const after = {
        all: link.ALL_DASH_STYLES.length,
        extraLink: link.EXTRA_DASH_STYLES.length,
        extraLinkDrawers: link.EXTRA_DASH_DRAWERS.size,
        extraGlow: glow.EXTRA_GLOW_EFFECTS.length,
        extraGlowDrawers: glow.EXTRA_GLOW_DRAWERS.size,
        stillHasNewStyle: link.ALL_DASH_STYLES.includes("数据雨"),
      };
      // 恢复加载前的注册状态，不改动宿主持久化设置。
      for (const item of packSettings) { try { item.onChange?.(true); } catch {} }
      const restored = {
        all: link.ALL_DASH_STYLES.length,
        extraLink: link.EXTRA_DASH_STYLES.length,
        extraGlow: glow.EXTRA_GLOW_EFFECTS.length,
      };

      return {
        allBefore, extraBefore, linkDraw, glowDraw, recipes, recipeApplied, migrations, after, restored,
        availableLinkStyles, linkAnimatedBefore, coreAuroraPresent,
        removedLinkPresent: removedLinkNames.filter((name) => link.ALL_DASH_STYLES.includes(name) || link.EXTRA_DASH_STYLES.includes(name)),
        removedGlowPresent: removedGlowNames.filter((name) => glow.EXTRA_GLOW_EFFECTS.includes(name) || glow.EXTRA_GLOW_DRAWERS.has(name)),
        extNames: (app.extensions || []).map((x) => x.name)
          .filter((n) => n === "ComfyUI.GGNodes.LinkStylePack" || n === "ComfyUI.GGNodes.NodeGlowPack"),
      };
    }, {
      linkNames: LINK_NAMES,
      glowNames: GLOW_NAMES,
      removedLinkNames: REMOVED_LINK_NAMES,
      removedGlowNames: REMOVED_GLOW_NAMES,
    });

    check("连线样式 12 → 17", state.allBefore === 17, `实际 ${state.allBefore}`);
    check("新光效 5 → 6", state.extraBefore === 1, `实际注册 ${state.extraBefore} 个`);
    check("旧节点光效池过滤并回退", JSON.stringify(state.migrations?.partialPool) === JSON.stringify(["heartbeat"])
      && JSON.stringify(state.migrations?.emptyPool) === JSON.stringify(["stardust", "cosmicDust", "rainbow"]),
      JSON.stringify(state.migrations));
    check("旧连接线设置回退且保留基础极光", state.migrations?.removedDash === "实线"
      && state.migrations?.retainedAurora === "极光" && state.coreAuroraPresent === true,
      JSON.stringify({ migrations: state.migrations, coreAuroraPresent: state.coreAuroraPresent }));
    check("已删除连线效果无残留", state.removedLinkPresent.length === 0, state.removedLinkPresent.join("/"));
    check("已删除节点光效无残留", state.removedGlowPresent.length === 0, state.removedGlowPresent.join("/"));
    check("新样式进入动画循环白名单", state.linkAnimatedBefore === true);
    check("两个扩展都已注册", state.extNames.length === 2, state.extNames.join(", "));

    for (const name of LINK_NAMES) {
      const r = state.linkDraw[name] || {};
      const drew = !r.missing && !r.threw && (r.stroke > 0 || r.fill > 0);
      check(`连线「${name}」可绘制`, drew,
        r.missing ? "未注册" : (r.threw ? String(r.threw).slice(0, 80) : `stroke=${r.stroke} fill=${r.fill}`));
      if (!r.missing) check(`连线「${name}」无非法坐标`, r.badNumbers === 0, `bad=${r.badNumbers}`);
    }

    for (const name of GLOW_NAMES) {
      const r = state.glowDraw[name] || {};
      const drew = !r.missing && r.threw === false && (r.stroke > 0 || r.fill > 0);
      check(`光效「${name}」可绘制`, drew,
        r.missing ? "未注册" : (r.threw ? String(r.threw).slice(0, 80) : `stroke=${r.stroke} fill=${r.fill}`));
      if (!r.missing) check(`光效「${name}」无非法坐标`, r.badNumbers === 0, `bad=${r.badNumbers}`);
    }

    check("8 套配方齐备", state.recipes.length === 8, state.recipes.map((r) => r.name).join("/"));
    check("配方引用的光效都已注册", state.recipes.every((r) => AVAILABLE_GLOW_NAMES.includes(r.glow)));
    check("配方引用的连线都已注册", state.recipes.every((r) => state.availableLinkStyles.includes(r.link)));
    check("配方主色均为合法 hex", state.recipes.every((r) => /^#[0-9a-f]{6}$/i.test(r.color)));
    const ra = state.recipeApplied || {};
    check("配方可一键写入 5 个设置", !!state.recipeApplied
      && ra.mode === "自定义"
      && Array.isArray(ra.pool) && ra.pool[0] === "heartbeat"
      && ra.dash === "光斑串"
      && ra.colorMode === "统一颜色"
      && ra.color === "#8FA3BF",
      JSON.stringify(state.recipeApplied));

    check("卸载后连线回到 12 种", state.after.all === 12, `实际 ${state.after.all}`);
    check("卸载后无残留新样式", state.after.stillHasNewStyle === false);
    check("卸载后连线注册表清空", state.after.extraLink === 0 && state.after.extraLinkDrawers === 0,
      `${state.after.extraLink} / ${state.after.extraLinkDrawers}`);
    check("卸载后光效注册表清空", state.after.extraGlow === 0 && state.after.extraGlowDrawers === 0,
      `${state.after.extraGlow} / ${state.after.extraGlowDrawers}`);
    check("重新开启可恢复", state.restored.all === 17 && state.restored.extraLink === 5 && state.restored.extraGlow === 1,
      JSON.stringify(state.restored));

    check("全程无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    check("无本模块 console error", moduleErrors.length === 0, moduleErrors.slice(0, 2).join(" | "));
  } catch (err) {
    check("脚本执行完成", false, String(err).slice(0, 240));
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
