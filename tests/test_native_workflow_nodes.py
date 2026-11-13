"""人像精修工作流只用本插件 / 配套依赖包与 ComfyUI 原生节点，防止回退到第三方插件。"""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "example_workflows" / "人像精修工作流.json"

CORE_NODE_TYPES = {
    "LoadImage", "UNETLoader", "CLIPLoader", "VAELoader", "VAEEncode", "VAEDecode",
    "SetLatentNoiseMask", "KSampler", "ComfySwitchNode", "PrimitiveBoolean",
    "RandomNoise", "KSamplerSelect", "ManualSigmas", "BasicGuider",
    "SamplerCustomAdvanced", "PreviewImage", "Note",
}


class NativeWorkflowNodeTests(unittest.TestCase):
    def load(self):
        self.assertTrue(WORKFLOW.is_file(), "人像精修工作流不存在")
        data = json.loads(WORKFLOW.read_text(encoding="utf-8"))
        subgraphs = (data.get("definitions") or {}).get("subgraphs") or []
        graphs = [data] + subgraphs
        subgraph_ids = {subgraph["id"] for subgraph in subgraphs}
        return data, graphs, subgraph_ids

    def test_no_third_party_node_types(self):
        _, graphs, subgraph_ids = self.load()
        for graph in graphs:
            for node in graph.get("nodes") or []:
                node_type = node["type"]
                self.assertTrue(
                    node_type.startswith("GG")
                    or node_type in CORE_NODE_TYPES
                    or node_type in subgraph_ids,
                    f"节点类型 {node_type} 不是本插件节点，工作流又依赖第三方插件了",
                )

    def test_auto_mask_and_edge_nodes_are_native(self):
        _, graphs, _ = self.load()
        roles = {}
        for graph in graphs:
            for node in graph.get("nodes") or []:
                role = (node.get("properties") or {}).get("gg_region_role")
                if role:
                    roles[role] = node
        self.assertEqual(roles["auto_mask_model"]["type"], "GGSAM3ModelLoader")
        self.assertEqual(roles["auto_mask"]["type"], "GGSAM3TextSegment")
        self.assertEqual(roles["auto_mask"]["widgets_values"], ["person", 0.4, -1, False])
        self.assertEqual(roles["mask_grow"]["type"], "GGMaskEdge")
        self.assertEqual(roles["mask_grow"]["widgets_values"], [0, 0])
        self.assertEqual(roles["mask_shrink"]["type"], "GGMaskEdge")
        self.assertEqual(roles["mask_shrink"]["widgets_values"], [-6, 5])

    def test_auto_mask_link_uses_gg_type(self):
        data, _, _ = self.load()
        subgraph = [
            item for item in data["definitions"]["subgraphs"]
            if item["id"] == "02e0192e-f6ca-49fa-b401-38b488e4fb4b"
        ][0]
        links = {link["id"]: link for link in subgraph["links"]}
        self.assertEqual(links[160]["type"], "GG_SAM3_MODEL")
        self.assertEqual(links[160]["target_slot"], 0)


if __name__ == "__main__":
    unittest.main()
