"""GG 选择契约测试：输入自动新增、下拉只列已连接分支，且只执行选中的那一路。"""

import importlib.util
import sys
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "flow_tools.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_module():
    spec = importlib.util.spec_from_file_location("gg_flow_tools_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FlowToolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_branch_key_is_connected_child_name(self):
        # 下拉选项就是已连接的子输入名，直接作为键使用。
        self.assertEqual(self.module._分支键("输入2", {"输入1": "甲", "输入2": "乙"}), "输入2")

    def test_empty_choice_falls_back_to_first_connected(self):
        self.assertEqual(self.module._分支键("", {"输入1": "甲", "输入3": "丙"}), "输入1")

    def test_no_connected_input_is_rejected(self):
        with self.assertRaises(ValueError):
            self.module._分支键("输入1", {})

    def test_stale_choice_lists_connected_branches(self):
        with self.assertRaises(ValueError) as ctx:
            self.module._分支键("输入5", {"输入1": "甲", "输入2": "乙"})
        信息 = str(ctx.exception)
        self.assertIn("输入1", 信息)
        self.assertIn("输入2", 信息)

    def test_v1_fallback_is_lazy(self):
        v1 = self.module.GG选择_V1()
        inputs = v1.INPUT_TYPES()
        self.assertEqual(inputs["required"]["生效输入"][0], list(self.module._V1输入选项))
        for 名称 in self.module._V1输入选项:
            self.assertEqual(inputs["optional"][名称], ("*", {"lazy": True}))
        self.assertEqual(v1.check_lazy_status("输入4", 输入4=None), ["输入4"])
        self.assertEqual(v1.execute("输入4", 输入4="完成"), ("完成",))

    def test_v3_schema_uses_connected_branch_selector(self):
        schema = self.module.GG选择.define_schema()
        self.assertEqual(schema.node_id, "GGSwitchBranch")
        self.assertEqual(schema.display_name, "GG 选择")
        输入表 = {item.id: item for item in schema.inputs}
        self.assertEqual(set(输入表), {"autogrow", "生效输入"})
        self.assertEqual(输入表["生效输入"].get_io_type(), "STRING")
        self.assertEqual(输入表["生效输入"].extra_dict.get("widgetType"), "COMFY_BRANCH_SELECTOR")
        分组 = 输入表["autogrow"]
        self.assertEqual(分组.get_io_type(), "COMFY_AUTOGROW_V3")
        self.assertEqual(分组.template.names, list(self.module._输入选项))
        self.assertEqual(分组.template.min, 1)
        子输入 = 分组.template.input
        self.assertEqual(子输入.get_io_type(), "COMFY_MATCHTYPE_V3")
        self.assertTrue(子输入.lazy)
        输出 = schema.outputs[0]
        self.assertEqual(输出.get_io_type(), "COMFY_MATCHTYPE_V3")
        self.assertEqual(子输入.template.template_id, 输出.template.template_id)

    def test_v3_lazy_and_execute_follow_selection(self):
        cls = self.module.GG选择
        self.assertEqual(
            cls.check_lazy_status("输入2", {"输入1": "甲", "输入2": None}),
            ["autogrow.输入2"],
        )
        with self.assertRaises(ValueError):
            cls.check_lazy_status("输入2", {"输入1": "甲"})
        self.assertEqual(cls.execute("输入1", {"输入1": "甲", "输入2": "乙"}).result, ("甲",))
        with self.assertRaises(ValueError):
            cls.execute("输入2", {"输入1": "甲"})


if __name__ == "__main__":
    unittest.main()
