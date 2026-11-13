import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_module():
    comfy = types.ModuleType("comfy")
    comfy.__path__ = []
    comfy.sd = types.ModuleType("comfy.sd")
    comfy.utils = types.ModuleType("comfy.utils")
    folders = types.ModuleType("folder_paths")
    folders.get_filename_list = lambda _: []
    modules = {"comfy": comfy, "comfy.sd": comfy.sd, "comfy.utils": comfy.utils, "folder_paths": folders}
    path = Path(__file__).resolve().parents[1] / "guli_nodes" / "lora_tools.py"
    spec = importlib.util.spec_from_file_location("test_lora_group_tools", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


module = load_module()


class GroupSelectionTests(unittest.TestCase):
    def setUp(self):
        self.node = module.GGLoRAGroupLoader()
        self.loaded = []
        self.node.load_lora_file = lambda name, strength: self.loaded.append((name, strength)) or name
        self.node.apply_lora_stack = lambda model, data: (model, data)
        self.model = object()
        self.groups = [
            {"id": 1, "name": "人物", "loras": [{"name": "a.safetensors", "strength": 1, "enable": True}]},
            {"id": 2, "name": "风格", "loras": [
                {"name": "b.safetensors", "strength": 0.4, "enable": True},
                {"name": "c.safetensors", "strength": 0.6, "enable": False},
            ]},
        ]
        self.kwargs = {"LoRA1名称": "runtime.safetensors", "LoRA1强度": 0.8, "LoRA1启用": True}

    def run_group(self, choice="", data=None):
        return self.node.load_group(self.model, 1, 1, 选择组=choice,
                                    组数据=json.dumps(self.groups, ensure_ascii=False) if data is None else data,
                                    **self.kwargs)

    def test_legacy_workflow_keeps_original_inputs(self):
        self.run_group(data="")
        self.assertEqual(self.loaded, [("runtime.safetensors", 0.8)])

    def test_select_other_group_and_honor_enable(self):
        self.run_group("2. 风格")
        self.assertEqual(self.loaded, [("b.safetensors", 0.4)])

    def test_select_current_group_keeps_resolved_connected_values(self):
        self.run_group("1. 人物")
        self.assertEqual(self.loaded, [("runtime.safetensors", 0.8)])

    def test_external_string_can_use_unique_group_name(self):
        self.run_group("风格")
        self.assertEqual(self.loaded, [("b.safetensors", 0.4)])

    def test_duplicate_group_names_need_numbered_option(self):
        self.groups[1]["name"] = "人物"
        with self.assertRaisesRegex(ValueError, "名称重复"):
            self.run_group("人物")
        self.run_group("2. 人物")
        self.assertEqual(self.loaded, [("b.safetensors", 0.4)])

    def test_invalid_group_and_data_have_actionable_error(self):
        with self.assertRaisesRegex(ValueError, "无效"):
            self.run_group("2. 风格", "bad json")
        with self.assertRaisesRegex(ValueError, "不存在"):
            self.run_group("找不到")

    def test_new_widgets_are_appended_and_change_cache_key(self):
        names = list(self.node.INPUT_TYPES()["optional"])
        self.assertEqual(names[-3:], ["LoRA20启用", "选择组", "组数据"])
        first = self.node.IS_CHANGED(模型=self.model, 选择组="1. 人物", 组数据="one")
        second = self.node.IS_CHANGED(模型=self.model, 选择组="2. 风格", 组数据="two")
        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
