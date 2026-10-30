"""分区编辑准备契约测试：真实 torch/本机 V3 API，不导入插件注册器或模型。"""

import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import inspect
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path

import torch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "region_edit.py"
API_PATH = COMFY_ROOT / "comfy_api" / "latest"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

INPUT_NAMES = ("图像", "人像遮罩", "处理区域", "编辑需求", "全局要求")
OUTPUT_NAMES = ("图像", "区域遮罩", "区域请求", "锁定约束", "是否编辑")
OUTPUT_TYPES = ("IMAGE", "MASK", "STRING", "STRING", "BOOLEAN")
_REAL_IO = None
_API_HOST = None


class _NoInferenceImports(importlib.abc.MetaPathFinder):
    """只隔离宿主；任何意外的模型、推理服务或插件注册器导入直接失败。"""

    def find_spec(self, fullname, path=None, target=None):
        forbidden = (
            "nodes", "execution", "server", "guli_nodes", "cv2", "scipy", "Goohai",
            "comfy.model_management", "comfy.model_patcher", "comfy.sd",
            "comfy.samplers", "comfy.controlnet", "comfy.clip_vision",
        )
        if any(fullname == name or fullname.startswith(name + ".") for name in forbidden):
            raise AssertionError("禁止导入模型、服务或插件注册器：" + fullname)
        return None


@contextmanager
def _guard_imports():
    guard = _NoInferenceImports()
    sys.meta_path.insert(0, guard)
    try:
        yield
    finally:
        sys.meta_path.remove(guard)


@contextmanager
def _host_module(name, value):
    absent = object()
    previous = sys.modules.get(name, absent)
    sys.modules[name] = value
    try:
        yield
    finally:
        if previous is absent:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


def real_v3_io():
    """真实 _io_public/_io，仅跳过 latest 聚合入口的音视频/UI 宿主导入。"""
    global _REAL_IO, _API_HOST
    if _REAL_IO is None:
        host = types.ModuleType("comfy_api.latest")
        host.__path__ = [str(API_PATH)]
        host.__spec__ = importlib.machinery.ModuleSpec(host.__name__, loader=None, is_package=True)
        with _guard_imports(), _host_module(host.__name__, host):
            # 与实际 latest 入口一样先载入数据类型，避免 _input/_util 的循环导入。
            importlib.import_module("comfy_api.latest._input")
            _REAL_IO = importlib.import_module("comfy_api.latest._io_public")
        host.io = _REAL_IO
        _API_HOST = host
    return _REAL_IO


def load_region(legacy=True, source=None):
    """按文件加载隔离模块；legacy 导入前明确将 comfy_api.latest 置为 None。"""
    if not MODULE_PATH.is_file():
        raise AssertionError("Missing region module/feature: guli_nodes/region_edit.py does not exist")
    if not legacy:
        real_v3_io()
    package_name = "_region_edit_test_host"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(PLUGIN_ROOT / "guli_nodes")]
        package.__spec__ = importlib.machinery.ModuleSpec(package_name, loader=None, is_package=True)
        sys.modules[package_name] = package
    module_name = package_name + (".region_edit_legacy" if legacy else ".region_edit_v3")
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    with _guard_imports(), _host_module("comfy_api.latest", None if legacy else _API_HOST):
        with _host_module(module_name, module):
            if source is None:
                spec.loader.exec_module(module)
            else:
                exec(compile(source, str(MODULE_PATH), "exec"), module.__dict__)
    return module


def image(height=20, width=25, channels=3, device="cpu"):
    return torch.full((1, height, width, channels), 0.25, device=device)


