"""GG 局部重绘裁剪契约测试：真实 torch / numpy，只加载单个模块，不导入注册器或模型。

覆盖：V3 与 legacy 两条分支、遮罩预处理链（过滤/补洞/膨胀/反相）、上下文扩展、
画面外扩、强制尺寸、接缝往返精度，以及「GG 遮罩裁剪 + GG 裁剪恢复」老链路的回归。
"""

import importlib.machinery
import importlib.util
import sys
import types
import unittest
from pathlib import Path

import numpy as np
import torch

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "mask_tools.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_mask_tools(legacy=False):
    """按文件加载隔离模块；legacy 时把 comfy_api.latest 置 None 走纯 legacy 分支。"""
    if not MODULE_PATH.is_file():
        raise AssertionError("缺少 guli_nodes/mask_tools.py")
    package_name = "_mask_tools_test_host"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(PLUGIN_ROOT / "guli_nodes")]
        package.__spec__ = importlib.machinery.ModuleSpec(package_name, loader=None, is_package=True)
        sys.modules[package_name] = package
    module_name = package_name + (".mask_tools_legacy" if legacy else ".mask_tools_v3")
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    previous = sys.modules.get("comfy_api.latest", None)
    if legacy:
        sys.modules["comfy_api.latest"] = None
    try:
        spec.loader.exec_module(module)
    finally:
        if legacy:
            if previous is None:
                sys.modules.pop("comfy_api.latest", None)
            else:
                sys.modules["comfy_api.latest"] = previous
    return module


def make_image(width=400, height=300):
    """造一张有纹理的图，任何位置被改动都能通过像素比对发现。"""
    ys, xs = np.mgrid[0:height, 0:width]
    base = np.stack(
        [
            (xs / max(1, width - 1)).astype(np.float32),
            (ys / max(1, height - 1)).astype(np.float32),
            ((xs + ys) % 37 / 37.0).astype(np.float32),
        ],
        axis=-1,
    )
    return torch.from_numpy(base[None, ...])


def make_mask(box, width=400, height=300):
    x0, y0, x1, y1 = box
    mask = np.zeros((height, width), dtype=np.float32)
    mask[y0:y1, x0:x1] = 1.0
    return torch.from_numpy(mask[None, ...])


def solid_like(image, color=(0.9, 0.05, 0.05)):
    数组 = np.zeros(tuple(image.shape), dtype=np.float32)
    数组[..., 0], 数组[..., 1], 数组[..., 2] = color
    return torch.from_numpy(数组)


