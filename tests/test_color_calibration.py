"""GG 颜色校准契约测试：双图锚点、自动遮罩、两种遮罩外处理与双路 schema。"""

import importlib.util
import sys
import unittest
from pathlib import Path

import torch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "color_calibration.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_module(legacy=False):
    name = "_guli_color_calibration_legacy" if legacy else "_guli_color_calibration_v3"
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get("comfy_api.latest")
    if legacy:
        sys.modules["comfy_api.latest"] = None
    try:
        sys.modules[name] = module
        spec.loader.exec_module(module)
    finally:
        if legacy:
            if previous is None:
                sys.modules.pop("comfy_api.latest", None)
            else:
                sys.modules["comfy_api.latest"] = previous
    return module


def make_scene(batch=1, height=64, width=64, rgba=False):
    ys = torch.linspace(0.08, 0.86, height).view(height, 1).expand(height, width)
    xs = torch.linspace(0.05, 0.92, width).view(1, width).expand(height, width)
    rgb = torch.stack([ys, xs, 0.55 * ys + 0.45 * xs], dim=-1)
    image = rgb.unsqueeze(0).expand(batch, -1, -1, -1).clone()
    if rgba:
        alpha = torch.full((batch, height, width, 1), 0.4)
        image = torch.cat([image, alpha], dim=-1)
    return image


class ColorCalibrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module()

    def test_manual_mask_restores_original_outside_change(self):
        original = make_scene()
        edited = (original[..., :3] * torch.tensor([0.72, 0.84, 0.66]) + torch.tensor([0.18, 0.08, 0.14])).clamp(0, 1)
        mask = torch.zeros(1, 64, 64)
        mask[:, 20:44, 20:44] = 1
        edited[:, 20:44, 20:44] = torch.tensor([0.95, 0.12, 0.08])

        output, change_mask, ratio = self.mod._calibrate(
            original, edited, 0.08, 0, 1, 1, 0, 1.0, "还原原图", mask
        )
        outside = (mask < 0.5).unsqueeze(-1).expand_as(output)
        self.assertEqual(float(ratio), 0.140625)
        self.assertEqual(float(change_mask[:, 20:44, 20:44].mean()), 1.0)
        self.assertLess(float((output[outside] - original[outside]).abs().max()), 1e-5)
        self.assertGreater(float((output[:, 20:44, 20:44] - original[:, 20:44, 20:44]).abs().mean()), 0.05)

    def test_auto_mask_detects_only_local_change(self):
        original = make_scene()
        edited = original.clone()
        edited[:, 20:44, 20:44] = torch.tensor([0.95, 0.12, 0.08])
        output, change_mask, ratio = self.mod._calibrate(
            original, edited, 0.08, 0, 1, 1, 0, 1.0, "还原原图"
        )
        self.assertEqual(tuple(output.shape), tuple(original.shape))
        self.assertAlmostEqual(float(ratio), 0.140625, places=6)
        self.assertEqual(float(change_mask[:, :10, :10].mean()), 0.0)
        self.assertEqual(float(change_mask[:, 20:44, 20:44].mean()), 1.0)

    def test_keep_edited_mode_preserves_outside_detail(self):
        original = make_scene()
        edited = original.clone()
        checker = (torch.arange(64).view(1, 64) + torch.arange(64).view(64, 1)) % 2
        edited[..., 0] = (edited[..., 0] + checker.float() * 0.18).clamp(0, 1)
        mask = torch.zeros(1, 64, 64)
        mask[:, 20:44, 20:44] = 1
        edited[:, 20:44, 20:44] = torch.tensor([0.95, 0.12, 0.08])

        output, _, _ = self.mod._calibrate(
            original, edited, 0.08, 0, 1, 1, 0, 1.0, "保留编辑图", mask
        )
        outside = (mask < 0.5).unsqueeze(-1).expand_as(output)
        outside_delta = (output[outside] - original[outside]).abs().mean()
        self.assertGreater(float(outside_delta), 0.01)
        self.assertLess(abs(float(output[:, :10, :10, 0].mean() - original[:, :10, :10, 0].mean())), 0.08)

    def test_batch_rgba_and_manual_mask_resize(self):
        original = make_scene(batch=2, rgba=True)
        edited = original.clone()
        edited[:, 16:40, 16:40, :3] = torch.tensor([0.9, 0.1, 0.05])
        small_mask = torch.zeros(1, 32, 32)
        small_mask[:, 8:20, 8:20] = 1
        output, change_mask, _ = self.mod._calibrate(
            original, edited, 0.08, 0, 1, 1, 0, 1.0, "还原原图", small_mask
        )
        self.assertEqual(tuple(output.shape), (2, 64, 64, 4))
        self.assertEqual(tuple(change_mask.shape), (2, 64, 64))
        self.assertAlmostEqual(float(output[..., 3].mean()), 0.4, places=6)

    def test_legacy_and_v3_inputs_are_available(self):
        legacy = load_module(legacy=True)
        self.assertIsNone(legacy.io)
        required = set(legacy.GG颜色校准.INPUT_TYPES()["required"])
        self.assertIn("原始图像", required)
        self.assertIn("遮罩外处理", required)
        self.assertIn("遮罩", legacy.GG颜色校准.INPUT_TYPES()["optional"])
        self.assertTrue(hasattr(self.mod.GG颜色校准, "define_schema"))


if __name__ == "__main__":
    unittest.main()
