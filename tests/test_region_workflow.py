"""交付工作流的结构验收；不加载模型、不访问外部 API。"""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.json"


class RegionWorkflowContractTests(unittest.TestCase):
    def load_graph(self):
        self.assertTrue(WORKFLOW.is_file(), "人像/背景分区编辑工作流尚未生成")
        data = json.loads(WORKFLOW.read_text(encoding="utf-8"))
        nodes = {n["id"]: n for n in data["nodes"]}
        roles = {n.get("properties", {}).get("gg_region_role"): n for n in data["nodes"]}
        links = {l[0]: l for l in data["links"]}
        return data, nodes, roles, links

    def source(self, node, name, links):
        slot = next((i for i in node.get("inputs", []) if i["name"] == name), None)
        self.assertIsNotNone(slot, "缺少输入 " + name)
        self.assertIsNotNone(slot.get("link"), "必要输入未连线 " + name)
        edge = links[slot["link"]]
        return edge[1], edge[2]

    def test_all_edges_and_slots_are_bidirectionally_consistent(self):
        data, nodes, _, links = self.load_graph()
        self.assertEqual(len(nodes), len(data["nodes"]))
        self.assertEqual(len(links), len(data["links"]))
        for lid, src, ss, dst, ds, dtype in data["links"]:
            self.assertIn(src, nodes)
            self.assertIn(dst, nodes)
            self.assertLess(ss, len(nodes[src]["outputs"]))
            self.assertLess(ds, len(nodes[dst]["inputs"]))
            self.assertEqual(nodes[dst]["inputs"][ds]["link"], lid)
            self.assertIn(lid, nodes[src]["outputs"][ss].get("links") or [])
            out_type = nodes[src]["outputs"][ss]["type"]
            in_type = nodes[dst]["inputs"][ds]["type"]
            if out_type != "*" and in_type != "*":
                self.assertEqual(out_type, in_type)

    def test_graph_is_acyclic(self):
        data, nodes, _, _ = self.load_graph()
        incoming = {nid: 0 for nid in nodes}
        edges = {nid: [] for nid in nodes}
        for _, src, _, dst, _, _ in data["links"]:
            edges[src].append(dst)
            incoming[dst] += 1
        ready = [nid for nid, degree in incoming.items() if degree == 0]
        seen = 0
        while ready:
            nid = ready.pop()
            seen += 1
            for dst in edges[nid]:
                incoming[dst] -= 1
                if incoming[dst] == 0:
                    ready.append(dst)
        self.assertEqual(seen, len(nodes), "工作流存在循环依赖")

    def test_only_core_and_gg_node_types_are_used(self):
        _, nodes, _, _ = self.load_graph()
        allowed_core = {"LoadImage", "UNETLoader", "CLIPLoader", "VAELoader", "VAEEncode", "VAEDecode", "SetLatentNoiseMask", "KSampler", "ComfySwitchNode", "PrimitiveBoolean", "PrimitiveInt", "PrimitiveString", "Note", "PreviewImage", "MaskToImage",
                        "easy sam3ModelLoader", "easy sam3ImageSegmentation", "LayerMask: MaskGrow"}
        for node in nodes.values():
            self.assertTrue(node["type"].startswith("GG") or node["type"] in allowed_core, node["type"])
        self.assertEqual(sum(n["type"] == "GGRegionEditPrepare" for n in nodes.values()), 2)

    def test_region_preparation_precedes_all_crop_and_inversion(self):
        _, _, roles, links = self.load_graph()
        pick = roles["mask_pick"]
        self.assertEqual(pick["type"], "ComfySwitchNode")
        # 手绘来源必须仍直连原图 MASK，自动来源必须是 SAM3 的 obj_masks
        self.assertEqual(self.source(pick, "on_false", links), (roles["original"]["id"], 1))
        # on_true 经「蒙版修边」节点（膨胀+羽化防残影），其来源是 SAM3 的 masks(槽0)
        grow = roles["mask_grow"]
        self.assertEqual(grow["type"], "LayerMask: MaskGrow")
        self.assertEqual(self.source(grow, "mask", links), (roles["auto_mask"]["id"], 0))
        self.assertEqual(self.source(pick, "on_true", links), (grow["id"], 0))
        for region in ("background", "person"):
            prep = roles[region + "_prepare"]
            self.assertEqual(prep["type"], "GGRegionEditPrepare")
            self.assertEqual(self.source(prep, "人像遮罩", links), (pick["id"], 0))
            self.assertEqual(self.source(roles[region + "_crop"], "遮罩", links), (prep["id"], 1))
            self.assertEqual(self.source(roles[region + "_crop"], "图像", links), (prep["id"], 0))

    def test_auto_mask_branch_is_text_driven_and_on_by_default(self):
        _, _, roles, links = self.load_graph()
        seg = roles["auto_mask"]
        self.assertEqual(seg["widgets_values"][0], "person")
        switch = roles["auto_mask_switch"]
        self.assertEqual(switch["type"], "PrimitiveBoolean")
        self.assertIs(switch["widgets_values"][0], True)
        self.assertEqual(self.source(roles["mask_pick"], "switch", links), (switch["id"], 0))

    def test_serial_stage_person_then_background(self):
        # 串行：人像阶段从原图出发，背景阶段基于人像结果（处理后的图像）取反蒙版处理
        _, _, roles, links = self.load_graph()
        # 人像阶段：从原图出发
        self.assertEqual(self.source(roles["person_prepare"], "图像", links), (roles["original"]["id"], 0))
        self.assertEqual(self.source(roles["person_restore"], "背景图像", links), (roles["original"]["id"], 0))
        # 背景阶段：图像与贴回底图都来自人像阶段结果，而非原图
        self.assertEqual(self.source(roles["background_prepare"], "图像", links), (roles["person_select"]["id"], 0))
        self.assertEqual(self.source(roles["background_restore"], "背景图像", links), (roles["person_select"]["id"], 0))

    def test_empty_requests_lazily_skip_entire_region_branch(self):
        _, nodes, roles, links = self.load_graph()
        for region in ("background", "person"):
            prep = roles[region + "_prepare"]
            switch = roles[region + "_select"]
            self.assertEqual(switch["type"], "ComfySwitchNode")
            self.assertEqual(self.source(switch, "switch", links), (prep["id"], 4))
            self.assertEqual(self.source(switch, "on_false", links), (prep["id"], 0))
        output_roles = {"save", "mask_preview", "instructions", "auto_mask", "auto_mask_switch", "mask_pick", "step_preview"}
        for node in nodes.values():
            if node["type"] in {"GGImageCompressSave", "PreviewImage", "easy sam3ImageSegmentation"}:
                self.assertIn(node.get("properties", {}).get("gg_region_role"), output_roles)

    def test_latent_is_encoded_image_with_noise_mask(self):
        _, _, roles, links = self.load_graph()
        for region in ("background", "person"):
            crop = roles[region + "_crop"]
            vae = roles[region + "_vae_encode"]
            latent = roles[region + "_latent_mask"]
            sampler = roles[region + "_sample"]
            self.assertEqual(vae["type"], "VAEEncode")
            self.assertEqual(latent["type"], "SetLatentNoiseMask")
            self.assertEqual(self.source(vae, "pixels", links), (crop["id"], 1))
            self.assertEqual(self.source(latent, "samples", links), (vae["id"], 0))
            self.assertEqual(self.source(latent, "mask", links), (crop["id"], 2))
            self.assertEqual(self.source(sampler, "latent_image", links), (latent["id"], 0))
            self.assertEqual(sampler["type"], "KSampler")
            values = sampler["widgets_values_named"]
            self.assertEqual(values["cfg"], 1.0)
            self.assertEqual(values["sampler_name"], "euler")
            # 暗图提亮实测：0.6/0.85 几乎不动，0.95 才生效（turbo 9 步对降噪极敏感）
            self.assertEqual(values["denoise"], 0.95)

    def test_background_stage_uses_inverted_mask_via_prepare(self):
        # 背景阶段通过「处理区域=背景」在 prepare 内反相人像蒙版，得到背景遮罩
        _, _, roles, links = self.load_graph()
        prep = roles["background_prepare"]
        self.assertEqual(prep["type"], "GGRegionEditPrepare")
        self.assertEqual(prep["widgets_values_named"]["处理区域"], "背景")
        # 背景裁剪的遮罩来自背景 prepare 输出的区域遮罩（已反相）
        self.assertEqual(self.source(roles["background_crop"], "遮罩", links), (prep["id"], 1))

    def test_crop_dimensions_and_restoration_are_geometry_safe(self):
        _, _, roles, _ = self.load_graph()
        for region in ("background", "person"):
            values = roles[region + "_crop"]["widgets_values_named"]
            # 裁剪必须按原像素保持原图比例：曾经固定 768×768 会把竖图压扁，
            # 采样后拉伸回来把改动稀释掉，实测几乎等于直通。
            self.assertEqual(values["输出尺寸"], "原像素")
            self.assertFalse(values["遮罩填充"])
            self.assertEqual(values["输出尺寸.倍数取整"] % 8, 0)
            restored = roles[region + "_restore"]["widgets_values_named"]
            self.assertEqual(restored["遮罩扩展"], 0)
            self.assertEqual(restored["遮罩羽化"], 0)
            self.assertEqual(restored["颜色还原"], 0.0)

    def test_constraints_are_appended_after_optional_ai(self):
        _, _, roles, links = self.load_graph()
        for region in ("background", "person"):
            opt_switch = roles[region + "_prompt_select"]
            self.assertEqual(opt_switch["type"], "ComfySwitchNode")
            self.assertEqual(self.source(opt_switch, "switch", links), (roles["enable_ai"]["id"], 0))
            self.assertEqual(self.source(opt_switch, "on_false", links), (roles[region + "_prepare"]["id"], 2))
            self.assertEqual(self.source(opt_switch, "on_true", links), (roles[region + "_enhance"]["id"], 0))
            final = roles[region + "_prompt_final"]
            self.assertEqual(final["type"], "GGTextConcat")
            self.assertEqual(self.source(final, "文本1", links), (opt_switch["id"], 0))
            self.assertEqual(self.source(final, "文本2", links), (roles[region + "_prepare"]["id"], 3))
            encoded = roles[region + "_condition"]
            self.assertEqual(self.source(encoded, "正向提示词", links), (final["id"], 0))
            self.assertEqual(encoded["widgets_values_named"]["分辨率"], 0)
            self.assertEqual(self.source(encoded, "图像.图像1", links), (roles[region + "_crop"]["id"], 1))

    def test_save_is_png_and_no_credentials_are_embedded(self):
        _, nodes, roles, links = self.load_graph()
        self.assertEqual(roles["save"]["widgets_values_named"]["格式"], "PNG")
        # 串行后保存节点吃背景阶段结果（已含人像优化）
        self.assertEqual(self.source(roles["save"], "图像", links), (roles["background_select"]["id"], 0))
        for node in nodes.values():
            for key, value in node.get("widgets_values_named", {}).items():
                if "api_key" in key.lower() or key in ("API密钥", "密钥"):
                    self.assertFalse(value, "工作流不能嵌入用户密钥")

    def test_verified_qwen_models_are_selected(self):
        _, _, roles, _ = self.load_graph()
        expected = {
            "unet": ("unet_name", r"qwen\qwen_image_2.1_turbo_int8_convrot.safetensors"),
            "vae": ("vae_name", r"qwen\qwen_image_2.1_vae_bf16.safetensors"),
        }
        for role, (key, value) in expected.items():
            self.assertEqual(roles[role]["widgets_values_named"][key].replace("/", "\\"), value)
        for region in ("background", "person"):
            self.assertEqual(roles[region + "_condition"]["widgets_values_named"]["CLIP名称"].replace("/", "\\"), r"qwen\qwen3vl_8b_int8_convrot.safetensors")


if __name__ == "__main__":
    unittest.main()
