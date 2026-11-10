"""GG 图像加载契约测试：遮罩优先级、Alpha 回退、批次与双路 schema。"""

import importlib.util
import sys
import tempfile
import unittest
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
