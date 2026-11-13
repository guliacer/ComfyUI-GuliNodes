"""Regression tests preventing CLIP/VAE loading from returning to processors."""

import json
import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = ROOT.parent.parent
for root in (ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from guli_nodes.clipboard import GGCLIPText
from guli_nodes.prompt_enhancer import GGPromptEnhancer
from guli_nodes.prompt_optimizer import GGPromptOptimizer


class ModelLoaderSeparationTests(unittest.TestCase):
    def test_processing_modules_have_no_private_clip_or_vae_loaders(self):
        forbidden = re.compile(
            r"comfy\.sd\.load_(?:clip|vae)|"
            r"\b(?:_clip_cache|_vae_cache)\b|"
            r"\bdef\s+_get_(?:clip|vae)\s*\("
        )
        for name in ("clipboard.py", "model_loaders.py", "prompt_optimizer.py", "prompt_enhancer.py"):
            with self.subTest(module=name):
                source = (ROOT / "guli_nodes" / name).read_text(encoding="utf-8")
                self.assertIsNone(forbidden.search(source), f"{name} contains private CLIP/VAE loading")

    def test_clip_processor_requires_typed_model_input(self):
        clip_inputs = GGCLIPText.INPUT_TYPES()["required"]
        self.assertEqual(clip_inputs["clip"][0], "CLIP")
        self.assertNotIn("CLIP名称", clip_inputs)
        self.assertNotIn("类型", clip_inputs)

    def test_prompt_optimizer_uses_external_clip_and_vae_without_model_selectors(self):
        input_names = [item.id for item in GGPromptOptimizer.define_schema().inputs]
        self.assertIn("clip", input_names)
        self.assertIn("vae", input_names)
        self.assertNotIn("CLIP名称", input_names)
        self.assertNotIn("CLIP类型", input_names)
        self.assertNotIn("VAE名称", input_names)


    def test_prompt_enhancer_pe_inputs_are_external_clip(self):
        input_ids = [item.id for item in GGPromptEnhancer.define_schema().inputs]
        for name in ("文生图PE模型", "图生图PE模型"):
            self.assertIn(name, input_ids)
        self.assertNotIn("文生图PE模型文件名", input_ids)
        self.assertNotIn("图生图PE模型文件名", input_ids)
        source = (ROOT / "guli_nodes" / "prompt_enhancer.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"comfy\.sd\.load_(?:clip|vae)", source))
        self.assertIsNone(re.search(r"\b(?:_clip_cache|_vae_cache)\b", source))

    def test_example_workflows_have_split_model_inputs(self):
        files = [
            ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.json",
            ROOT / "example_workflows" / "人像精修工作流.json",
        ]
        valid_unload = {"自动", "保持加载", "运行后自动卸载", "运行前后自动卸载"}
        for path in files:
            with self.subTest(file=path.name):
                data = json.loads(path.read_text(encoding="utf-8"))
                nodes = list(data.get("nodes") or [])
                for graph in (data.get("definitions") or {}).get("subgraphs") or []:
                    nodes.extend(graph.get("nodes") or [])
                optimizers = [node for node in nodes if node.get("type") == "GGPromptOptimizer"]
                enhancers = [node for node in nodes if node.get("type") == "GGPromptEnhancer"]
                self.assertTrue(optimizers, "示例工作流缺少提示词优化节点")
                self.assertTrue(enhancers, "示例工作流缺少提示词增强节点")
                for node in optimizers:
                    values = node.get("widgets_values") or []
                    named = node.get("widgets_values_named") or {}
                    self.assertEqual(len(values), 3, f"优化节点 {node.get('id')} 仍是旧控件布局")
                    for key in ("CLIP名称", "CLIP类型", "VAE名称"):
                        self.assertNotIn(key, named)
                        self.assertNotIn(key, node.get("properties") or {})
                    inputs = {item.get("name"): item for item in node.get("inputs") or []}
                    self.assertEqual(inputs["clip"].get("type"), "CLIP")
                    self.assertIsNotNone(inputs["clip"].get("link"), "优化节点 clip 未接线")
                    self.assertEqual(inputs["vae"].get("type"), "VAE")
                    self.assertIsNotNone(inputs["vae"].get("link"), "优化节点 vae 未接线")
                for node in enhancers:
                    values = node.get("widgets_values") or []
                    named = node.get("widgets_values_named") or {}
                    self.assertEqual(len(values), 17, f"增强节点 {node.get('id')} 仍是旧控件布局")
                    for key in ("文生图PE模型", "图生图PE模型", "生成后自动卸载模型"):
                        self.assertNotIn(key, named)
                    self.assertIn(named.get("卸载策略"), valid_unload)
                    inputs = {item.get("name"): item for item in node.get("inputs") or []}
                    for name in ("文生图PE模型", "图生图PE模型"):
                        slot = inputs[name]
                        self.assertEqual(slot.get("type"), "CLIP")
                        self.assertNotIn("widget", slot)

    def test_example_api_has_no_embedded_pe_models(self):
        path = ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.api.json"
        api = json.loads(path.read_text(encoding="utf-8"))
        valid_unload = {"自动", "保持加载", "运行后自动卸载", "运行前后自动卸载"}
        for node_id in ("12", "32"):
            inputs = api[node_id]["inputs"]
            for key in ("文生图PE模型", "图生图PE模型", "生成后自动卸载模型"):
                self.assertNotIn(key, inputs)
            self.assertIn(inputs.get("卸载策略"), valid_unload)
        for node_id in ("15", "35"):
            inputs = api[node_id]["inputs"]
            for key in ("CLIP名称", "CLIP类型", "VAE名称"):
                self.assertNotIn(key, inputs)
            self.assertIsInstance(inputs.get("clip"), list)
            self.assertIsInstance(inputs.get("vae"), list)


    def test_user_documentation_describes_external_models_only(self):
        forbidden = (
            "生成后自动卸载模型",
            "CLIP名称",
            "CLIP类型",
            "VAE名称",
            "GuliNodes VAE 缓存",
            "VAE 缓存编码",
            "VAE 缓存解码",
        )
        files = [
            ROOT / "README.md",
            ROOT / "docs" / "使用指南.md",
            ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_使用说明.md",
        ]
        for path in files:
            with self.subTest(file=path.name):
                source = path.read_text(encoding="utf-8")
                for phrase in forbidden:
                    self.assertNotIn(
                        phrase,
                        source,
                        f"{path.name} 仍在描述旧的融合式模型控件或私有缓存：{phrase}",
                    )

if __name__ == "__main__":
    unittest.main(verbosity=2)
