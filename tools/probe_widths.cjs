// 探针：列出所有 GG 节点的默认宽度、宽度下限来源、拖窄后能否保持。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/probe_widths.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out', 'widths.json');

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const classes = await page.evaluate(async () => {
    const res = await fetch('/object_info');
    const info = await res.json();
    return Object.keys(info).filter((k) => {
      const d = info[k];
      return k.startsWith('GG')
        || String(d?.category ?? '').includes('GuliNodes')
        || String(d?.display_name ?? '').startsWith('GG');
    }).sort();
  });

  const rows = [];
  for (const cls of classes) {
    const data = await page.evaluate(async (cls) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      app.graph.clear();
      let node;
      try {
        node = window.LiteGraph.createNode(cls);
      } catch (e) {
        return { cls, error: String(e) };
      }
      if (!node) return { cls, error: 'createNode 返回 null' };
      app.graph.add(node);
      await sleep(280);
      await tick();

      const ctx = document.createElement('canvas').getContext('2d');
      const m14 = (s) => { ctx.font = '14px Arial'; return ctx.measureText(String(s ?? '')).width; };
      const m12 = (s) => { ctx.font = '12px Inter, sans-serif'; return ctx.measureText(String(s ?? '')).width; };

      const state = node._ggRowLayout ?? null;
      const configMin = state?.config?.minWidth ?? null;
      const rowMin = Number.isFinite(state?.minWidth) ? Math.round(state.minWidth) : null;
      const autoWidth = Number.isFinite(state?.autoWidth) ? Math.round(state.autoWidth) : null;
      const rowCols = state?.config?.columns ?? null;
      const layoutRows = (state?.rows ?? []).map((row) => ({
        n: row.length,
        cols: row.map((w) => Math.round(w._ggCol?.w ?? w.width ?? 0)),
        labels: row.map((w) => String(w.label ?? w.name ?? '')),
        // 这一行按引擎口径实际需要多宽（Σ(标签+取值+60) + 列距 + 两侧内衬）
        tight: Math.ceil(row.reduce((s, w) => {
          const label = String(w.label ?? w.name ?? '');
          const value = String(w._displayValue ?? w.value ?? '');
          const type = String(w.type ?? '').toLowerCase();
          const cap = (type === 'combo' || type === 'number' || Array.isArray(w.options?.values)) ? 220 : 130;
          return s + m12(label) + Math.min(m12(value), cap) + 60;
        }, 0) + 8 * (row.length - 1) + 30),
      }));

      // 重算 gg-node-autofit.js 的 requiredNodeWidth（口径照抄那份源码）
      const titleW = Math.ceil(m14(node.title ?? node.type ?? '') + 38);
      const widgetW = (node.widgets ?? []).reduce((max, w) => {
        if (!w || w.hidden || String(w.type ?? '').startsWith('ggHiddenLoRA')) return max;
        const t = w.label ?? w.name ?? '';
        const v = w.type === 'button' ? Math.min(m14(t) + 44, 220) : Math.min(m14(t) + 68, 240);
        return Math.max(max, v);
      }, 0);
      const slotW = [...(node.inputs ?? []), ...(node.outputs ?? [])].reduce((max, s) => {
        const t = s?.label || s?.localized_name || s?.name || '';
        return Math.max(max, Math.min(m14(t) + 48, 240));
      }, 0);
      const floorW = Number(node._ggAutoFitMinWidth) || 0;
      const autofitW = Math.ceil(Math.min(Math.max(150, titleW, widgetW, slotW, floorW), 320));

      // 每个控件完整显示所需宽度（12px，标签 + 取值 + 60；节点宽度再加 30 内衬）
      const needMax = (node.widgets ?? []).reduce((max, w) => {
        if (!w || w.hidden) return max;
        const label = String(w.label ?? w.name ?? '');
        const value = String(w._displayValue ?? w.value ?? '');
        const type = String(w.type ?? '').toLowerCase();
        const cap = (type === 'combo' || type === 'number' || Array.isArray(w.options?.values)) ? 220 : 130;
        return Math.max(max, Math.ceil(m12(label) + Math.min(m12(value), cap) + 60));
      }, 0);

      let computed = null;
      try { computed = Math.round(node.computeSize()[0]); } catch { /* ignore */ }
      const defaultWidth = Math.round(node.size[0]);
      const defaultHeight = Math.round(node.size[1]);

      // 拖窄到 120 看回弹：能保持说明没有硬下限在撑，回弹值就是真实下限
      node.setSize([120, node.size[1]]);
      await sleep(320);
      await tick();
      const afterNarrow = Math.round(node.size[0]);
      // 再拖到 260 观察是否被行布局/autofit 撑回
      node.setSize([260, node.size[1]]);
      await sleep(320);
      await tick();
      const after260 = Math.round(node.size[0]);

      // 模拟用户真的握着节点边拖到 120：autofit 的 onResize 会记手动尺寸标记，
      // 行布局引擎应该撤掉内容宽下限，让这个宽度留得住。
      const dragHeight = node.size[1];
      node.setSize([120, dragHeight]);
      app.canvas.resizing_node = node;
      try { node.onResize?.([120, dragHeight]); } catch { /* ignore */ }
      app.canvas.resizing_node = null;
      await sleep(360);
      await tick();
      const afterDragNarrow = Math.round(node.size[0]);
      const manualFlag = Array.isArray(node._ggAutoFitManualSize)
        ? Math.round(node._ggAutoFitManualSize[0]) : null;

      return {
        cls,
        title: String(node.title ?? ''),
        defaultWidth,
        defaultHeight,
        computed,
        rowLayout: !!state,
        configMin: configMin === null ? null : String(configMin),
        rowMin,
        rowCols,
        autoWidth,
        autofitW,
        titleW: Math.ceil(titleW),
        widgetW: Math.ceil(widgetW),
        slotW: Math.ceil(slotW),
        floorW: Math.ceil(floorW),
        needMax: Math.ceil(needMax),
        widgetCount: (node.widgets ?? []).filter((w) => w && !w.hidden).length,
        afterNarrow,
        after260,
        afterDragNarrow,
        manualFlag,
        layoutRows,
      };
    }, cls);
    rows.push(data);
    if (data.error) process.stderr.write(`${cls} ERR ${data.error}\n`);
  }

  rows.sort((a, b) => (b.defaultWidth ?? 0) - (a.defaultWidth ?? 0));
  fs.writeFileSync(OUT, JSON.stringify({ rows, errors }, null, 1), 'utf8');

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('节点', 34)}${pad('默认宽', 8)}${pad('拖窄后', 8)}${pad('拖260后', 9)}${pad('真拖120', 9)}${pad('行下限', 8)}${pad('配置', 8)}${pad('autofit', 8)}${pad('标题', 7)}${pad('控件', 7)}${pad('端口', 7)}${pad('控件需宽', 10)}${pad('行数', 5)}`);
  for (const r of rows) {
    if (r.error) continue;
    console.log(
      `${pad(r.cls.slice(0, 33), 34)}${pad(r.defaultWidth, 8)}${pad(r.afterNarrow, 8)}${pad(r.after260, 9)}${pad(r.afterDragNarrow, 9)}`
      + `${pad(r.rowMin ?? '-', 8)}${pad(r.configMin ?? '-', 8)}${pad(r.autofitW, 8)}${pad(r.titleW, 7)}`
      + `${pad(r.widgetW, 7)}${pad(r.slotW, 7)}${pad(r.needMax, 10)}${pad(r.layoutRows.length, 5)}`,
    );
  }
  console.log(`\n共 ${rows.length} 个节点，错误 ${rows.filter((r) => r.error).length}，页面异常 ${errors.length}`);
  console.log(`saved ${OUT}`);
  await browser.close();
})();
