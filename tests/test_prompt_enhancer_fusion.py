"""GG 提示词增强qwen2.1 融合改造：自动任务判定、双通道输出、透明背景、卸载策略、控件顺序。

所有模型调用都被替换成桩，不载权重、不联网。
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent.parent))
sys.path.insert(0, str(ROOT))
from guli_nodes import prompt_enhancer as pe

# 纯文本通道（API / 本地LLM）：正文 + 一行 RATIO 尾注。
LLM_TEXT = "一位年轻女性站在海边，85mm 浅景深，柔和逆光。\nRATIO: 2:3"
# JSON 通道（本地PE）：官方 PE 权重的原生协议。
PE_JSON = '{"rewritten_prompt": "一位年轻女性站在海边，85mm 浅景深，柔和逆光。", "wh_ratio": "2:3"}'
EDIT_JSON = '{"rewritten_prompt": "把背景换成透明", "wh_ratio": "", "ratio_follow": "<image1>"}'
FRAME = torch.zeros(1, 64, 64, 3)
IMAGES = {"图片1": FRAME}


def enhance(**overrides):
    """按节点的默认值拼一次调用，只覆盖关心的参数。"""
    kwargs = dict(
        prompt="",
        task_mode=pe.MODE_AUTO,
        language="中文",
        method=pe.METHOD_LLM,
        api_key="",
        api_base_url="",
        model="",
        pe_t2i_model="PE-T2I.safetensors",
        pe_i2i_model="PE-I2I.safetensors",
        llm_t2i_model="PE-T2I.gguf",
        llm_i2i_model="PE-I2I.gguf",
        mmproj_model="PE-I2I.mmproj.gguf",
        context_length=pe.DEFAULT_CONTEXT_LENGTH,
        max_output_tokens=pe.DEFAULT_MAX_OUTPUT_TOKENS,
        seed=0,
        unload=pe.UNLOAD_KEEP,
        transparent=False,
        direction=pe.DIRECTION_NONE,
        images=None,
    )
    kwargs.update(overrides)
    return kwargs


class 自动任务判定测试(unittest.TestCase):
    def test_无图无字直接返回空不报错(self):
        with patch.object(pe, "_request_local_llm") as call:
            self.assertEqual(pe._enhance(**enhance()), ("", "", False))
        call.assert_not_called()

    def test_有图无字走反推(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            text, payload, reverse = pe._enhance(**enhance(images=IMAGES))
        self.assertTrue(reverse)
        self.assertIn("反推", call.call_args.kwargs["user_prompt"])
        self.assertIn("年轻女性", text)
        self.assertEqual(json.loads(payload)["wh_ratio"], "2:3")

    def test_有图有字走图生图(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            _, _, reverse = pe._enhance(**enhance(prompt="背景换成透明", images=IMAGES))
        self.assertFalse(reverse)
        self.assertIn("用户需求", call.call_args.kwargs["user_prompt"])

    def test_反推时按输出语言补锚点(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(images=IMAGES, language="中文"))
        self.assertIn("用中文写", call.call_args.kwargs["user_prompt"])
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(images=IMAGES, language="英文"))
        self.assertIn("in English", call.call_args.kwargs["user_prompt"])
        # 自动 + 没有用户文本：落到节点默认中文，不能像以前那样飘成英文
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(images=IMAGES, language="自动"))
        self.assertIn("用中文写", call.call_args.kwargs["user_prompt"])

    def test_无图有字走文生图(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(prompt="海边女孩"))
        self.assertEqual(call.call_args.kwargs["image_base64_list"], [])

    def test_显式图生图缺图报错(self):
        with self.assertRaisesRegex(ValueError, "参考图"):
            pe._enhance(**enhance(prompt="换背景", task_mode=pe.MODE_I2I))

    def test_显式图生图缺需求报错并指路自动模式(self):
        with self.assertRaisesRegex(ValueError, "自动"):
            pe._enhance(**enhance(prompt="  ", task_mode=pe.MODE_I2I, images=IMAGES))


class 双通道输出测试(unittest.TestCase):
    def test_纯文本通道用RATIO尾注填比例(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT):
            text, payload, _ = pe._enhance(**enhance(prompt="海边女孩"))
        data = json.loads(payload)
        self.assertEqual(data["wh_ratio"], "2:3")
        self.assertEqual(data["ratio_follow"], "")
        self.assertNotIn("RATIO", text)

    def test_纯文本通道不要求JSON(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(prompt="海边女孩"))
        system = call.call_args.kwargs["system_prompt"]
        self.assertNotIn('"rewritten_prompt"', system)
        self.assertIn("用户需求", call.call_args.kwargs["user_prompt"])
        self.assertIn("RATIO", call.call_args.kwargs["user_prompt"])

    def test_没有尾注时比例为空白(self):
        with patch.object(pe, "_request_local_llm", return_value="一段普通的提示词"):
            text, payload, _ = pe._enhance(**enhance(prompt="海边女孩"))
        self.assertEqual(text, "一段普通的提示词")
        self.assertEqual(json.loads(payload)["wh_ratio"], "")

    def test_JSON通道取回三个字段(self):
        with patch.object(pe, "_request_official_pe", return_value=EDIT_JSON):
            _, payload, _ = pe._enhance(
                **enhance(prompt="背景换成透明", images=IMAGES, method=pe.METHOD_PE)
            )
        data = json.loads(payload)
        self.assertEqual(set(data), {"rewritten_prompt", "wh_ratio", "ratio_follow"})
        self.assertEqual(data["ratio_follow"], "<image1>")

    def test_JSON通道不要求RATIO尾注(self):
        with patch.object(pe, "_request_official_pe", return_value=PE_JSON) as call:
            pe._enhance(**enhance(prompt="海边女孩", method=pe.METHOD_PE))
        self.assertNotIn("RATIO", call.call_args.kwargs["user_prompt"])

    def test_JSON被截断时退回原文(self):
        with patch.object(pe, "_request_official_pe", return_value="一位女性，背景是白色的"):
            text, payload, _ = pe._enhance(**enhance(prompt="海边女孩", method=pe.METHOD_PE))
        self.assertEqual(text, "一位女性，背景是白色的")
        self.assertEqual(json.loads(payload)["wh_ratio"], "")

    def test_带思考块与围栏的回复照样解析(self):
        raw = "```text\n" + LLM_TEXT + "\n```"
        with patch.object(pe, "_request_local_llm", return_value="<think>想想</think>" + raw):
            text, payload, _ = pe._enhance(**enhance(prompt="海边女孩"))
        self.assertIn("年轻女性", text)
        self.assertEqual(json.loads(payload)["wh_ratio"], "2:3")

    def test_空回复报可读错误(self):
        with patch.object(pe, "_request_local_llm", return_value="   "):
            with self.assertRaisesRegex(ValueError, "为空"):
                pe._enhance(**enhance(prompt="海边女孩"))


class 透明背景测试(unittest.TestCase):
    def test_需求里的背景色被改写(self):
        self.assertEqual(pe._rewrite_transparency_request("背景是白色的"), "背景为透明")
        self.assertEqual(
            pe._rewrite_transparency_request("white background").lower(),
            "transparent background",
        )

    def test_改写指令的目标钉成透明(self):
        self.assertEqual(pe._rewrite_transparency_request("把蓝色背景换成纯色"), "把蓝色背景换成透明背景")

    def test_成稿残留的环境描述被清掉(self):
        text = pe._force_transparent_text("一位女性站在白墙前，身后是蓝天白云，穿黑色大衣")
        self.assertNotIn("墙", text)
        self.assertNotIn("蓝天", text)
        self.assertIn("黑色大衣", text)

    def test_前后缀只套一次(self):
        once = pe._apply_transparency("一位女性穿黑色大衣")
        twice = pe._apply_transparency(once)
        self.assertEqual(once, twice)
        self.assertTrue(once.startswith(pe.TRANSPARENT_PREFIX))
        self.assertTrue(once.endswith(pe.TRANSPARENT_SUFFIX.strip()))
        self.assertEqual(once.count("RGBA"), 1)

    def test_中文正文补全角句号(self):
        text = pe._apply_transparency("一位女性穿黑色大衣")
        self.assertIn("黑色大衣。", text)

    def test_开关打开时请求侧与出稿侧都生效(self):
        with patch.object(pe, "_request_local_llm", return_value="一位女性，背景是白色的") as call:
            text, payload, _ = pe._enhance(
                **enhance(prompt="一位女性，背景是白色的", transparent=True)
            )
        self.assertTrue(text.startswith(pe.TRANSPARENT_PREFIX))
        self.assertIn("透明背景", call.call_args.kwargs["user_prompt"])
        self.assertIn("透明", json.loads(payload)["rewritten_prompt"])

    def test_关闭时不加前后缀(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT):
            text, _, _ = pe._enhance(**enhance(prompt="海边女孩"))
        self.assertFalse(text.startswith(pe.TRANSPARENT_PREFIX))


class 卸载策略测试(unittest.TestCase):
    def test_旧工作流的布尔值可读(self):
        self.assertEqual(pe._coerce_unload(True), pe.UNLOAD_AFTER)
        self.assertEqual(pe._coerce_unload(False), pe.UNLOAD_KEEP)

    def test_非法值落到自动(self):
        for value in (None, "", "随便写的", 3.5):
            self.assertEqual(pe._coerce_unload(value), pe.UNLOAD_AUTO)

    def test_保持加载时不释放(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT), \
                patch.object(pe._LocalLLMStorage, "unload") as unload:
            pe._enhance(**enhance(prompt="海边女孩", unload=pe.UNLOAD_KEEP))
        unload.assert_not_called()

    def test_运行后自动卸载会释放(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT), \
                patch.object(pe._LocalLLMStorage, "unload") as unload:
            pe._enhance(**enhance(prompt="海边女孩", unload=pe.UNLOAD_AFTER))
        unload.assert_called()

    def test_运行前后都释放(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT), \
                patch.object(pe, "_release_models_before_run") as before, \
                patch.object(pe._LocalLLMStorage, "unload") as unload:
            pe._enhance(**enhance(prompt="海边女孩", unload=pe.UNLOAD_BEFORE_AFTER))
        before.assert_called_once()
        unload.assert_called()

    def test_失败也会释放(self):
        with patch.object(pe, "_request_local_llm", side_effect=RuntimeError("炸了")), \
                patch.object(pe._LocalLLMStorage, "unload") as unload:
            with self.assertRaises(RuntimeError):
                pe._enhance(**enhance(prompt="海边女孩", unload=pe.UNLOAD_AFTER))
        unload.assert_called()


class 模板拼接测试(unittest.TestCase):
    def test_纯文本通道不要JSON字段约定(self):
        text = pe._build_llm_system(pe.MODE_T2I, "中文")
        self.assertNotIn("## Output format", text)
        self.assertNotIn('"rewritten_prompt"', text)
        self.assertIn("不输出 JSON", text)

    def test_JSON通道保留字段约定(self):
        text = pe._build_official_pe_system(pe.MODE_T2I, "中文")
        self.assertIn("## Output format", text)
        self.assertIn("wh_ratio", text)

    def test_两种通道都剥掉强制英文(self):
        for text in (
            pe._build_llm_system(pe.MODE_T2I, "中文"),
            pe._build_official_pe_system(pe.MODE_T2I, "中文"),
            pe._build_llm_system(pe.MODE_I2I, "中文"),
        ):
            with self.subTest(head=text[:40]):
                self.assertNotIn("always in English", text)
                self.assertNotIn("## Language", text)

    def test_中文与英文与自动三种语言规则不同(self):
        zh = pe._build_api_instructions(pe.MODE_T2I, "中文")
        en = pe._build_api_instructions(pe.MODE_T2I, "英文")
        auto = pe._build_api_instructions(pe.MODE_T2I, "自动")
        self.assertIn("输出语言是“中文”", zh)
        self.assertIn("输出语言是“英文”", en)
        self.assertIn("输出语言设为“自动”", auto)

    def test_反推段落插在输出格式之前(self):
        text = pe._build_official_pe_system(pe.MODE_T2I, "中文", reverse=True)
        self.assertIn("Reverse mode", text)
        self.assertLess(text.index("Reverse mode"), text.index("## Output format"))

    def test_图生图模板去掉悬空的指令引导语(self):
        self.assertNotIn(
            "The user's edit instruction to rewrite is:",
            pe._build_llm_system(pe.MODE_I2I, "中文"),
        )

    def test_方向约束为空时不加料(self):
        self.assertEqual(pe._direction_tail(pe.DIRECTION_NONE), "")
        self.assertIn("写实人像", pe._direction_tail("写实人像"))

    def test_纯文本通道要求心里走完八步(self):
        text = pe._build_llm_system(pe.MODE_T2I, "中文")
        self.assertIn("in your head", text)
        self.assertNotIn(pe._STEP_PREAMBLE, text)
        # JSON 通道不动官方原句，官方权重是照着它训练的。
        self.assertIn(pe._STEP_PREAMBLE, pe._build_official_pe_system(pe.MODE_T2I, "中文"))


class 未标记思考剥离测试(unittest.TestCase):
    def test_以思考开头时只留最后一段答案(self):
        raw = (
            "Thinking Process:\n\n1. **Analyze the Request:** 女机械师。\n\n"
            "2. **Plan:** 分层。\n\n"
            "一位银发女机械师站在雨夜的赛博朋克街道上。"
        )
        self.assertEqual(pe._strip_untagged_reasoning(raw), "一位银发女机械师站在雨夜的赛博朋克街道上。")

    def test_正常输出不动(self):
        raw = "一位银发女机械师站在雨夜的赛博朋克街道上，霓虹倒影铺满积水。"
        self.assertEqual(pe._strip_untagged_reasoning(raw), raw)

    def test_单段思考不误删(self):
        raw = "思考过程：先定画面比例，再定焦段。"
        self.assertEqual(pe._strip_untagged_reasoning(raw), raw)

    def test_纯文本通道接住模型自己回的JSON(self):
        with patch.object(pe, "_request_local_llm", return_value=PE_JSON):
            text, payload, _ = pe._enhance(**enhance(prompt="海边女孩"))
        self.assertIn("年轻女性", text)
        self.assertEqual(json.loads(payload)["wh_ratio"], "2:3")


class 输出语言测试(unittest.TestCase):
    def test_自动跟随需求语言(self):
        self.assertEqual(pe._resolve_language("自动", "雨夜街头"), "中文")
        self.assertEqual(pe._resolve_language("自动", "a rainy street"), "英文")
        self.assertEqual(pe._resolve_language("自动", "雨夜 street"), "中文")

    def test_自动没有文本时落到中文(self):
        self.assertEqual(pe._resolve_language("自动", ""), "中文")
        self.assertEqual(pe._resolve_language("自动", "   "), "中文")

    def test_显式选择不被改写(self):
        self.assertEqual(pe._resolve_language("英文", "雨夜街头"), "英文")
        self.assertEqual(pe._resolve_language("中文", "a rainy street"), "中文")

    def test_本地PE在用户消息里再钉一次语言(self):
        """官方 PE 权重偏英文，system prompt 尾部那句规则隔着上万字符，实测不生效。"""
        with patch.object(pe, "_request_official_pe", return_value=PE_JSON) as call:
            pe._enhance(**enhance(prompt="海边女孩", method=pe.METHOD_PE))
        self.assertIn("请用中文写", call.call_args.kwargs["user_prompt"])
        self.assertIn("中文", call.call_args.kwargs["system_prompt"])
        with patch.object(pe, "_request_official_pe", return_value=PE_JSON) as call:
            pe._enhance(**enhance(prompt="a girl by the sea", method=pe.METHOD_PE, language="英文"))
        self.assertIn("in English", call.call_args.kwargs["user_prompt"])

    def test_纯文本通道不重复加语言提示(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(prompt="海边女孩"))
        self.assertNotIn("请用中文写", call.call_args.kwargs["user_prompt"])


class 参数布局测试(unittest.TestCase):
    # 控件值按下标存盘。老工作流 0..8 的位置一个都不能动（下标 8 原是「主模型」，
    # 现在由「文生图LLM模型」接手，值天然对齐）；新控件只能插在下标 9，
    # 后面的 mmproj / 输入提示词等整体后移一位，由前端 configure 迁移补值。
    旧前缀 = [
        "任务模式", "输出语言", "增强方式", "api_key", "api_base_url", "model",
        "文生图PE模型", "图生图PE模型", "文生图LLM模型",
    ]
    新顺序 = [
        *旧前缀,
        "图生图LLM模型", "mmproj", "上下文长度", "最大生成token", "seed",
        "卸载策略", "输入提示词", "透明背景", "增强方向",
    ]

    def test_新旧前端参数顺序一致(self):
        self.assertEqual(list(pe._legacy_required()), self.新顺序)
        self.assertEqual([item.id for item in pe._v3_inputs()][:18], self.新顺序)

    def test_新控件插在老主模型之后且旧值位置不变(self):
        names = list(pe._legacy_required())
        self.assertEqual(names[:9], self.旧前缀)
        self.assertEqual(names[9], "图生图LLM模型")
        self.assertEqual(names[10], "mmproj")  # 老下标 9，靠迁移补一位推过来
        self.assertEqual(names[15], "输入提示词")  # 老下标 14

    def test_新控件排在多行输入之后(self):
        names = list(pe._legacy_required())
        self.assertGreater(names.index("透明背景"), names.index("输入提示词"))
        self.assertGreater(names.index("增强方向"), names.index("输入提示词"))

    def test_任务模式与卸载策略选项齐全(self):
        task = pe._legacy_required()["任务模式"][0]
        unload = pe._legacy_required()["卸载策略"][0]
        self.assertIn("自动", task)
        self.assertIn("文生图", task)
        self.assertIn("图生图", task)
        self.assertEqual(unload, [pe.UNLOAD_AUTO, pe.UNLOAD_KEEP, pe.UNLOAD_AFTER, pe.UNLOAD_BEFORE_AFTER])

    def test_输出槽位三个(self):
        node = pe.NODE_CLASS_MAPPINGS[pe.NODE_ID]
        if hasattr(node, "define_schema"):
            schema = node.define_schema()
            self.assertEqual(len(schema.outputs), 3)
        else:
            self.assertEqual(node.RETURN_TYPES, ("STRING", "STRING", "BOOLEAN"))


class 默认值测试(unittest.TestCase):
    def test_按记号挑PE模型而不是字母序第一个(self):
        options = ["clip_l.safetensors", "qwen\\qwen3.5_9b_pe_t2i.int8.safetensors", "x_pe_t2i_old.safetensors"]
        self.assertEqual(pe._preferred_model(options, "pe_t2i"), options[1])
        self.assertEqual(pe._preferred_model(options, "mmproj", "pe_i2i"), options[0])

    def test_有PE权重时默认本地PE(self):
        self.assertEqual(pe._default_method(["a.safetensors"]), pe.METHOD_PE)
        self.assertEqual(pe._default_method([pe.MISSING_PE]), pe.METHOD_API)
        self.assertEqual(pe._default_method([]), pe.METHOD_API)

    def test_主模型默认值跳过mmproj(self):
        options = ["3.5mmproj-BF16.gguf", "Qwen3-8B-Q8_0.gguf", "x-vit-projector.gguf"]
        self.assertEqual(pe._main_gguf_default(options), "Qwen3-8B-Q8_0.gguf")

    def test_只有mmproj时退回第一个而不是空(self):
        options = ["3.5mmproj-BF16.gguf"]
        self.assertEqual(pe._main_gguf_default(options), "3.5mmproj-BF16.gguf")

    def test_主模型默认值跳过缺依赖占位符(self):
        self.assertEqual(pe._main_gguf_default([pe.MISSING_GGUF]), pe.MISSING_GGUF)
        self.assertEqual(pe._main_gguf_default([pe.MISSING_GGUF, "a.gguf"]), "a.gguf")


class 本地LLM双模型测试(unittest.TestCase):
    """本地LLM 与本地PE 一样：文生图 / 图生图各用一个模型，切换任务真的会换。"""

    def _call(self, **overrides):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._enhance(**enhance(**overrides))
        return call.call_args.kwargs

    def _run_kwargs(self, **overrides):
        kwargs = {
            pe.P_TASK: pe.MODE_T2I,
            pe.P_METHOD: pe.METHOD_LLM,
            pe.P_PROMPT: "海边女孩",
            pe.P_UNLOAD: pe.UNLOAD_KEEP,
            pe.P_MMPROJ: "OLD.mmproj.gguf",
        }
        kwargs.update(overrides)
        return kwargs

    def test_文生图用文生图模型且不挂mmproj(self):
        kwargs = self._call(prompt="海边女孩")
        self.assertEqual(kwargs["model_name"], "PE-T2I.gguf")
        self.assertEqual(kwargs["mmproj_name"], pe.NO_MMPROJ)
        self.assertEqual(kwargs["image_base64_list"], [])

    def test_图生图用图生图模型并带mmproj(self):
        kwargs = self._call(prompt="背景换成透明", images=IMAGES)
        self.assertEqual(kwargs["model_name"], "PE-I2I.gguf")
        self.assertEqual(kwargs["mmproj_name"], "PE-I2I.mmproj.gguf")

    def test_反推也要看图所以用图生图模型(self):
        kwargs = self._call(images=IMAGES)
        self.assertEqual(kwargs["model_name"], "PE-I2I.gguf")
        self.assertEqual(kwargs["mmproj_name"], "PE-I2I.mmproj.gguf")

    def test_显式文生图即使接图也不送图不挂mmproj(self):
        kwargs = self._call(prompt="海边女孩", task_mode=pe.MODE_T2I, images=IMAGES)
        self.assertEqual(kwargs["model_name"], "PE-T2I.gguf")
        self.assertEqual(kwargs["mmproj_name"], pe.NO_MMPROJ)
        self.assertEqual(kwargs["image_base64_list"], [])

    def test_选中的模型没填就退回另一个(self):
        kwargs = self._call(prompt="海边女孩", llm_t2i_model="", llm_i2i_model="PE-I2I.gguf")
        self.assertEqual(kwargs["model_name"], "PE-I2I.gguf")
        kwargs = self._call(prompt="背景换成透明", images=IMAGES,
                            llm_t2i_model="PE-T2I.gguf", llm_i2i_model="")
        self.assertEqual(kwargs["model_name"], "PE-T2I.gguf")

    def test_两个模型都是占位项时报可读错误(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT):
            with self.assertRaisesRegex(ValueError, "请选择本地LLM"):
                pe._enhance(**enhance(prompt="海边女孩",
                                      llm_t2i_model=pe.MISSING_GGUF,
                                      llm_i2i_model=pe.MISSING_GGUF))

    def test_旧提交只有主模型时两个任务行为不变(self):
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._run(self._run_kwargs(**{pe.P_LLM_LEGACY: "OLD.gguf"}))
        self.assertEqual(call.call_args.kwargs["model_name"], "OLD.gguf")
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._run(self._run_kwargs(**{
                pe.P_LLM_LEGACY: "OLD.gguf",
                pe.P_TASK: pe.MODE_AUTO,
                pe.P_PROMPT: "",
                "图片1": FRAME,
            }))
        self.assertEqual(call.call_args.kwargs["model_name"], "OLD.gguf")

    def test_新存档两个模型各走各的(self):
        common = {pe.P_LLM_T2I: "T2I.gguf", pe.P_LLM_I2I: "I2I.gguf"}
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._run(self._run_kwargs(**common))
        self.assertEqual(call.call_args.kwargs["model_name"], "T2I.gguf")
        with patch.object(pe, "_request_local_llm", return_value=LLM_TEXT) as call:
            pe._run(self._run_kwargs(**{
                **common, pe.P_TASK: pe.MODE_AUTO, pe.P_PROMPT: "", "图片1": FRAME,
            }))
        self.assertEqual(call.call_args.kwargs["model_name"], "I2I.gguf")

    def test_GGUF默认值按T2I与I2I分开且mmproj只配同一个模型(self):
        gguf = [
            "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf",
            "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf",
            "Other.gguf",
        ]
        mmproj = [
            pe.NO_MMPROJ,
            "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf",
            "Qwen3.5-9b-mmproj-BF16.gguf",
        ]
        t2i, i2i, proj = pe._gguf_task_defaults(gguf, mmproj)
        self.assertEqual(t2i, "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf")
        self.assertEqual(i2i, "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf")
        self.assertEqual(proj, "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf")
        # 没有 I2I/T2I 记号时不硬凑别人的 mmproj
        _, _, proj = pe._gguf_task_defaults(["Other.gguf"], mmproj)
        self.assertEqual(proj, pe.NO_MMPROJ)

    def test_控件顺序_两个LLM模型相邻且在mmproj之前(self):
        keys = list(pe._legacy_required().keys())
        self.assertEqual(keys.index(pe.P_LLM_T2I) + 1, keys.index(pe.P_LLM_I2I))
        self.assertEqual(keys.index(pe.P_LLM_I2I) + 1, keys.index(pe.P_MMPROJ))
        self.assertLess(keys.index(pe.P_MMPROJ), keys.index(pe.P_PROMPT))
        self.assertLess(keys.index(pe.P_PROMPT), keys.index(pe.P_TRANSPARENT))
        self.assertLess(keys.index(pe.P_TRANSPARENT), keys.index(pe.P_DIRECTION))
        self.assertEqual(len(keys), 18)


if __name__ == "__main__":
    unittest.main()
