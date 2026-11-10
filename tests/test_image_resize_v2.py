"""GG 图像缩放 V2 契约测试：真实 torch，只加载 image_tools 单模块。"""

import importlib
import importlib.machinery
import importlib.util
import sys
import types
import unittest
from pathlib import Path

import torch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
MODULE_PATH = PLUGIN_ROOT / "guli_nodes" / "image_tools.py"
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def load_image_tools(legacy=False):
    """按文件加载隔离模块；legacy 时把 comfy_api.latest 置 None 走扁平参数分支。"""
    if not MODULE_PATH.is_file():
        raise AssertionError("缺少 guli_nodes/image_tools.py")
    package_name = "_image_tools_test_host"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(PLUGIN_ROOT / "guli_nodes")]
        package.__spec__ = importlib.machinery.ModuleSpec(package_name, loader=None, is_package=True)
        sys.modules[package_name] = package
    module_name = package_name + (".image_tools_legacy" if legacy else ".image_tools_v3")
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    if legacy:
        previous = sys.modules.get("comfy_api.latest", None)
        sys.modules["comfy_api.latest"] = None
        try:
            spec.loader.exec_module(module)
        finally:
            if previous is None:
                sys.modules.pop("comfy_api.latest", None)
            else:
                sys.modules["comfy_api.latest"] = previous
    else:
        spec.loader.exec_module(module)
    return module


MOD = load_image_tools()


def image(batch=1, height=100, width=80, channels=3):
    """左上角亮、右下角暗的渐变图，方便判断方向与裁剪位置。"""
    y = torch.linspace(0.0, 1.0, height).view(1, height, 1, 1)
    x = torch.linspace(0.0, 1.0, width).view(1, 1, width, 1)
    base = (x + y) / 2.0
    return base.expand(batch, height, width, channels).contiguous()


def run(图像=None, 遮罩=None, 方法="按长边等比例", 插值="lanczos", 模式="拉伸",
        方向="居中", 条件="总是", 颜色="#364254", 整除数=0,
        宽=1024, 高=1024, 边=1024):
    return MOD._执行图像缩放V2(
        图像, 遮罩, 方法, 插值, 模式, 方向, 条件, 颜色, 整除数, 宽, 高, 边,
    )


class 尺寸计算测试(unittest.TestCase):
    def test_按长边等比例(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 边=200)
        self.assertEqual((宽, 高), (160, 200))
        self.assertEqual(tuple(图.shape), (1, 200, 160, 3))

    def test_按短边等比例(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="按短边等比例", 边=160)
        self.assertEqual((宽, 高), (160, 200))
        self.assertEqual(tuple(图.shape), (1, 200, 160, 3))

    def test_自定义宽高单边为0按另一边推算(self):
        _, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=0, 高=300)
        self.assertEqual((宽, 高), (240, 300))

    def test_自定义宽高两边为0保持原尺寸(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=0, 高=0)
        self.assertEqual((宽, 高), (80, 100))
        self.assertEqual(tuple(图.shape), (1, 100, 80, 3))

    def test_整除数就近对齐(self):
        _, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=1000, 高=777, 整除数=64)
        self.assertEqual((宽, 高), (1024, 768))

    def test_总像素等比例接近目标总像素(self):
        _, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 模式="总像素等比例", 宽=512, 高=512)
        self.assertLessEqual(abs(宽 * 高 - 512 * 512), 512)  # 允许 1 像素级误差
        self.assertAlmostEqual(宽 / 高, 0.8, delta=0.02)


