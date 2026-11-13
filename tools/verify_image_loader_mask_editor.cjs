// Real ComfyUI UI + execution regression. Run after restarting the backend:
// COMFY_URL=http://127.0.0.1:8188 node tools/verify_image_loader_mask_editor.cjs
// Uses only tiny generated images; no model inference. Settings/workflow writes are isolated.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const BASE_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const OUT = path.resolve(__dirname, '../output/playwright');
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail) : ''));
  assert.ok(ok, name);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  // ComfyUI stores these on the server even for an isolated browser context.
  await page.route('**/settings**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.route('**/userdata/**', route => ['POST', 'PUT', 'DELETE'].includes(route.request().method())
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  let backup;
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app?.graph && window.app?.ggImageLoader, null, { timeout: 90000 });
    backup = await page.evaluate(() => app.graph.serialize());
    const fixture = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 160;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(80,120,160)'; ctx.fillRect(0, 0, 240, 160);
      const form = new FormData();
      form.append('image', await new Promise(r => canvas.toBlob(r, 'image/png')), 'gg_mask_regression_' + Date.now() + '.png');
      form.append('type', 'input');
      const response = await fetch('/upload/image', { method: 'POST', body: form });
      if (!response.ok) throw new Error('fixture upload ' + response.status);
      return await response.json();
    });
    const visiblePreviewState = () => page.evaluate(() => {
      const n = window.__ggMaskNode;
      const host = document.querySelector('.lg-node[data-node-id="' + n.id + '"]');
      return {
        panels: document.querySelectorAll('.gg-image-loader-preview').length,
        native: n.widgets.filter(w => w.name === '$$canvas-image-preview' && !w.hidden).length,
        images: host ? host.querySelectorAll('img').length : 1,
        values: n.serialize().widgets_values,
        source: n._ggImageLoaderPanel.image.src,
        size: Array.from(n.size),
        aliases: n.widgets.filter(w => w.name === 'image').length,
        aliasHidden: n.widgets.find(w => w.name === 'image')?.hidden,
      };
    });
    const openEditor = async () => {
      const welcome = page.locator('[data-dialog-key="global-workflow-template-selector"]');
      if (await welcome.isVisible()) {
        await page.keyboard.press('Escape');
        await welcome.waitFor({ state: 'hidden' });
      }
      await page.locator('.gg-image-loader-actions button').filter({ hasText: '蒙版' }).click();
      await page.locator('[role="dialog"] canvas.z-30').waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForFunction(() => {
        const c = document.querySelector('[role="dialog"] canvas.z-30');
        return c?.width === 240 && c?.height === 160;
      });
    };
    const maskPixels = () => page.locator('[role="dialog"] canvas.z-30').evaluate(c => {
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
      return painted;
    });
    for (const vue of [true, false]) for (const palette of ['light', 'dark']) {
      const label = (vue ? 'Nodes2' : 'Classic') + '-' + palette;
      await page.evaluate(async ({ vue, palette, filename }) => {
        await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', vue);
        await app.ui.settings.setSettingValue('Comfy.ColorPalette', palette);
        await app.loadGraphData({ nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 });
        const n = LiteGraph.createNode('GGImageLoad'); app.graph.add(n); n.pos = [120, 150];
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0]; app.ggImageLoader.setup(n);
        window.__ggMaskNode = n;
        const w = n.widgets.find(w => w.name === '图像'); w.value = filename; w.callback?.(filename);
        const mask = n.widgets.find(w => w.name === '遮罩文件'); mask.value = filename; mask.callback?.(filename);
        // An old cached execution must not generate a second visible preview.
        app.nodeOutputs[n.id] = { images: [{ filename, subfolder: '', type: 'input' }] };
        await n._ggImageLoaderPanel.image.decode();
        app.canvas.resizing_node = n;
        try { n.setSize([520, 720]); } finally { app.canvas.resizing_node = null; }
        app.canvas.setDirty(true, true);
      }, { vue, palette, filename: fixture.name });
      await pause(400);
      let state = await visiblePreviewState();
      check(label + ' 单预览且隐藏桥接不污染输入序列', state.panels === 1 && state.native === 0 && state.images === 1 && state.values.length === 2 && state.aliases === 1 && state.aliasHidden, state.values);
      if (vue && palette === 'light') {
        await page.evaluate(filename => {
          const n = window.__ggMaskNode; n.hideOutputImages = false;
          app.nodeOutputs[n.id] = { images: [{ filename, subfolder: '', type: 'input' }] };
        }, fixture.name);
        await pause(300);
        const broken = await visiblePreviewState();
        check('反向验证能检测重复预览', broken.images > 1 || broken.native > 0, broken.images);
        await page.evaluate(filename => {
          const n = window.__ggMaskNode; n.hideOutputImages = true;
          app.nodeOutputs[n.id] = { images: [{ filename, subfolder: '', type: 'input' }] };
        }, fixture.name);
        await pause(300);
        state = await visiblePreviewState();
        check('恢复预览抑制后只显示一张', state.images === 1 && state.native === 0);
      }
      const oldValues = state.values;
      await openEditor();
      check(label + ' 官方编辑器打开不占用全局返回目标', await page.evaluate(() => app.constructor.clipspace_return_node == null));
      await page.locator('[role="dialog"] button').filter({ hasText: /^\s*取消\s*$/ }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden' });
      state = await visiblePreviewState();
      check(label + ' 取消保留原图和手选遮罩', JSON.stringify(state.values) === JSON.stringify(oldValues));
      await openEditor();
      const box = await page.locator('[role="dialog"] canvas.z-30').boundingBox();
      await page.mouse.move(box.x + box.width * .42, box.y + box.height * .5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .58, box.y + box.height * .5, { steps: 15 });
      await page.mouse.up();
      // GPU 笔刷在 pointerup 后异步合成到 2D 蒙版画布。
      await page.waitForFunction(() => {
        const c = document.querySelector('[role="dialog"] canvas.z-30');
        const data = c?.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return data?.some((v, i) => i % 4 === 3 && v > 0);
      }, null, { timeout: 5000 });
      check(label + ' 真实笔触产生蒙版像素', await maskPixels() > 0);
      await page.locator('[role="dialog"] button').filter({ hasText: /^\s*保存\s*$/ }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 30000 });
      await page.evaluate(() => window.__ggMaskNode._ggImageLoaderPanel.image.decode());
      await pause(250);
      state = await visiblePreviewState();
      check(label + ' 保存回写带标记文件并清除旧遮罩', /clipspace-painted-masked-.*\.png \[input\]$/.test(state.values[0]) && state.values[1] === '', state.values);
      check(label + ' 保存后始终单图且 URL 正确解析', state.panels === 1 && state.native === 0 && state.images === 1 && !new URL(state.source).searchParams.get('filename').includes('[input]'));
      // Re-enter through the real official loader, so layered-file and alpha handling are covered.
      await openEditor();
      check(label + ' 再次打开保留已画蒙版', await maskPixels() > 0);
      await page.locator('[role="dialog"] button').filter({ hasText: /^\s*取消\s*$/ }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden' });
      const saved = await page.evaluate(() => app.graph.serialize());
      await page.evaluate(async saved => {
        await app.loadGraphData(saved); window.__ggMaskNode = app.graph._nodes.find(n => n.type === 'GGImageLoad');
        app.ggImageLoader.setup(window.__ggMaskNode);
        await window.__ggMaskNode._ggImageLoaderPanel.image.decode();
      }, saved);
      await pause(300);
      const restored = await visiblePreviewState();
      check(label + ' 读档保留输入与手动尺寸', JSON.stringify(restored.values) === JSON.stringify(state.values) && restored.size.every((v, i) => Math.abs(v - state.size[i]) < 1), restored.size);
      check(label + ' 读档仍只有一张预览', restored.panels === 1 && restored.native === 0 && restored.images === 1 && restored.aliases === 1);
      await page.screenshot({ path: path.join(OUT, 'gg-image-loader-' + label + '.png') });
      const prompt = {
        '901': { class_type: 'GGImageLoad', inputs: { '图像': restored.values[0], '遮罩文件': '' } },
        '902': { class_type: 'PreviewImage', inputs: { images: ['901', 0] } },
        '903': { class_type: 'MaskToImage', inputs: { mask: ['901', 1] } },
        '904': { class_type: 'PreviewImage', inputs: { images: ['903', 0] } },
      };
      const queued = await page.request.post(BASE_URL + '/prompt', { data: { prompt } });
      const queueBody = await queued.json();
      check(label + ' 官方保存文件通过真实后端校验', queued.ok(), queued.ok() ? undefined : queueBody);
      let history;
      for (let i = 0; i < 100; i++) {
        const response = await page.request.get(BASE_URL + '/history/' + queueBody.prompt_id);
        history = (await response.json())[queueBody.prompt_id];
        if (history) break;
        await pause(150);
      }
      check(label + ' 后端执行成功且加载节点不返回 ui.images', history?.status?.status_str === 'success' && !history.outputs?.['901']?.images, history?.status);
      const readPixels = async image => page.evaluate(async item => {
        const img = new Image(); img.src = '/view?' + new URLSearchParams(item); await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let min = 255, max = 0, sum = 0;
        for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); sum += data[i]; }
        return { min, max, sum, width: c.width, height: c.height };
      }, image);
      const mask = await readPixels(history.outputs['904'].images[0]);
      check(label + ' 输出蒙版包含笔触和未涂区域', mask.min === 0 && mask.max > 0 && mask.sum > 0 && mask.width === 240 && mask.height === 160, mask);
      const rgb = await readPixels(history.outputs['902'].images[0]);
      check(label + ' 蒙版区域的原始 RGB 保留', rgb.min === 80 && rgb.max === 80, rgb);
    }
    check('没有前端运行错误', errors.length === 0, errors);
  } catch (error) {
    await page.screenshot({ path: path.join(OUT, 'gg-image-loader-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (backup) await page.evaluate(data => app.loadGraphData(data), backup).catch(() => {});
    await fs.writeFile(path.join(OUT, 'gg-image-loader-mask-editor-result.json'), JSON.stringify({ checks, errors }, null, 2));
    await browser.close();
  }
  console.log('ALL PASS ' + checks.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
