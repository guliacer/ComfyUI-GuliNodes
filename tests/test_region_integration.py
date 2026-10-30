"""真实 GG 裁剪/恢复/合并的单图集成测试，不加载生成模型。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent.parent))
sys.path.insert(0, str(ROOT))

import torch
from guli_nodes.region_edit import prepare_region
from guli_nodes.mask_tools import _执行遮罩裁剪, _执行裁剪恢复, _执行图像合并, _遮罩数组


class RegionPipelineIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.image = torch.linspace(0.1, 0.9, 31 * 47 * 3).reshape(1, 31, 47, 3)
        self.mask = torch.zeros((1, 31, 47))
        self.mask[:, 6:25, 17:31] = 1

    def stage(self, image, region):
        prepared = prepare_region(image, self.mask, region, "只调整本区域质感", "保持构图")
        seam, cropped, crop_mask = _执行遮罩裁剪(prepared[0], prepared[1], False, {side: 1.1 for side in "上下左右"}, "按宽高", {"宽度": 64, "高度": 64})
        changed = torch.full_like(cropped, 0.3 if region == "背景" else 0.6)
        restored = _执行裁剪恢复(seam, changed, None, image, 0, 0, 0.0)
        final = _执行图像合并(image, restored, prepared[1], 1.0, 0, 0, False)
        return final

    def test_background_edit_does_not_change_person_pixels(self):
        result = self.stage(self.image, "背景")
        self.assertEqual(result.shape, self.image.shape)
        self.assertTrue(torch.equal(result[self.mask.bool()], self.image[self.mask.bool()]))
        self.assertFalse(torch.equal(result[~self.mask.bool()], self.image[~self.mask.bool()]))

    def test_person_edit_keeps_completed_background_exactly(self):
        background = self.stage(self.image, "背景")
        final = self.stage(background, "人像")
        self.assertEqual(final.shape, self.image.shape)
        self.assertTrue(torch.equal(final[~self.mask.bool()], background[~self.mask.bool()]))
        self.assertFalse(torch.equal(final[self.mask.bool()], background[self.mask.bool()]))

    def test_rgba_preparation_keeps_rgb_under_transparency(self):
        rgba = torch.cat((self.image, 1 - self.mask.unsqueeze(-1)), dim=-1)
        prepared = prepare_region(rgba, self.mask, "人像", "微调皮肤", "")
        self.assertTrue(torch.equal(prepared[0], self.image))
        self.assertTrue(torch.equal(rgba[..., :3], self.image))

    def test_float64_threshold_must_not_trigger_existing_crop_full_frame_fallback(self):
        image = torch.full((1, 20, 25, 3), 0.4)
        mask = torch.zeros((1, 20, 25), dtype=torch.float64)
        mask[0, 10, 12] = 0.1 + 2 ** -32
        # 在float64中恰好1/500有效；已有裁剪会先转float32，随后有效面积为0。
        self.assertEqual(torch.count_nonzero(mask > 0.1).item(), 1)
        self.assertEqual(int((_遮罩数组(mask) > 0.1).sum()), 0)
        with self.assertRaisesRegex(ValueError, "0.2%|阈值|精度"):
            prepare_region(image, mask, "人像", "只修人物", "")


if __name__ == "__main__":
    unittest.main()