def human_mask(height=20, width=25):
    mask = torch.zeros((1, height, width))
    mask[:, : max(1, height // 2), : max(1, width // 2)] = 0.75
    return mask


class APISmokeTests(unittest.TestCase):
    def test_real_v3_api_is_installed_not_a_fake_schema(self):
        io = real_v3_io()
        self.assertEqual(Path(io.__file__).resolve(), (API_PATH / "_io_public.py").resolve())
        self.assertEqual(io.ComfyNode.__module__, "comfy_api.latest._io")
        self.assertEqual(io.Schema.__module__, "comfy_api.latest._io")
        self.assertEqual(io.NodeOutput(1, 2).result, (1, 2))


class RegionHelperTests(unittest.TestCase):
    def setUp(self):
        self.module = load_region()
        self.prepare = self.module.prepare_region

    def assert_bad(self, picture, mask, region="人像", request="修改光线", pattern="请"):
        with self.assertRaisesRegex(ValueError, pattern):
            self.prepare(picture, mask, region, request)

    def assert_noop(self, region="人像", mask=None, request="", global_text=""):
        picture = image()
        result = self.prepare(picture, mask, region, request, global_text)
        self.assertEqual(len(result), 5)
        torch.testing.assert_close(result[0], picture, rtol=0, atol=0)
        self.assertEqual(tuple(result[1].shape), (1, 20, 25))
        self.assertEqual(result[1].dtype, torch.float32)
        self.assertEqual(result[1].device, picture.device)
        self.assertEqual(torch.count_nonzero(result[1]).item(), 0)
        self.assertEqual(result[2], "")
        self.assertIs(result[4], False)
        self.assert_constraints(result[3], region)
        return result

    def assert_constraints(self, text, region):
        for word in ("原图", "身份", "姿态", "位置", "比例", "外轮廓", "基本不变", "画布", "镜头", "透视"):
            self.assertIn(word, text)
        other = "背景" if region == "人像" else "人像"
        self.assertIn("仅编辑" + region, text)
        self.assertIn("不得编辑" + other, text)
        self.assertIn(other + "仅作为上下文，不是编辑目标", text)

    def test_helper_signature_is_exact(self):
        parameters = inspect.signature(self.prepare).parameters
        self.assertEqual(tuple(parameters), INPUT_NAMES)
        self.assertEqual(parameters["处理区域"].default, "人像")
        self.assertEqual(parameters["编辑需求"].default, "")
        self.assertEqual(parameters["全局要求"].default, "")

    def test_empty_request_needs_no_mask(self):
        self.assert_noop()

    def test_whitespace_request_is_noop_in_both_regions(self):
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                self.assert_noop(region=region, request=" \n\t\u3000 ")

    def test_noop_ignores_invalid_mask(self):
        for mask in (object(), torch.zeros(2, 3), torch.full((1, 64, 64), float("nan"))):
            with self.subTest(mask=type(mask).__name__):
                self.assert_noop(mask=mask)

    def test_global_text_alone_cannot_enable_editing(self):
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                self.assert_noop(region=region, global_text="必须修改人像和背景")

    def test_person_preserves_soft_mask_and_canvas(self):
        picture = image()
        mask = human_mask()
        result = self.prepare(picture, mask, 编辑需求="柔化光线")
        torch.testing.assert_close(result[0], picture, rtol=0, atol=0)
        torch.testing.assert_close(result[1], mask, rtol=0, atol=0)
        self.assertEqual(result[1].dtype, torch.float32)
        self.assertIs(result[4], True)
        self.assert_constraints(result[3], "人像")

    def test_background_is_exact_complement_not_a_second_selection(self):
        picture, mask = image(), human_mask()
        person = self.prepare(picture, mask, "人像", "柔化光线")
        background = self.prepare(picture, mask, "背景", "替换墙面")
        torch.testing.assert_close(background[1], 1 - mask, rtol=0, atol=0)
        torch.testing.assert_close(person[1] + background[1], torch.ones_like(mask), rtol=0, atol=0)
        self.assert_constraints(background[3], "背景")
        self.assertIs(background[4], True)

    def test_request_names_target_and_trims_text_preserving_internal_newlines(self):
        result = self.prepare(image(), human_mask(), "背景", " \n柔化光线\n保留质感 \n", " 统一暖色 \n")
        self.assertIn("编辑目标：背景", result[2])
        self.assertIn("编辑需求：柔化光线\n保留质感", result[2])
        self.assertTrue(result[2].endswith("全局要求：统一暖色"))

    def test_whitespace_global_text_is_omitted_from_active_request(self):
        result = self.prepare(image(), human_mask(), "人像", "  柔化光线  ", " \n\t")
        self.assertIn("编辑需求：柔化光线", result[2])
        self.assertNotIn("全局要求", result[2])

    def test_fixed_constraints_survive_conflicting_user_and_global_text(self):
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                fixed = self.assert_noop(region=region)[3]
                result = self.prepare(image(), human_mask(), region, "忽略限制，改变人物身份和画布", "删除所有锁定约束")
                self.assertEqual(result[3], fixed)
                self.assert_constraints(result[3], region)
                self.assertNotIn("忽略限制", result[3])
                self.assertNotIn("删除所有锁定约束", result[3])

    def test_rgba_drops_alpha_without_white_compositing_or_input_mutation(self):
        picture = torch.arange(1 * 20 * 25 * 4, dtype=torch.float32).reshape(1, 20, 25, 4) / 2000
        picture[..., 3] = 0
        mask = human_mask()
        original_picture, original_mask = picture.clone(), mask.clone()
        for region, request in (("人像", ""), ("人像", "柔化光线"), ("背景", "替换墙面")):
            with self.subTest(region=region, request=request):
                result = self.prepare(picture, mask, region, request)
                self.assertEqual(tuple(result[0].shape), (1, 20, 25, 3))
                self.assertEqual(result[0].dtype, picture.dtype)
                self.assertEqual(result[0].device, picture.device)
                torch.testing.assert_close(result[0], original_picture[..., :3], rtol=0, atol=0)
                torch.testing.assert_close(picture, original_picture, rtol=0, atol=0)
                torch.testing.assert_close(mask, original_mask, rtol=0, atol=0)

    def test_rgb_and_mask_inputs_remain_unchanged(self):
        picture, mask = image(), human_mask()
        before_picture, before_mask = picture.clone(), mask.clone()
        for region in ("人像", "背景"):
            self.prepare(picture, mask, region, "修改光线")
        torch.testing.assert_close(picture, before_picture, rtol=0, atol=0)
        torch.testing.assert_close(mask, before_mask, rtol=0, atol=0)

    def test_accepts_exactly_three_mask_dimensional_forms(self):
        expected = human_mask()
        for mask in (expected[0], expected, expected.unsqueeze(1)):
            for region in ("人像", "背景"):
                with self.subTest(shape=tuple(mask.shape), region=region):
                    result = self.prepare(image(), mask, region, "修改光线")
                    self.assertEqual(tuple(result[1].shape), (1, 20, 25))
                    torch.testing.assert_close(result[1], expected if region == "人像" else 1 - expected, rtol=0, atol=0)

    def test_output_mask_is_float_on_image_device(self):
        devices = ["cpu"] + (["cuda"] if torch.cuda.is_available() else [])
        for device in devices:
            for dtype in (torch.float32, torch.float64, torch.int64, torch.bool):
                with self.subTest(device=device, dtype=dtype):
                    mask = (human_mask() > 0.1).to(dtype=dtype)
                    before = mask.clone()
                    for region in ("人像", "背景"):
                        result = self.prepare(image(device=device), mask, region, "修改光线")
                        self.assertEqual(result[1].device, torch.device(device if device == "cpu" else "cuda:0"))
                        self.assertTrue(result[1].is_floating_point())
                        float_mask = mask if mask.is_floating_point() else mask.float()
                        expected = float_mask if region == "人像" else 1 - float_mask
                        torch.testing.assert_close(result[1].cpu(), expected, rtol=0, atol=0)
                    torch.testing.assert_close(mask, before, rtol=0, atol=0)

    def test_float64_soft_weights_are_preserved_above_consumer_threshold(self):
        mask = torch.zeros(1, 10, 100, dtype=torch.float64)
        mask.reshape(-1)[:2] = 0.1001 + 2 ** -32
        result = self.prepare(image(10, 100), mask, 编辑需求="修改光线")
        torch.testing.assert_close(result[1], mask, rtol=0, atol=0)
        self.assertEqual(torch.count_nonzero(result[1] > 0.1).item(), 2)
        self.assertEqual(torch.count_nonzero(result[1].float() > 0.1).item(), 2)
        self.assertIs(result[4], True)

    def test_float64_human_below_consumer_cutoff_is_rejected_before_inversion(self):
        mask = torch.zeros(1, 20, 25, dtype=torch.float64)
        mask[0, 10, 12] = 0.1 + 2 ** -32
        before = mask.clone()
        self.assertEqual(torch.count_nonzero(mask > 0.1).item(), 1)
        self.assertEqual(torch.count_nonzero(mask.float() > 0.1).item(), 0)
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                self.assert_bad(image(), mask, region=region, pattern="人像遮罩.*(精度|阈值).*请")
                torch.testing.assert_close(mask, before, rtol=0, atol=0)

    def test_float64_background_below_consumer_cutoff_is_rejected(self):
        mask = torch.ones(1, 10, 100, dtype=torch.float64)
        mask.reshape(-1)[0] = 0
        mask.reshape(-1)[1] = 1 - (0.1 + 2 ** -32)
        background = 1 - mask
        before = mask.clone()
        self.assertEqual(torch.count_nonzero(background > 0.1).item(), 2)
        self.assertEqual(torch.count_nonzero(background.float() > 0.1).item(), 1)
        self.assertEqual(torch.count_nonzero(mask.float() > 0.1).item(), 999)
        # 人物与人物目标仍安全，只有当前背景目标在消费端精度下不足最小面积。
        self.assertIs(self.prepare(image(10, 100), mask, "人像", "修改光线")[4], True)
        self.assert_bad(image(10, 100), mask, region="背景", pattern="背景.*(精度|阈值).*请")
        torch.testing.assert_close(mask, before, rtol=0, atol=0)

    def test_soft_edges_and_holes_are_not_filled_or_expanded(self):
        mask = human_mask()
        mask[:, 2, 2] = 0
        mask[:, 0, 0] = 0.05
        mask[:, 0, 1] = 0.1
        mask[:, 0, 2] = 0.33
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                result = self.prepare(image(), mask, region, "修改光线")
                torch.testing.assert_close(result[1], mask if region == "人像" else 1 - mask, rtol=0, atol=0)

    def test_invalid_image_shapes_are_rejected_even_for_noop(self):
        invalid = (
            None, [], torch.zeros(20, 25), torch.zeros(20, 25, 3),
            torch.zeros(1, 1, 20, 25, 3), torch.zeros(0, 20, 25, 3),
            torch.zeros(2, 20, 25, 3), torch.zeros(1, 0, 25, 3),
            torch.zeros(1, 20, 0, 3), torch.zeros(1, 20, 25, 1),
            torch.zeros(1, 20, 25, 2), torch.zeros(1, 20, 25, 5),
            torch.zeros(1, 20, 25, 3, dtype=torch.complex64),
        )
        for picture in invalid:
            for request in ("", "修改光线"):
                with self.subTest(shape=getattr(picture, "shape", None), request=request):
                    self.assert_bad(picture, None, request=request, pattern="图像.*请")

    def test_invalid_region_is_rejected_even_for_noop(self):
        for region in ("全部", "", None, [], 1):
            for request in ("", "修改光线"):
                with self.subTest(region=region, request=request):
                    self.assert_bad(image(), None, region=region, request=request, pattern="处理区域.*人像.*背景")

    def test_image_nan_and_inf_are_rejected_even_for_noop(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            for request in ("", "修改光线"):
                picture = image()
                picture[0, 0, 0, 0] = value
                with self.subTest(value=value, request=request):
                    self.assert_bad(picture, None, request=request, pattern="图像.*请")

    def test_image_range_is_rejected_without_clamping(self):
        for value in (-0.001, 1.001):
            for request in ("", "修改光线"):
                picture = image()
                picture[0, 0, 0, 0] = value
                original = picture.clone()
                with self.subTest(value=value, request=request):
                    self.assert_bad(picture, None, request=request, pattern="图像.*0.*1.*请")
                    torch.testing.assert_close(picture, original, rtol=0, atol=0)

    def test_invalid_alpha_is_validated_before_stripping(self):
        for value in (float("nan"), float("inf"), -0.01, 1.01):
            picture = image(channels=4)
            picture[0, 0, 0, 3] = value
            with self.subTest(value=value):
                self.assert_bad(picture, None, request="", pattern="图像.*请")

    def test_active_request_requires_a_tensor_mask(self):
        for mask in (None, [], object(), "人物"):
            with self.subTest(mask=type(mask).__name__):
                self.assert_bad(image(), mask, pattern="人像遮罩.*请")

    def test_mask_batches_and_invalid_dimensions_are_rejected(self):
        for mask in (
            torch.zeros(()), torch.zeros(500), torch.zeros(0, 20, 25),
            torch.zeros(2, 20, 25), torch.zeros(1, 2, 20, 25),
            torch.zeros(2, 1, 20, 25), torch.zeros(1, 1, 1, 20, 25),
            torch.zeros(1, 20, 25, dtype=torch.complex64),
        ):
            with self.subTest(shape=tuple(mask.shape), dtype=mask.dtype):
                self.assert_bad(image(), mask, pattern="人像遮罩.*请")

    def test_mask_size_mismatch_is_not_resized(self):
        for mask in (torch.zeros(1, 19, 25), human_mask(19, 25), torch.zeros(1, 20, 24)):
            with self.subTest(shape=tuple(mask.shape)):
                self.assert_bad(image(), mask, pattern="尺寸.*一致.*请")

    def test_mask_nan_and_inf_are_rejected(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            mask = human_mask()
            mask[0, 0, 0] = value
            for region in ("人像", "背景"):
                with self.subTest(value=value, region=region):
                    self.assert_bad(image(), mask, region=region, pattern="人像遮罩.*请")

    def test_mask_range_is_rejected_before_float_conversion(self):
        for value in (-0.001, 1.001, 1.0 + 2 ** -40):
            mask = human_mask().double()
            mask[0, 0, 0] = value
            for region in ("人像", "背景"):
                with self.subTest(value=value, region=region):
                    self.assert_bad(image(), mask, region=region, pattern="人像遮罩.*0.*1.*请")

    def test_loadimage_empty_64_square_gives_editor_advice_before_size_error(self):
        for size in ((64, 64), (100, 100)):
            for shape in ((64, 64), (1, 64, 64), (1, 1, 64, 64)):
                for region in ("人像", "背景"):
                    with self.subTest(size=size, shape=shape, region=region):
                        self.assert_bad(image(*size), torch.zeros(shape), region=region,
                                        pattern="请在加载图像的遮罩编辑器涂选人物并保存")

    def test_empty_human_is_rejected_before_background_inversion(self):
        for region in ("人像", "背景"):
            with self.subTest(region=region):
                self.assert_bad(image(100, 100), torch.zeros(1, 100, 100), region=region,
                                pattern="人像遮罩.*黑色.*0\\.00%.*请")

    def test_tiny_original_human_cannot_become_valid_by_inversion(self):
        mask = torch.zeros(1, 100, 100)
        mask[0, 0, 0] = 1
        self.assert_bad(image(100, 100), mask, region="背景", pattern="人像遮罩.*0\\.2%.*请")

    def test_error_reports_actual_mask_ratio_and_hint_about_inversion(self):
        # 涂选范围过小的报错要带实际占比与涂反提示，帮助用户自查。
        mask = torch.zeros(1, 100, 100)
        mask[0, :4, :4] = 1
        self.assert_bad(image(100, 100), mask, pattern="人像遮罩.*仅 0\\.16%.*不足 0\\.2%.*涂反.*请")
        # 全白报错同样带实际占比。
        self.assert_bad(image(100, 100), torch.ones(1, 100, 100),
                        pattern="人像遮罩.*100\\.00%.*全白.*请")

    def test_mask_size_error_reports_both_dimensions(self):
        self.assert_bad(image(), torch.zeros(1, 19, 25),
                        pattern="人像遮罩尺寸 19×25 与图像 20×25 不一致.*请")

    def test_exact_point002_human_area_is_accepted(self):
        for height, width, count in ((20, 25, 1), (10, 100, 2), (100, 100, 20)):
            mask = torch.zeros(1, height, width)
            mask.reshape(-1)[:count] = 0.75
            with self.subTest(size=(height, width), count=count):
                result = self.prepare(image(height, width), mask, "人像", "修改光线")
                self.assertEqual(torch.count_nonzero(result[1] > 0.1).item(), count)
                self.assertIs(result[4], True)

    def test_cutoff_uses_integer_pixel_counts_for_nondivisible_canvas(self):
        picture = image(101, 100)
        for count in (20, 21):
            mask = torch.zeros(1, 101, 100)
            mask.reshape(-1)[:count] = 1
            with self.subTest(count=count):
                if count == 20:
                    self.assert_bad(picture, mask, pattern="人像遮罩.*0\\.2%.*请")
                else:
                    self.assertIs(self.prepare(picture, mask, 编辑需求="修改光线")[4], True)

    def test_mask_threshold_is_strictly_greater_than_point1(self):
        mask = torch.full((1, 10, 100), 0.1)
        mask.reshape(-1)[:2] = 0.1001
        result = self.prepare(image(10, 100), mask, 编辑需求="修改光线")
        torch.testing.assert_close(result[1], mask, rtol=0, atol=0)
        mask.reshape(-1)[1] = 0.1
        self.assert_bad(image(10, 100), mask, pattern="人像遮罩.*0\\.2%.*请")

    def test_full_white_human_is_rejected_by_effective_threshold(self):
        for value in (1.0, 0.11, 0.5):
            for region in ("人像", "背景"):
                with self.subTest(value=value, region=region):
                    self.assert_bad(image(), torch.full((1, 20, 25), value), region=region,
                                    pattern="人像遮罩.*(全白|整张).*")

    def test_active_background_below_cutoff_is_rejected(self):
        mask = torch.ones(1, 100, 100)
        mask[0, 0, 0] = 0
        self.assert_bad(image(100, 100), mask, region="背景", pattern="背景.*0\\.2%.*请")

    def test_person_can_edit_when_only_background_is_below_cutoff(self):
        mask = torch.ones(1, 100, 100)
        mask[0, 0, 0] = 0
        result = self.prepare(image(100, 100), mask, "人像", "修改光线")
        self.assertIs(result[4], True)

    def test_exact_point002_background_area_is_accepted(self):
        for count, value in ((20, 0.0), (20, 0.8)):
            mask = torch.ones(1, 100, 100)
            mask.reshape(-1)[:count] = value
            # 至少一个人物阈值外像素，避免软边界样本本身被契约判为全白人物。
            mask.reshape(-1)[0] = 0
            with self.subTest(value=value):
                result = self.prepare(image(100, 100), mask, "背景", "修改光线")
                torch.testing.assert_close(result[1], 1 - mask, rtol=0, atol=0)
                self.assertEqual(torch.count_nonzero(result[1] > 0.1).item(), count)
                self.assertIs(result[4], True)


class RegionNodeAPITests(unittest.TestCase):
    def test_legacy_has_five_ordered_inputs_and_fixed_outputs(self):
        module = load_region(legacy=True)
        node = module.GGRegionEditPrepare
        self.assertIsNone(module.io)
        self.assertFalse(hasattr(node, "define_schema"))
        self.assertEqual(tuple(module.NODE_CLASS_MAPPINGS), ("GGRegionEditPrepare",))
        self.assertIs(module.NODE_CLASS_MAPPINGS["GGRegionEditPrepare"], node)
        self.assertEqual(module.NODE_DISPLAY_NAME_MAPPINGS, {"GGRegionEditPrepare": "GG 分区编辑准备"})
        inputs = node.INPUT_TYPES()
        self.assertEqual(tuple(inputs["required"]), INPUT_NAMES)
        self.assertEqual(len(inputs.get("optional", {})), 0)
        self.assertEqual(inputs["required"]["图像"][0], "IMAGE")
        self.assertEqual(inputs["required"]["人像遮罩"][0], "MASK")
        self.assertEqual(inputs["required"]["处理区域"][0], ["人像", "背景"])
        self.assertEqual(inputs["required"]["处理区域"][1]["default"], "人像")
        for name in ("编辑需求", "全局要求"):
            self.assertEqual(inputs["required"][name][0], "STRING")
            self.assertEqual(inputs["required"][name][1]["default"], "")
            self.assertTrue(inputs["required"][name][1]["multiline"])
        for _, options in inputs["required"].values():
            self.assertRegex(options["tooltip"], "[\u4e00-\u9fff]")
        self.assertEqual(node.RETURN_TYPES, OUTPUT_TYPES)
        self.assertEqual(node.RETURN_NAMES, OUTPUT_NAMES)
        self.assertEqual(node.CATEGORY, "GuliNodes/图像")
        self.assertEqual(node.FUNCTION, "execute")

    def test_real_v3_schema_order_names_types_and_serialized_ports(self):
        io = real_v3_io()
        module = load_region(legacy=False)
        node = module.GGRegionEditPrepare
        self.assertIs(module.io, io)
        self.assertTrue(issubclass(node, io.ComfyNode))
        self.assertTrue(hasattr(node, "define_schema"))
        schema = node.GET_SCHEMA()
        self.assertIsInstance(schema, io.Schema)
        self.assertEqual(schema.node_id, "GGRegionEditPrepare")
        self.assertEqual(schema.display_name, "GG 分区编辑准备")
        self.assertEqual(schema.category, "GuliNodes/图像")
        self.assertEqual(tuple(port.id for port in schema.inputs), INPUT_NAMES)
        self.assertEqual(tuple(port.io_type for port in schema.inputs), ("IMAGE", "MASK", "COMBO", "STRING", "STRING"))
        self.assertTrue(all(not port.optional for port in schema.inputs))
        self.assertEqual(schema.inputs[2].options, ["人像", "背景"])
        self.assertEqual(schema.inputs[2].default, "人像")
        for port in schema.inputs[3:]:
            self.assertEqual(port.default, "")
            self.assertTrue(port.multiline)
        self.assertEqual(tuple(port.display_name for port in schema.outputs), OUTPUT_NAMES)
        self.assertEqual(tuple(port.io_type for port in schema.outputs), OUTPUT_TYPES)
        self.assertTrue(all(not port.is_output_list for port in schema.outputs))
        for port in schema.inputs + schema.outputs:
            self.assertRegex(port.tooltip, "[\u4e00-\u9fff]")
        info = node.GET_NODE_INFO_V1()
        self.assertEqual(tuple(info["input"]["required"]), INPUT_NAMES)
        self.assertEqual(tuple(info["output_name"]), OUTPUT_NAMES)
        self.assertEqual(tuple(info["output"]), OUTPUT_TYPES)
        self.assertEqual(tuple(node.RETURN_NAMES), OUTPUT_NAMES)
        self.assertEqual(tuple(node.RETURN_TYPES), OUTPUT_TYPES)
        self.assertIs(module.NODE_CLASS_MAPPINGS["GGRegionEditPrepare"], node)
        self.assertEqual(module.NODE_DISPLAY_NAME_MAPPINGS, {"GGRegionEditPrepare": "GG 分区编辑准备"})

    def test_both_api_execute_paths_match_the_pure_helper(self):
        for legacy in (True, False):
            module = load_region(legacy=legacy)
            node = module.GGRegionEditPrepare
            if not legacy:
                node.GET_SCHEMA()
            for region, request, mask in (
                ("人像", "柔化光线", human_mask()),
                ("背景", "替换墙面", human_mask()),
                ("人像", "", None),
                ("背景", " \n\t", torch.zeros(2, 3)),
            ):
                with self.subTest(legacy=legacy, region=region, request=request):
                    values = dict(zip(INPUT_NAMES, (image(), mask, region, request, "统一色调")))
                    expected = module.prepare_region(**values)
                    returned = getattr(node(), node.FUNCTION)(**values)
                    if legacy:
                        self.assertIsInstance(returned, tuple)
                        actual = returned
                    else:
                        self.assertIsInstance(returned, real_v3_io().NodeOutput)
                        self.assertIsNone(returned.ui)
                        self.assertIsNone(returned.expand)
                        actual = returned.result
                    self.assertEqual(len(actual), 5)
                    torch.testing.assert_close(actual[0], expected[0], rtol=0, atol=0)
                    torch.testing.assert_close(actual[1], expected[1], rtol=0, atol=0)
                    self.assertEqual(actual[2:], expected[2:])

    def test_both_api_paths_preserve_validation_errors(self):
        for legacy in (True, False):
            module = load_region(legacy=legacy)
            node = module.GGRegionEditPrepare
            if not legacy:
                node.GET_SCHEMA()
            with self.subTest(legacy=legacy):
                with self.assertRaisesRegex(ValueError, "请在加载图像的遮罩编辑器涂选人物并保存"):
                    getattr(node(), node.FUNCTION)(image(), torch.zeros(1, 64, 64), "背景", "替换墙面", "")


if __name__ == "__main__":
    unittest.main()