class 模式测试(unittest.TestCase):
    def test_拉伸铺满(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=200, 高=200, 模式="拉伸")
        self.assertEqual(tuple(图.shape), (1, 200, 200, 3))

    def test_裁剪保留上边(self):
        源 = image(1, 100, 80)
        _, 宽, 高, _ = run(源, 方法="自定义宽高", 宽=80, 高=50, 模式="裁剪", 方向="上")
        self.assertEqual((宽, 高), (80, 50))

    def test_裁剪不拉伸内容比例(self):
        # 100x80 的横幅裁到 50x50：先等比放大到 100 宽、125 高，再裁中间 50 行
        图, _, _, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=50, 高=50, 模式="裁剪", 插值="bilinear")
        上沿 = 图[:, 0, :, :].mean().item()
        下沿 = 图[:, -1, :, :].mean().item()
        self.assertLess(上沿, 下沿)  # 渐变仍是自上而下，说明没有被压扁

    def test_填充自定义颜色(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=200, 高=100,
                           模式="填充·自定义颜色", 颜色="#364254", 方向="居中")
        self.assertEqual((宽, 高), (200, 100))
        左条 = 图[:, :, 0, :]
        期望 = torch.tensor([0x36, 0x42, 0x54], dtype=左条.dtype) / 255.0
        self.assertTrue(torch.allclose(左条[0, 0], 期望, atol=1e-3))

    def test_填充边缘像素(self):
        源 = image(1, 100, 80)
        图, _, _, _ = run(源, 方法="自定义宽高", 宽=200, 高=100, 模式="填充·边缘像素")
        # 左留白应复制原图第 0 列
        self.assertTrue(torch.allclose(图[:, :, 0, :], 图[:, :, 59, :], atol=1e-5))

    def test_填充边框颜色不崩溃且尺寸正确(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=200, 高=100,
                           模式="填充·边框颜色")
        self.assertEqual(tuple(图.shape), (1, 100, 200, 3))

    def test_缩小也走填充(self):
        图, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=40, 高=100,
                           模式="填充·自定义颜色")
        self.assertEqual((宽, 高), (40, 100))
        self.assertEqual(tuple(图.shape), (1, 100, 40, 3))


class 条件与遮罩测试(unittest.TestCase):
    def test_执行条件只缩不放(self):
        _, 宽, 高, _ = run(image(1, 100, 80), 边=1024, 条件="最长边大于目标时")
        self.assertLessEqual(max(宽, 高), 1024)
        self.assertEqual((宽, 高), (80, 100))

    def test_执行条件只放不缩(self):
        _, 宽, 高, _ = run(image(1, 100, 80), 方法="自定义宽高", 宽=20, 高=20,
                           条件="最短边小于目标时")
        self.assertEqual((宽, 高), (80, 100))

    def test_遮罩同步缩放(self):
        罩 = torch.ones((1, 100, 80))
        图, 宽, 高, 输出罩 = run(image(1, 100, 80), 遮罩=罩, 边=200)
        self.assertEqual((宽, 高), (160, 200))
        self.assertEqual(tuple(输出罩.shape), (1, 200, 160))
        self.assertAlmostEqual(float(输出罩.mean()), 1.0, places=2)

    def test_单张遮罩自动复用(self):
        罩 = torch.ones((1, 100, 80))
        _, _, _, 输出罩 = run(image(3, 100, 80), 遮罩=罩, 边=200)
        self.assertEqual(tuple(输出罩.shape), (3, 200, 160))

    def test_未接遮罩输出全零(self):
        _, _, _, 输出罩 = run(image(2, 100, 80), 边=200)
        self.assertEqual(tuple(输出罩.shape), (2, 200, 160))
        self.assertEqual(float(输出罩.abs().sum()), 0.0)

    def test_填充区遮罩为0(self):
        罩 = torch.ones((1, 100, 80))
        _, _, _, 输出罩 = run(image(1, 100, 80), 遮罩=罩, 方法="自定义宽高",
                              宽=200, 高=100, 模式="填充·边缘像素")
        self.assertGreaterEqual(float(输出罩[0, :, 0].max()), 0.0)
        self.assertGreater(float(输出罩.shape[2]), float(罩.shape[2]))


class 错误处理测试(unittest.TestCase):
    def test_总像素模式必须自定义宽高(self):
        with self.assertRaises(ValueError) as 上下文:
            run(image(1, 100, 80), 模式="总像素等比例")
        self.assertIn("自定义宽高", str(上下文.exception))

    def test_总像素模式宽高不能为0(self):
        with self.assertRaises(ValueError):
            run(image(1, 100, 80), 方法="自定义宽高", 模式="总像素等比例", 宽=0, 高=0)

    def test_颜色解析(self):
        self.assertEqual(MOD._解析填充颜色("#fff"), (1.0, 1.0, 1.0))
        self.assertEqual(MOD._解析填充颜色("255,0,0"), (1.0, 0.0, 0.0))
        with self.assertRaises(ValueError):
            MOD._解析填充颜色("不是颜色")

    def test_批次不一致报错(self):
        with self.assertRaises(ValueError):
            run(image(3, 100, 80), 遮罩=torch.ones((2, 100, 80)))

    def test_空图像报错(self):
        with self.assertRaises(ValueError):
            run(None)


