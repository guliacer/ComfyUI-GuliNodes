// 断言「GG 图像加载」裁剪弹窗的纯几何规则。
// 用法：node tools/verify_image_loader_crop.cjs
// 依 AGENTS.md 九：正常用例全跑，并用故意改坏的副本验证断言有效。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "web", "gg-image-crop-geometry.js");
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sizeOf = (rect) => [rect[2] - rect[0], rect[3] - rect[1]];

function collectFailures(geo) {
    const fail = [];
    const check = (ok, label) => { if (!ok) fail.push(label); };
    const presets = geo.CROP_RATIO_PRESETS;
    check(presets.length === 11, "预设数量应为 11");
    const labels = presets.map((item) => item.label.split(" ")[0]);
    for (const name of ["自由比例", "1:1", "4:3", "3:2", "16:9", "9:16", "2:3", "3:4", "4:5", "5:4", "21:9"]) check(labels.includes(name), `缺少比例预设 ${name}`);
    check(close(presets[1].value, 1), "1:1 数值错误");
    check(close(presets[2].value, 4 / 3), "4:3 数值错误");
    check(close(presets[5].value, 9 / 16), "9:16 数值错误");
    check(geo.CUSTOM_RATIO === -1, "自定义比例标记错误");

    check(close(geo.parseRatioText("4:3"), 4 / 3), "解析 4:3 失败");
    check(close(geo.parseRatioText("16：9"), 16 / 9), "解析中文冒号失败");
    check(close(geo.parseRatioText(" 3 / 2 "), 1.5), "解析 3/2 失败");
    check(close(geo.parseRatioText("1.5"), 1.5), "解析单个小数失败");
    check(geo.parseRatioText("0:1") === 0, "零宽应退回自由比例");
    check(geo.parseRatioText("abc") === 0, "非法输入应退回自由比例");

    for (const [bounds, ratio] of [[[800, 600], 1], [[800, 600], 16 / 9], [[600, 800], 9 / 16], [[1000, 1000], 4 / 3]]) {
        const rect = geo.fitCenteredRect(bounds, ratio);
        const [w, h] = sizeOf(rect);
        check(close(w / h, ratio, 1e-5), `居中矩形比例错 ${bounds} @${ratio}`);
        check(rect[0] >= -1e-6 && rect[1] >= -1e-6 && rect[2] <= bounds[0] + 1e-6 && rect[3] <= bounds[1] + 1e-6, `居中矩形越界 ${bounds} @${ratio}`);
        check(close(rect[0] + rect[2], bounds[0], 1e-5) && close(rect[1] + rect[3], bounds[1], 1e-5), `居中矩形未居中 ${bounds} @${ratio}`);
        check(close(w, bounds[0]) || close(h, bounds[1]), `居中矩形不是最大 ${bounds} @${ratio}`);
    }
    check(JSON.stringify(geo.fitCenteredRect([800, 600], 0)) === JSON.stringify([0, 0, 800, 600]), "自由比例应返回整图");

    for (const [start, end] of [[[400, 300], [700, 500]], [[400, 300], [100, 100]], [[400, 300], [100, 500]], [[400, 300], [700, 100]]]) {
        const rect = geo.constrainDragRect(start, end, 16 / 9, [800, 600]);
        const [w, h] = sizeOf(rect);
        check(close(w / h, 16 / 9, 1e-5), `拖动比例错 ${start}→${end}`);
        check(rect[0] >= -1e-6 && rect[1] >= -1e-6 && rect[2] <= 800 + 1e-6 && rect[3] <= 600 + 1e-6, `拖动越界 ${start}→${end}`);
    }
    const edge = geo.constrainDragRect([790, 590], [1000, 900], 1, [800, 600]);
    check(close(sizeOf(edge)[0], sizeOf(edge)[1], 1e-5), "贴边拖动没有等比收缩");
    const free = geo.constrainDragRect([100, 100], [300, 200], 0, [800, 600]);
    check(close(sizeOf(free)[0], 200) && close(sizeOf(free)[1], 100), "自由比例拖动尺寸错误");

    const moved = geo.moveSelection([100, 100, 300, 200], [1000, 1000], [800, 600]);
    check(close(sizeOf(moved)[0], 200) && close(sizeOf(moved)[1], 100), "移动后选区被缩小");
    check(close(moved[2], 800) && close(moved[3], 600), "移动没有贴边");
    const base = [200, 150, 600, 450];
    const corner = geo.resizeSelection(base, "se", [700, 500], 1, [800, 600]);
    check(close(sizeOf(corner)[0], sizeOf(corner)[1], 1e-5), "角手柄未保持比例");
    check(close(corner[0], 200) && close(corner[1], 150), "角手柄锚点漂移");
    const north = geo.resizeSelection(base, "n", [0, 50], 0, [800, 600]);
    check(close(north[0], 200) && close(north[2], 600) && close(north[1], 50), "北边手柄几何错误");
    check(geo.hitHandle(base, [200, 150], 8) === "nw", "左上角命中错误");
    check(geo.hitHandle(base, [600, 450], 8) === "se", "右下角命中错误");
    check(geo.hitHandle(base, [200, 300], 8) === "w", "左边手柄命中错误");
    check(geo.hitHandle(base, [400, 300], 8) === "", "选区内部不该命中手柄");

    const inverse = geo.inverseSelection([100, 100, 300, 200], [800, 600]);
    check(JSON.stringify(inverse.outputRect) === JSON.stringify([0, 0, 800, 600]), "反选没有保留整图");
    check(JSON.stringify(inverse.maskRect) === JSON.stringify([100, 100, 300, 200]), "反选遮罩区域错误");
    check(JSON.stringify(geo.transformedBounds([800, 600], 90)) === JSON.stringify([600, 800]), "90° 旋转未交换宽高");
    check(JSON.stringify(geo.transformedBounds([800, 600], 180)) === JSON.stringify([800, 600]), "180° 不该交换宽高");
    check(JSON.stringify(geo.clampRect([-50, -20, 900, 700], [800, 600])) === JSON.stringify([0, 0, 800, 600]), "clampRect 未按图幅收敛");
    return fail;
}

