"""器：SAM3 检查点转换脚本的纯张量契约测试。

    cd <ComfyUI 根目录>
    python custom_nodes/ComfyUI-GuliNodes/tools/../tests/test_convert_sam3_checkpoint.py

只测 `_pad_projection` 的语义（不载 3GB 权重、不建模型）：
把 HF 布局的 (hidden, proj) 投影矩阵补到转换后能对上 ComfyUI 期望的形状，
且必须满足「前 proj 行原样保留、其余补零」。
"""

import importlib.util
import os
import sys
import unittest

import torch

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_TOOL_PATH = os.path.join(os.path.dirname(_TESTS_DIR), "tools", "convert_sam3_checkpoint.py")


def _load_tool():
    spec = importlib.util.spec_from_file_location("convert_sam3_checkpoint", _TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class 投影补形状测试(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = _load_tool()

    def test_补到方形且保留原始数据(self):
        source = torch.randn(1024, 512)
        fixed = self.tool._pad_projection(source, (1024, 1024), "k")
        self.assertEqual(tuple(fixed.shape), (1024, 1024))
        # 转换流程会转置一次，所以原始数据在转置后的前 512 行
        converted = fixed.transpose(0, 1)
        self.assertTrue(torch.allclose(converted[:512, :], source.transpose(0, 1)))
        # 补出来的部分必须是零
        self.assertEqual(float(converted[512:, :].abs().max()), 0.0)

    def test_本来就是目标形状时原样返回(self):
        source = torch.randn(1024, 1024)
        fixed = self.tool._pad_projection(source, (1024, 1024), "k")
        self.assertIs(fixed, source)

    def test_非二维直接报错(self):
        with self.assertRaises(RuntimeError):
            self.tool._pad_projection(torch.randn(1024), (1024, 1024), "k")

    def test_超大矩阵截断不崩(self):
        source = torch.randn(2048, 2048)
        fixed = self.tool._pad_projection(source, (1024, 1024), "k")
        self.assertEqual(tuple(fixed.shape), (1024, 1024))


if __name__ == "__main__":
    unittest.main(verbosity=2)
