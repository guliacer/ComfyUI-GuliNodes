// 验证 example_workflows 里的示例工作流能在前端真正加载：节点类型是否齐全、连线是否完整。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_example_workflows.cjs
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIR = path.resolve('example_workflows');

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const results = [];
  for (const file of files) {
    const wf = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const r = await page.evaluate(async (data) => {
      const app = window.app;
      try {
        await app.loadGraphData(data, true, true);
      } catch (e) {
        return { fatal: String(e) };
      }
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const nodes = app.graph._nodes;

      // 工作流里出现过的所有类型 vs LiteGraph 已注册的类型
      const wanted = new Set();
      const collect = (list) => (list || []).forEach((n) => n?.type && wanted.add(n.type));
      collect(data.nodes);
      (data.definitions?.subgraphs || []).forEach((sg) => collect(sg.nodes));
      const missing = [...wanted].filter((t) => !window.LiteGraph.registered_node_types?.[t]);

      // 子图节点在顶层是 SubgraphNode，类型名是 UUID，需要单独确认
      const subgraphIds = new Set((data.definitions?.subgraphs || []).map((s) => s.id));

      return {
        nodes: nodes.length,
        links: Object.keys(app.graph.links || {}).length,
        expectedNodes: (data.nodes || []).length,
        subgraphs: (data.definitions?.subgraphs || []).length,
        subgraphTopLevel: nodes.filter((n) => subgraphIds.has(n.type)).length,
        missing,
        nodeTypes: [...new Set(nodes.map((n) => n.type))].slice(0, 20),
      };
    }, wf);
    results.push({ file, size: fs.statSync(path.join(DIR, file)).size, ...r });
  }

  console.log(JSON.stringify({ results, pageErrors }, null, 2));
  await browser.close();
})();