class 注册测试(unittest.TestCase):
    def test_节点已注册(self):
        self.assertIn("GG图像缩放V2", MOD.NODE_CLASS_MAPPINGS)
        self.assertEqual(MOD.NODE_DISPLAY_NAME_MAPPINGS["GG图像缩放V2"], "GG 图像缩放 V2")

    def test_v3_schema可用(self):
        schema = MOD.GG图像缩放V2.define_schema()
        self.assertEqual(schema.node_id, "GG图像缩放V2")
        self.assertEqual([输出.display_name for 输出 in schema.outputs], ["图像", "宽度", "高度", "遮罩"])

    def test_v3_执行解包嵌套取值(self):
        """ComfyUI 传进来的是 {选项键: 选中值, 嵌套输入...}，V3 要能正确拆开。"""
        结果 = MOD.GG图像缩放V2.execute(
            image(1, 100, 80),
            缩放方法={"缩放方法": "自定义宽高", "宽度": 200, "高度": 100},
            缩放模式={"缩放模式": "填充·自定义颜色", "固定方向": "居中", "填充颜色": "#ff0000"},
        )
        图, 宽, 高, 罩 = 结果.args if hasattr(结果, "args") else tuple(结果)
        self.assertEqual((宽, 高), (200, 100))
        self.assertEqual(tuple(图.shape), (1, 100, 200, 3))
        左条 = 图[:, :, 0, :]
        self.assertTrue(torch.allclose(左条[0, 0], torch.tensor([1.0, 0.0, 0.0]), atol=1e-3))
        self.assertEqual(tuple(罩.shape), (1, 100, 200))

    def test_v3_执行兼容扁平字符串(self):
        结果 = MOD.GG图像缩放V2.execute(
            image(1, 100, 80),
            缩放方法="按长边等比例",
            缩放模式="拉伸",
        )
        图, 宽, 高, _ = 结果.args if hasattr(结果, "args") else tuple(结果)
        self.assertEqual((宽, 高), (819, 1024))  # 长边是高 100 → 比例 10.24
        self.assertEqual(tuple(图.shape), (1, 1024, 819, 3))


