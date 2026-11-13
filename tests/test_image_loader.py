"""GG 图像加载契约测试：遮罩优先级、Alpha 回退、批次与双路 schema。"""

import importlib.util
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
from PIL import Image


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "image_loader.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_module(legacy=False):
    name = "_guli_image_loader_legacy" if legacy else "_guli_image_loader_v3"
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


class ImageLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module()

    def test_manual_mask_has_priority_over_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "photo.png"
            mask_path = root / "custom.png"
            rgba = np.zeros((4, 6, 4), dtype=np.uint8)
            rgba[..., :3] = [80, 120, 160]
            rgba[..., 3] = 0
            Image.fromarray(rgba, "RGBA").save(image_path)
            Image.fromarray(np.full((4, 6), 180, dtype=np.uint8), "L").save(mask_path)
            original = self.mod.folder_paths.get_annotated_filepath
            self.mod.folder_paths.get_annotated_filepath = lambda value: str(root / value)
            try:
                with Image.open(image_path) as image:
                    mask = self.mod._resolve_mask(str(image_path), "custom.png", image, 4, 6)
            finally:
                self.mod.folder_paths.get_annotated_filepath = original
            self.assertAlmostEqual(float(mask.mean()), 180 / 255, places=6)

    def test_alpha_is_inverted_for_comfy_mask(self):
        image = Image.new("RGBA", (3, 2), (20, 30, 40, 64))
        mask = self.mod._resolve_mask("missing.png", "", image, 2, 3)
        self.assertAlmostEqual(float(mask.mean()), 1.0 - 64 / 255, places=6)

    def test_missing_mask_is_zero(self):
        image = Image.new("RGB", (3, 2), (20, 30, 40))
        mask = self.mod._resolve_mask("missing.png", "", image, 2, 3)
        self.assertEqual(float(mask.max()), 0.0)
        self.assertEqual(tuple(mask.shape), (2, 3))

    def test_execution_has_no_native_preview_or_temporary_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (6, 4), (80, 120, 160)).save(root / "photo.png")
            for legacy in (False, True):
                with self.subTest(legacy=legacy):
                    mod = load_module(legacy)
                    with patch.object(mod.folder_paths, "input_directory", directory), patch.object(
                        mod.folder_paths, "get_temp_directory", side_effect=AssertionError("不应再生成第二张预览")
                    ):
                        result = mod.GGImageLoad().load_image("photo.png") if legacy else mod.GGImageLoad.execute("photo.png")
                    if legacy:
                        self.assertIsInstance(result, tuple)
                        images, masks = result
                    else:
                        self.assertIsNone(result.ui)
                        images, masks = result.result
                    self.assertEqual(tuple(images.shape), (1, 4, 6, 3))
                    self.assertEqual(tuple(masks.shape), (1, 4, 6))
                    self.assertAlmostEqual(float(images[0, 0, 0, 0]), 80 / 255, places=6)
                    self.assertEqual(float(masks.max()), 0.0)

    def test_official_editor_annotation_validation_and_alpha_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clipspace").mkdir()
            rgba = np.empty((4, 6, 4), dtype=np.uint8)
            rgba[..., :3] = [80, 120, 160]
            rgba[..., 3] = 255
            rgba[1:3, 2:4, 3] = 0
            rgba[0, 0, 3] = 128
            filename = "clipspace/clipspace-painted-masked-123456.png"
            Image.fromarray(rgba).save(root / filename)
            value = filename + " [input]"
            for legacy in (False, True):
                with self.subTest(legacy=legacy):
                    mod = load_module(legacy)
                    with patch.object(mod.folder_paths, "input_directory", directory):
                        cls = mod.GGImageLoad
                        validate = cls.VALIDATE_INPUTS if legacy else cls.validate_inputs
                        self.assertIs(validate(value), True)
                        self.assertIn("图像文件不存在", validate("missing.png [input]"))
                        self.assertIn("遮罩文件不存在", validate(value, "missing-mask.png"))
                        result = cls().load_image(value) if legacy else cls.execute(value)
                        images, masks = result if legacy else result.result
                        expected = 1 - rgba[..., 3].astype(np.float32) / 255
                        np.testing.assert_allclose(masks[0].numpy(), expected)
                        np.testing.assert_allclose(images[0].numpy(), rgba[..., :3] / 255, atol=1e-7)

    def test_sidecar_keeps_priority_and_invalidates_cached_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGBA", (6, 4), (80, 120, 160, 0)).save(root / "photo.png")
            sidecar = root / "photo_mask.png"
            Image.new("L", (6, 4), 80).save(sidecar)
            with patch.object(self.mod.folder_paths, "input_directory", directory):
                before = self.mod.GGImageLoad.fingerprint_inputs("photo.png")
                _, masks, _, _ = self.mod._read_image("photo.png")
                self.assertAlmostEqual(float(masks.mean()), 80 / 255, places=6)
                Image.new("L", (6, 4), 180).save(sidecar)
                self.assertNotEqual(before, self.mod.GGImageLoad.fingerprint_inputs("photo.png"))

    def test_mask_combo_defaults_to_no_explicit_mask(self):
        legacy = load_module(legacy=True)
        self.assertEqual(legacy.GGImageLoad.INPUT_TYPES()["optional"]["遮罩文件"][0][0], "")
        self.assertEqual(self.mod.GGImageLoad.define_schema().inputs[1].options[0], "")

    def test_legacy_and_v3_definitions_exist(self):
        legacy = load_module(legacy=True)
        self.assertIsNone(legacy.io)
        self.assertIn("图像", legacy.GGImageLoad.INPUT_TYPES()["required"])
        self.assertIn("遮罩文件", legacy.GGImageLoad.INPUT_TYPES()["optional"])
        self.assertTrue(hasattr(self.mod.GGImageLoad, "define_schema"))
        schema = self.mod.GGImageLoad.FINALIZE_SCHEMA()
        self.assertEqual(len(schema.inputs), 2)
        self.assertEqual(len(schema.outputs), 2)


if __name__ == "__main__":
    unittest.main()