class InpaintCropContract(unittest.TestCase):
    def setUp(self):
        self.mod = load_mask_tools(legacy=False)
        self.image = make_image()
        self.mask = make_mask((100, 80, 160, 140))

    # --- 基本形状 ---------------------------------------------------------

    def test_default_output_matches_context_size(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, 上下文遮罩=None, 遮罩填充=True, 遮罩反相=False,
            遮罩扩展=0, 低值过滤=0.1, 上下文扩展=1.2, 画面外扩=0,
            输出宽度=0, 输出高度=0, 尺寸对齐=8,
        )
        高, 宽 = 裁剪图.shape[1], 裁剪图.shape[2]
        # 遮罩 60x60，系数 1.2 → 每边 +6px = 72x72，再向上对齐到 8 的倍数
        self.assertEqual((宽, 高), (72, 72), f"上下文尺寸不对：{宽}x{高}")
        self.assertEqual(tuple(裁剪遮罩.shape), (1, 高, 宽))
        self.assertEqual(接缝["目标宽高"], (宽, 高))
        self.assertEqual(接缝["画布框"], (0, 0, 400, 300))

    def test_force_target_size(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, 上下文遮罩=None, 遮罩填充=True, 遮罩反相=False,
            遮罩扩展=0, 低值过滤=0.1, 上下文扩展=1.2, 画面外扩=0,
            输出宽度=136, 输出高度=120, 尺寸对齐=8,
        )
        self.assertEqual(tuple(裁剪图.shape[1:3]), (120, 136))
        self.assertEqual(tuple(裁剪遮罩.shape[1:3]), (120, 136))
        self.assertEqual(接缝["裁剪宽高"], (136, 120))

    def test_align_rounds_up(self):
        _, 裁剪图, _ = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.0, 0, 0, 0, 16,
        )
        # 遮罩 60x60、系数 1.0 → 60x60，向上对齐 16 → 64x64
        self.assertEqual(tuple(裁剪图.shape[1:3]), (64, 64))

    # --- 遮罩预处理 -------------------------------------------------------

    def test_context_factor_grows_box(self):
        _, 小, _ = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        _, 大, _ = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 2.0, 0, 0, 0, 8,
        )
        self.assertEqual(tuple(小.shape[1:3]), (64, 64))
        self.assertEqual(tuple(大.shape[1:3]), (120, 120))

    def test_mask_expand_grows_coverage(self):
        _, _, 薄 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        _, _, 厚 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 10, 0.1, 1.0, 0, 0, 0, 8,
        )
        self.assertGreater(float(厚.mean()), float(薄.mean()))

    def test_invert_covers_outside(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, True, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        # 反相后要重绘的是遮罩以外，范围就是整图
        # 300 向上对齐到 8 的倍数 → 304
        self.assertEqual(接缝["目标宽高"], (400, 304))
        # 反相后只有原来那块 60x60 是「不重绘」，其余全是；
        # 裁剪框可能为对齐而略微出界，那几行是补黑的，也属于不重绘。
        左, 上, _, _ = 接缝["裁剪框"]
        洞 = 裁剪遮罩[0, 80 - 上:140 - 上, 100 - 左:160 - 左]
        self.assertLess(float(洞.max()), 0.01)
        外 = 裁剪遮罩[0, 10:40, 0:40]
        self.assertGreater(float(外.min()), 0.99)
        self.assertGreater(float(裁剪遮罩.mean()), 0.9)

    def test_fill_holes(self):
        环 = np.zeros((300, 400), dtype=np.float32)
        环[80:140, 100:160] = 1.0
        环[100:120, 120:140] = 0.0
        环形遮罩 = torch.from_numpy(环[None, ...])
        _, _, 补 = self.mod._执行局部重绘裁剪(
            self.image, 环形遮罩, None, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        _, _, 不补 = self.mod._执行局部重绘裁剪(
            self.image, 环形遮罩, None, False, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        # 补洞后中间那 20x20 也算重绘区域
        self.assertGreater(float(补.mean()), float(不补.mean()))

    def test_lowpass_filter_clears_faint(self):
        淡 = np.zeros((300, 400), dtype=np.float32)
        淡[80:140, 100:160] = 1.0
        淡[0:20, 0:20] = 0.05
        带噪 = torch.from_numpy(淡[None, ...])
        接缝, _, _ = self.mod._执行局部重绘裁剪(
            self.image, 带噪, None, False, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        # 0.05 的噪点被滤掉，左上角不参与取范围
        self.assertEqual(接缝["目标宽高"], (64, 64))

    def test_empty_mask_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.mod._执行局部重绘裁剪(
                self.image, torch.zeros((1, 300, 400)), None, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
            )
        self.assertIn("没有白色区域", str(ctx.exception))

    def test_mask_size_mismatch_raises(self):
        with self.assertRaises(ValueError) as ctx:
            self.mod._执行局部重绘裁剪(
                self.image, torch.zeros((1, 100, 100)), None, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
            )
        self.assertIn("不一致", str(ctx.exception))

    # --- 外扩 -------------------------------------------------------------

    def test_outpaint_canvas(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.2, 20, 0, 0, 8,
        )
        self.assertEqual(接缝["画布框"], (-20, -20, 420, 320))
        # 外扩区域一定被算进重绘范围，所以裁剪图里必然有遮罩
        self.assertGreater(float(裁剪遮罩.mean()), 0.05)
        self.assertEqual((裁剪图.shape[2], 裁剪图.shape[1]), tuple(接缝["目标宽高"]))

    # --- 往返 -------------------------------------------------------------

    def test_roundtrip_puts_color_back_in_place(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.2, 0, 0, 0, 8,
        )
        结果 = self.mod._执行裁剪恢复(
            接缝, solid_like(裁剪图), 裁剪遮罩, None, 0, 0, 0.0,
        )
        self.assertEqual(tuple(结果.shape), tuple(self.image.shape))

        原 = self.image[0].numpy()
        新 = 结果[0].numpy()
        # 遮罩中心被换成纯红
        self.assertAlmostEqual(float(新[110, 130, 0]), 0.9, places=3)
        self.assertLess(float(新[110, 130, 1]), 0.1)
        # 远处像素一个都不能动
        self.assertLess(float(np.abs(新[:40, :40] - 原[:40, :40]).max()), 1e-6)

    def test_roundtrip_outpaint_canvas_grows(self):
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.2, 20, 0, 0, 8,
        )
        # 原样贴回：外扩画布 + 原图内容，逐像素都不该有变化
        结果 = self.mod._执行裁剪恢复(接缝, 裁剪图, 裁剪遮罩, None, 0, 0, 0.0)
        self.assertEqual(tuple(结果.shape), (1, 340, 440, 3))
        期望 = np.pad(self.image[0].numpy(), ((20, 20), (20, 20), (0, 0)), mode="edge")
        self.assertLess(float(np.abs(结果[0].numpy() - 期望).max()), 1e-6)

    def test_roundtrip_without_mask_output(self):
        """不接「裁剪遮罩」时要走接缝里保存的遮罩，位置必须一致。"""
        接缝, 裁剪图, _ = self.mod._执行局部重绘裁剪(
            self.image, self.mask, None, True, False, 0, 0.1, 1.2, 0, 0, 0, 8,
        )
        结果 = self.mod._执行裁剪恢复(接缝, solid_like(裁剪图), None, None, 0, 0, 0.0)
        self.assertAlmostEqual(float(结果[0, 110, 130, 0].numpy()), 0.9, places=3)
        self.assertLess(float(结果[0, 10, 10, 0].numpy()), 0.05)

    def test_context_mask_joins_range(self):
        额外 = make_mask((300, 200, 340, 240))
        接缝, _, _ = self.mod._执行局部重绘裁剪(
            self.image, self.mask, 额外, True, False, 0, 0.1, 1.0, 0, 0, 0, 8,
        )
        # 并集范围是 (100,80)-(340,240)，240x160，对齐后仍是 240x160
        self.assertEqual(接缝["目标宽高"], (240, 160))


class MaskCropRegression(unittest.TestCase):
    """老链路：GG 遮罩裁剪 + GG 裁剪恢复 的自定义接缝行为不能变。"""

    def setUp(self):
        self.mod = load_mask_tools(legacy=False)
        self.image = make_image()
        self.mask = make_mask((100, 80, 160, 140))

    def test_legacy_roundtrip_exact(self):
        扩展量 = {"上": 1.4, "下": 1.4, "左": 1.4, "右": 1.4}
        配置 = {"倍数取整": 8}
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行遮罩裁剪(
            self.image, self.mask, False, 扩展量, self.mod._输出尺寸_原像素, 配置,
        )
        结果 = self.mod._执行裁剪恢复(接缝, solid_like(裁剪图), 裁剪遮罩, None, 0, 0, 0.0)
        self.assertEqual(tuple(结果.shape), tuple(self.image.shape))
        self.assertAlmostEqual(float(结果[0, 110, 130, 0].numpy()), 0.9, places=3)
        self.assertLess(float(np.abs(结果[0, :40, :40].numpy() - self.image[0, :40, :40].numpy()).max()), 1e-6)

    def test_legacy_target_size_roundtrip(self):
        扩展量 = {"上": 1.0, "下": 1.0, "左": 1.0, "右": 1.0}
        配置 = {"宽度": 256, "高度": 256, "倍数取整": 8}
        接缝, 裁剪图, 裁剪遮罩 = self.mod._执行遮罩裁剪(
            self.image, self.mask, False, 扩展量, self.mod._输出尺寸_按宽高, 配置,
        )
        self.assertEqual(tuple(裁剪图.shape[1:3]), (256, 256))
        结果 = self.mod._执行裁剪恢复(接缝, solid_like(裁剪图), 裁剪遮罩, None, 0, 0, 0.0)
        self.assertEqual(tuple(结果.shape), tuple(self.image.shape))
        # 256 缩到裁剪尺寸再放回来，8 位量化会有 1/255 级误差
        self.assertAlmostEqual(float(结果[0, 110, 130, 0].numpy()), 0.9, delta=0.01)

    def test_wrong_seam_raises(self):
        with self.assertRaises(ValueError):
            self.mod._执行裁剪恢复({"foo": 1}, self.image, None, None, 5, 5, 1.0)


class LegacyBranch(unittest.TestCase):
    """把 comfy_api.latest 置 None，确认 legacy 分支的类真的能用。"""

    def test_legacy_schema_and_execute(self):
        mod = load_mask_tools(legacy=True)
        self.assertIsNone(mod.io, "legacy 分支里 io 应为 None")
        cls = mod.GG局部重绘裁剪
        self.assertFalse(hasattr(cls, "define_schema"), "legacy 分支不该走 V3")
        必填 = cls.INPUT_TYPES()["required"]
        for 键 in ("图像", "遮罩", "遮罩填充", "低值过滤", "上下文扩展", "画面外扩", "尺寸对齐"):
            self.assertIn(键, 必填)
        接缝, 裁剪图, 裁剪遮罩 = cls().execute(
            图像=make_image(), 遮罩=make_mask((100, 80, 160, 140)),
        )
        self.assertEqual((裁剪图.shape[2], 裁剪图.shape[1]), tuple(接缝["目标宽高"]))
        self.assertEqual(tuple(裁剪遮罩.shape), (1,) + tuple(裁剪图.shape[1:3]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