class 图像缩放测试(unittest.TestCase):
    """GG 图像缩放：按倍数 + 按参数（长边/短边/宽度/高度/宽高）。"""

    def run_scale(self, 图=None, 方式="按倍数", 插值="lanczos", 倍率=1.5,
                  长边=1024, 短边=768, 宽=1024, 高=1024, 整除数=0):
        """几何测试默认关掉整除吸附（整除数=0），单独用 test_整除数* 覆盖吸附行为。"""
        return MOD._执行图像缩放(
            图 if 图 is not None else image(1, 100, 80),
            方式, 插值, 倍率, 长边, 短边, 宽, 高, 整除数,
        )

    def test_按倍数(self):
        图 = self.run_scale(倍率=1.5)
        self.assertEqual(tuple(图.shape), (1, 150, 120, 3))

    def test_按长边(self):
        图 = self.run_scale(方式={"缩放方式": "按长边", "长边": 200})
        self.assertEqual(tuple(图.shape), (1, 200, 160, 3))

    def test_按短边(self):
        图 = self.run_scale(方式={"缩放方式": "按短边", "短边": 160})
        self.assertEqual(tuple(图.shape), (1, 200, 160, 3))

    def test_按宽度(self):
        图 = self.run_scale(方式={"缩放方式": "按宽度", "宽度": 400})
        self.assertEqual(tuple(图.shape), (1, 500, 400, 3))

    def test_按高度(self):
        图 = self.run_scale(方式={"缩放方式": "按高度", "高度": 50})
        self.assertEqual(tuple(图.shape), (1, 50, 40, 3))

    def test_按宽度高度不保持比例(self):
        图 = self.run_scale(方式={"缩放方式": "按宽度高度", "宽度": 64, "高度": 32})
        self.assertEqual(tuple(图.shape), (1, 32, 64, 3))

    def test_缩小也能用(self):
        图 = self.run_scale(方式={"缩放方式": "按长边", "长边": 40})
        self.assertEqual(tuple(图.shape), (1, 40, 32, 3))

    def test_数值非法报错(self):
        for 值 in (0, -10):
            with self.assertRaises(ValueError) as 上下文:
                self.run_scale(方式={"缩放方式": "按宽度", "宽度": 值})
            self.assertIn("大于 0", str(上下文.exception))

    def test_未知方式报错(self):
        with self.assertRaises(ValueError):
            self.run_scale(方式="按对角线")

    def test_旧工作流插值名落进方式位(self):
        # 老工作流的 widgets_values 是 ["lanczos", 1.5]，位置对不上时要能还原
        图 = self.run_scale(方式="lanczos", 插值=1.5)
        self.assertEqual(tuple(图.shape), (1, 150, 120, 3))

    def test_整除数吸附宽度高度(self):
        # 1000 不是 16 的倍数：就近吸附到 1008，不报错也不截断
        图 = self.run_scale(方式={"缩放方式": "按宽度高度", "宽度": 1000, "高度": 1000}, 整除数=16)
        self.assertEqual(tuple(图.shape), (1, 1008, 1008, 3))

    def test_整除数吸附等比结果(self):
        # 400 宽 → 高 500，500 吸附到 16 的倍数得 496
        图 = self.run_scale(方式={"缩放方式": "按宽度", "宽度": 400}, 整除数=16)
        self.assertEqual(tuple(图.shape), (1, 496, 400, 3))

    def test_整除数0表示不对齐(self):
        图 = self.run_scale(方式={"缩放方式": "按宽度", "宽度": 400}, 整除数=0)
        self.assertEqual(tuple(图.shape), (1, 500, 400, 3))

    def test_整除数自定义档(self):
        图 = self.run_scale(
            方式={"缩放方式": "按宽度高度", "宽度": 123, "高度": 47},
            整除数={"整除数": "自定义", "自定义整除数": 10},
        )
        self.assertEqual(tuple(图.shape), (1, 50, 120, 3))

    def test_整除数快速选择档(self):
        # 1000 配 32 → 就近落到 992；配 8 → 正好整除，保持 1000
        for 档, 期望 in (("32", (1, 992, 992, 3)), ("8", (1, 1000, 1000, 3))):
            图 = self.run_scale(
                方式={"缩放方式": "按宽度高度", "宽度": 1000, "高度": 1000}, 整除数=档)
            self.assertEqual(tuple(图.shape), 期望)

    def test_整除数越界报错(self):
        with self.assertRaises(ValueError) as 上下文:
            self.run_scale(整除数=300)
        self.assertIn("0~256", str(上下文.exception))

    def test_v3_默认整除数是16(self):
        图 = MOD.GG图像缩放.execute(
            image(1, 100, 80), 缩放方式={"缩放方式": "按宽度", "宽度": 400}
        ).args[0]
        self.assertEqual(tuple(图.shape), (1, 496, 400, 3))

    def test_v3_schema结构(self):
        schema = MOD.GG图像缩放.define_schema()
        self.assertEqual(schema.node_id, "GG图像缩放")
        方式 = [i for i in schema.inputs if getattr(i, "id", "") == "缩放方式"][0]
        self.assertEqual([o.key for o in 方式.options],
                         ["按倍数", "按长边", "按短边", "按宽度", "按高度", "按宽度高度"])
        参数项 = {o.key: [i.id for i in o.inputs] for o in 方式.options}
        self.assertEqual(参数项["按倍数"], ["缩放倍率"])
        self.assertEqual(参数项["按宽度高度"], ["宽度", "高度"])
        self.assertEqual(参数项["按高度"], ["高度"])


