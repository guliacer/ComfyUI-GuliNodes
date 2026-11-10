// 验证 GG 纯色图像：宽度/高度同一行、颜色独占一行、点开能敲十六进制。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_solid_color.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const SELECTOR = '[data-gg-solid-color="1"]';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 真机脚本异常收集统一口径（问题文档第 5 条）：外部扩展 gulips.bridge 启动时
  // 抛 `io is not defined`，内嵌网页还会刷 CSP report-only 报告，都属环境噪音；
  // 只放行下面明确识别的几条，其它任何 console error 仍然计入 errors，
  // 不允许把「无脚本异常」放宽成空跑。404 另由 response 钩子单独归类。
  const ENV_NOISE = [
    /Error calling extension 'gulips[.]bridge' method 'setup'/,
    /report-only Content Security Policy/,
    /Framing .* violates the following report-only/,
    /upgrade-insecure-requests' is ignored when delivered in a report-only policy/,
    /Failed to load resource/,
  ];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ENV_NOISE.some((re) => re.test(text))) return;
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const geom = await page.evaluate(async () => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 90];
    const node = window.LiteGraph.createNode('GG纯色图像');
    app.graph.add(node);
    node.pos = [60, 90];
    await tick();
    await tick();
    const color = node.widgets.find((w) => w.name === '填充颜色');
    const width = node.widgets.find((w) => w.name === '宽度');
    const height = node.widgets.find((w) => w.name === '高度');
    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const toScreen = (lx, ly) => [
      rect.left + (node.pos[0] + ds.offset[0] + lx) * ds.scale,
      rect.top + (node.pos[1] + ds.offset[1] + ly) * ds.scale,
    ];
    return {
      size: [node.size[0], node.size[1]],
      sameRow: width.y === height.y,
      colorAlone: width.y !== color.y,
      colorCol: color._ggCol,
      point: toScreen(color._ggCol.x + 60, color.y + 12),
      box: {
        x: rect.left + (node.pos[0] + ds.offset[0]) * ds.scale,
        y: rect.top + (node.pos[1] + ds.offset[1]) * ds.scale,
        width: node.size[0] * ds.scale + 16,
        height: node.size[1] * ds.scale + 16,
      },
    };
  });

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  check('宽度与高度同一行', geom.sameRow, `y=${geom.size}`);
  check('颜色单独一行', geom.colorAlone, `colorY 不与宽高同 y`);
  check('节点高度回到两行', geom.size[1] < 100, `size=${geom.size}`);

  await page.mouse.move(640, 760);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'solid_color_layout.png'), clip: geom.box });

  const readValue = () => page.evaluate(() => {
    const node = window.app.graph._nodes[0];
    const color = node.widgets.find((w) => w.name === '填充颜色');
    const serialized = node.serialize?.() ?? {};
    return { value: color.value, values: serialized.widgets_values ?? node.widgets_values ?? null };
  });
  const openEditor = async () => {
    await page.mouse.click(geom.point[0], geom.point[1]);
    await page.waitForTimeout(250);
    return page.evaluate((sel) => {
      const host = document.querySelector(sel);
      if (!host) return null;
      const input = host.querySelector('input.gg-field');
      return { text: host.innerText.replace(/\n/g, ' | '), input: input?.value, buttons: host.querySelectorAll('button').length };
    }, SELECTOR);
  };

  // 1. 点开
  const opened = await openEditor();
  check('点击颜色控件弹出编辑框', opened && opened.input === '#00ff00', JSON.stringify(opened));
  check('弹层里有取色器与确定按钮', opened && opened.buttons === 2, `buttons=${opened?.buttons}`);
  await page.screenshot({ path: path.join(OUT_DIR, 'solid_color_popover.png'), clip: { x: geom.box.x, y: geom.box.y, width: 520, height: 330 } });

  // 2. 输入十六进制 + 回车
  await page.evaluate((sel) => {
    const input = document.querySelector(`${sel} input.gg-field`);
    input.focus();
    input.select();
  }, SELECTOR);
  await page.keyboard.type('#123456');
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT_DIR, 'solid_color_typing.png'), clip: { x: geom.box.x, y: geom.box.y, width: 520, height: 330 } });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const afterEnter = await readValue();
  check('回车写入十六进制', afterEnter.value === '#123456', JSON.stringify(afterEnter));
  check('回车后弹层关闭', !(await page.evaluate((sel) => !!document.querySelector(sel), SELECTOR)));
  check('序列化同步', JSON.stringify(afterEnter.values).includes('#123456'), JSON.stringify(afterEnter.values));
  // 鼠标停在控件上会触发画布 tooltip，截图前先挪开，否则颜色那一行被提示框盖住
  await page.mouse.move(640, 760);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'solid_color_after.png'), clip: geom.box });

  // 3. 简写 #abc 要展开成 #aabbcc
  await openEditor();
  await page.evaluate((sel) => {
    const input = document.querySelector(`${sel} input.gg-field`);
    input.focus();
    input.select();
  }, SELECTOR);
  await page.keyboard.type('#0f0');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const afterShort = await readValue();
  check('三位简写展开成六位', afterShort.value === '#00ff00', JSON.stringify(afterShort));

  // 4. 非法值不落盘、弹层不关并标红
  await openEditor();
  await page.evaluate((sel) => {
    const input = document.querySelector(`${sel} input.gg-field`);
    input.focus();
    input.select();
  }, SELECTOR);
  await page.keyboard.type('zzz');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const invalid = await page.evaluate((sel) => {
    const node = window.app.graph._nodes[0];
    const color = node.widgets.find((w) => w.name === '填充颜色');
    const host = document.querySelector(sel);
    return {
      value: color.value,
      stillOpen: !!host,
      border: host ? host.querySelector('input.gg-field').style.borderColor : null,
    };
  }, SELECTOR);
  check('非法值不落盘', invalid.value === '#00ff00', JSON.stringify(invalid));
  check('非法值弹层不关', invalid.stillOpen, '');
  check('非法值边框标红', String(invalid.border || '').length > 0, String(invalid.border));

  // 5. Esc 取消
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc 关闭弹层', !(await page.evaluate((sel) => !!document.querySelector(sel), SELECTOR)));

  // 6. 点外面提交合法值
  await openEditor();
  await page.evaluate((sel) => {
    const input = document.querySelector(`${sel} input.gg-field`);
    input.focus();
    input.select();
  }, SELECTOR);
  await page.keyboard.type('ff8800');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(250);
  const afterBlur = await readValue();
  check('点外面提交（无 # 的写法也认）', afterBlur.value === '#ff8800', JSON.stringify(afterBlur));

  // 7. r,g,b 写法
  await openEditor();
  await page.evaluate((sel) => {
    const input = document.querySelector(`${sel} input.gg-field`);
    input.focus();
    input.select();
  }, SELECTOR);
  await page.keyboard.type('12,34,56');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const afterRgb = await readValue();
  check('r,g,b 写法解析', afterRgb.value === '#0c2238', JSON.stringify(afterRgb));

  // 8. 老工作流里存成整数的颜色也要能显示
  const legacy = await page.evaluate(async () => {
    const app = window.app;
    const node = window.LiteGraph.createNode('GG纯色图像');
    app.graph.add(node);
    const color = node.widgets.find((w) => w.name === '填充颜色');
    color.value = 0x3366ff;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { size: [node.size[0], node.size[1]] };
  });
  check('整数颜色的老节点正常建出来', legacy.size[1] > 0, JSON.stringify(legacy));

  console.log(JSON.stringify({ results, errors }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
