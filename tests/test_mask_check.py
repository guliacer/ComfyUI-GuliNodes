"""GG 蒙版诊断契约测试：真实 torch；只加载单个模块，不导入插件注册器或模型。"""

import importlib
import importlib.machinery
import importlib.util
import sys
import types
import unittest
from pathlib import Path

import torch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "mask_check.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_mask_check(legacy=True):
    """按文件加载隔离模块；legacy 时把 comfy_api.latest 置 None 走纯 legacy 分支。"""
    if not MODULE_PATH.is_file():
        raise AssertionError("缺少 guli_nodes/mask_check.py")
    package_name = "_mask_check_test_host"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(PLUGIN_ROOT / "guli_nodes")]
        package.__spec__ = importlib.machinery.ModuleSpec(package_name, loader=None, is_package=True)
        sys.modules[package_name] = package
    module_name = package_name + (".mask_check_legacy" if legacy else ".mask_check_v3")
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    if legacy:
        previous = sys.modules.get("comfy_api.latest", None)
        sys.modules["comfy_api.latest"] = None
        try:
            spec.loader.exec_module(module)
        finally:
            if previous is None:
                sys.modules.pop("comfy_api.latest", None)
            else:
                sys.modules["comfy_api.latest"] = previous
    else:
        spec.loader.exec_module(module)
    return module


MOD = load_mask_check(legacy=True)


def image(height=100, width=80, channels=3, value=0.25):
    return torch.full((1, height, width, channels), value)


def mask_of(ratio_height=0.5, ratio_width=0.5, value=1.0, height=100, width=80):
    mask = torch.zeros((1, height, width))
    mask[:, : max(1, int(height * ratio_height)), : max(1, int(width * ratio_width))] = value
    return mask


class MaskCheckTests(unittest.TestCase):
    def test_normal_mask_is_usable_and_reports_ratio(self):
        out, text, ok = MOD.diagnose(image(), mask_of(0.5, 0.5))
        self.assertTrue(ok)
        self.assertIn("人物有效区 25.00%", text)
        self.assertIn("尺寸一致", text)
        self.assertIn("结论：可用", text)
        self.assertEqual(tuple(out.shape), (1, 100, 80, 3))

    def test_all_black_mask_explains_not_saved(self):
        out, text, ok = MOD.diagnose(image(), torch.zeros(1, 100, 80))
        self.assertFalse(ok)
        self.assertIn("0.00%", text)
        self.assertIn("没有涂上", text)
        self.assertIn("遮罩编辑器", text)

    def test_all_white_mask_is_rejected(self):
        _, text, ok = MOD.diagnose(image(), torch.ones(1, 100, 80))
        self.assertFalse(ok)
        self.assertIn("全白", text)

    def test_tiny_mask_hints_inversion(self):
        small = torch.zeros(1, 100, 80)
        small[0, :1, :1] = 1  # 1/8000 = 0.0125%
        _, text, ok = MOD.diagnose(image(), small)
        self.assertFalse(ok)
        self.assertIn("不足 0.2%", text)
        self.assertIn("涂反", text)
        self.assertIn("白色才是人物", text)

    def test_size_mismatch_previews_scaled_but_marks_unusable(self):
        out, text, ok = MOD.diagnose(image(), torch.ones(1, 50, 40) * 0.5)
        self.assertFalse(ok)
        self.assertIn("尺寸不一致", text)
        self.assertIn("正式节点会拒绝", text)
        self.assertEqual(tuple(out.shape), (1, 100, 80, 3))

    def test_soft_edge_mask_counts_pixels_above_threshold(self):
        soft = torch.zeros(1, 100, 80)
        soft[:, :50, :] = 0.5   # 中间权重，仍大于 0.1 阈值
        soft[:, 50:, :] = 0.05  # 过低，不参与编辑
        _, text, ok = MOD.diagnose(image(), soft)
        self.assertTrue(ok)
        self.assertIn("人物有效区 50.00%", text)
        self.assertIn("权重不高于 0.1", text)

    def test_mask_shapes_2d_3d_4d_are_accepted(self):
        base = mask_of(0.5, 0.5, height=40, width=30)
        variants = [base[0], base, base[:, None]]
        for index, mask in enumerate(variants):
            with self.subTest(shape=tuple(mask.shape)):
                _, text, ok = MOD.diagnose(image(40, 30), mask)
                self.assertTrue(ok, text)

    def test_invalid_mask_shape_explains(self):
        _, text, ok = MOD.diagnose(image(), torch.zeros(1, 100, 80, 2))
        self.assertFalse(ok)
        self.assertIn("不支持", text)

    def test_batched_mask_warns_batch_and_uses_first(self):
        mask = torch.stack([mask_of(0.5, 0.5), mask_of(0.5, 0.5)])
        _, text, ok = MOD.diagnose(image(), mask)
        self.assertIn("遮罩含 2 张", text)
        self.assertIn("正式节点会拒绝多张批次", text)

    def test_invalid_image_returns_placeholder(self):
        out, text, ok = MOD.diagnose(None, mask_of())
        self.assertFalse(ok)
        self.assertIn("图像输入无效", text)
        self.assertEqual(tuple(out.shape[:2]), (1, 64))

    def test_preview_highlights_person_region_only(self):
        mask = mask_of(0.5, 0.5)
        out, _, _ = MOD.diagnose(image(value=0.2), mask, "青绿", 0.5, 0.2)
        person = out[:, :50, :40, :].mean().item()
        background = out[:, 50:, 40:, :].mean().item()
        self.assertGreater(person, background)
        self.assertGreaterEqual(out.min().item(), 0.0)
        self.assertLessEqual(out.max().item(), 1.0)

    def test_zero_effects_keep_original_pixels(self):
        src = image(value=0.3)
        out, _, _ = MOD.diagnose(src, mask_of(0.5, 0.5), "品红", 0.0, 0.0)
        torch.testing.assert_close(out, src, rtol=0, atol=1e-6)

    def test_legacy_and_v3_api_expose_same_contract(self):
        cls = MOD.GGMaskCheck
        self.assertEqual(cls.RETURN_TYPES, ("IMAGE", "STRING", "BOOLEAN"))
        self.assertEqual(cls.RETURN_NAMES, ("预览图", "诊断", "是否可用"))
        inputs = cls.INPUT_TYPES()["required"]
        self.assertIn("图像", inputs)
        self.assertIn("人像遮罩", inputs)
        self.assertIn(MOD.NODE_CLASS_MAPPINGS["GGMaskCheck"], (cls,))

    def test_v3_schema_registers_when_api_available(self):
        v3 = load_mask_check(legacy=False)
        cls = v3.GGMaskCheck
        schema = cls.define_schema()
        self.assertEqual(schema.node_id, "GGMaskCheck")
        self.assertEqual(schema.display_name, "GG 蒙版诊断")
        self.assertEqual(len(schema.inputs), 5)
        self.assertEqual(len(schema.outputs), 3)


if __name__ == "__main__":
    unittest.main()