class 尺寸适配测试(unittest.TestCase):
    def test_default分辨率按面积就近取档(self):
        self.assertEqual(MOD._qwen21_auto_resolution(1024, 1024), 1024)
        self.assertEqual(MOD._qwen21_auto_resolution(512, 512), 512)
        self.assertEqual(MOD._qwen21_auto_resolution(4096, 4096), 2048)

    def test_候选尺寸是32倍数且面积在容差内(self):
        分辨率 = 1024
        容差 = max(1, int((分辨率 // 32) * 1.0))
        for 宽, 高, 格数 in MOD._qwen21_whitelist(分辨率, 1.0):
            self.assertEqual(宽 % 32, 0)
            self.assertEqual(高 % 32, 0)
            self.assertLessEqual(abs(格数 - (分辨率 // 32) ** 2), 容差)

    def test_固定点回退结果稳定(self):
        宽, 高 = MOD._qwen21_pick_target_size(1600, 900, 1024, 1.0)
        self.assertEqual((宽 % 32, 高 % 32), (0, 0))
        self.assertEqual(MOD._qwen21_verify_fixed_point(宽, 高, 1024), (宽, 高))

    def test_三种模式均输出目标尺寸(self):
        源 = image(2, 900, 1600)
        for 模式 in ("裁剪", "补边", "拉伸"):
            图, 宽, 高, 分辨率 = MOD._执行Qwen21尺寸适配(
                源, "1024", 1.0, 模式, 0.25
            )
            self.assertEqual(tuple(图.shape), (2, 高, 宽, 3))
            self.assertEqual((宽 % 32, 高 % 32), (0, 0))
            self.assertEqual(分辨率, 1024)

    def test_补边颜色作用于留白(self):
        源 = torch.zeros((1, 100, 200, 3))
        图, 宽, 高, _ = MOD._执行Qwen21尺寸适配(源, "1024", 1.0, "补边", 0.75)
        self.assertEqual(tuple(图.shape), (1, 高, 宽, 3))
        self.assertTrue(torch.any(torch.isclose(图, torch.tensor(0.75))))

    def test_批量输入保持批次(self):
        图, _, _, _ = MOD._执行Qwen21尺寸适配(image(3, 700, 1100))
        self.assertEqual(图.shape[0], 3)

    def test_节点已注册并有_v3_schema(self):
        self.assertIn("GG尺寸适配", MOD.NODE_CLASS_MAPPINGS)
        self.assertEqual(
            MOD.NODE_DISPLAY_NAME_MAPPINGS["GG尺寸适配"],
            "GG 尺寸适配",
        )
        schema = MOD.GG尺寸适配.define_schema()
        self.assertEqual(schema.node_id, "GG尺寸适配")
        self.assertEqual(
            [输出.display_name for 输出 in schema.outputs],
            ["图像", "宽度", "高度", "分辨率"],
        )

    def test_v3执行兼容嵌套与扁平模式(self):
        for 模式 in (
            {"模式": "补边", "补边颜色": 0.5},
            "拉伸",
        ):
            结果 = MOD.GG尺寸适配.execute(
                image(1, 900, 1600), "1024", 1.0, 模式
            )
            图, 宽, 高, _ = 结果.args if hasattr(结果, "args") else tuple(结果)
            self.assertEqual(tuple(图.shape), (1, 高, 宽, 3))


class 纯色图像测试(unittest.TestCase):
    def test_生成尺寸与颜色(self):
        图 = MOD._生成纯色图像(320, 200, "#00ff00")
        self.assertEqual(tuple(图.shape), (1, 200, 320, 3))
        self.assertTrue(torch.allclose(图, torch.tensor([0.0, 1.0, 0.0]), atol=1e-6))

    def test_颜色支持多种写法(self):
        self.assertTrue(torch.allclose(
            MOD._生成纯色图像(8, 8, "#fff"), torch.tensor([1.0, 1.0, 1.0]), atol=1e-6))
        self.assertTrue(torch.allclose(
            MOD._生成纯色图像(8, 8, "0,128,255"),
            torch.tensor([0.0, 128 / 255, 1.0]), atol=1e-6))

    def test_尺寸非法报错(self):
        for 宽, 高 in ((0, 100), (100, 0), (-5, 10)):
            with self.assertRaises(ValueError):
                MOD._生成纯色图像(宽, 高, "#ffffff")

    def test_超过上限报错(self):
        with self.assertRaises(ValueError) as 上下文:
            MOD._生成纯色图像(MOD._纯色图像尺寸上限 + 1, 16, "#ffffff")
        self.assertIn("最大", str(上下文.exception))

    def test_v3_执行(self):
        结果 = MOD.GG纯色图像.execute(64, 32, "#364254")
        图 = 结果.args[0] if hasattr(结果, "args") else tuple(结果)[0]
        self.assertEqual(tuple(图.shape), (1, 32, 64, 3))

    def test_已注册且单输出(self):
        self.assertIn("GG纯色图像", MOD.NODE_CLASS_MAPPINGS)
        self.assertEqual(MOD.NODE_DISPLAY_NAME_MAPPINGS["GG纯色图像"], "GG 纯色图像")
        schema = MOD.GG纯色图像.define_schema()
        self.assertEqual([输出.display_name for 输出 in schema.outputs], ["图像"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