const BREAKAGES = [
    { name: "居中不收缩", from: "if (h > height) { h = height; w = h * ratio; }", to: "if (false) { h = height; w = h * ratio; }" },
    { name: "拖动丢比例", from: "h = w / ratio;", to: "h = w;" },
    { name: "反选裁掉整图", from: "outputRect: [0, 0, bounds[0], bounds[1]]", to: "outputRect: rect" },
];
async function loadGeometry(file) { return import(`${pathToFileURL(file).href}?v=${Date.now()}${Math.random()}`); }

async function main() {
    const good = collectFailures(await loadGeometry(SOURCE));
    console.log(`真实几何模块：${good.length} 条 FAIL / ${good.length === 0 ? "全部通过" : "存在回归"}`);
    for (const item of good) console.log(`  FAIL ${item}`);
    const source = fs.readFileSync(SOURCE, "utf8");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-crop-"));
    let reverseOk = true;
    try {
        for (const [index, item] of BREAKAGES.entries()) {
            if (!source.includes(item.from)) { console.log(`  FAIL 反向用例 ${item.name}：源码里找不到待破坏片段`); reverseOk = false; continue; }
            const broken = path.join(temp, `broken-${index}.mjs`);
            fs.writeFileSync(broken, source.replace(item.from, item.to), "utf8");
            const failures = collectFailures(await loadGeometry(broken));
            console.log(`反向验证「${item.name}」：${failures.length ? `捕获 ${failures.length} 条 FAIL` : "0 条 FAIL（断言在空跑）"}`);
            if (!failures.length) reverseOk = false;
        }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    const ok = good.length === 0 && reverseOk;
    console.log(ok ? "裁剪几何验证通过" : "裁剪几何验证失败");
    process.exitCode = ok ? 0 : 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
