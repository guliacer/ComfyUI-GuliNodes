import ast
import math
import numbers
import operator
from typing import Any


class GGNumber(float):
    def __new__(cls, value: float):
        return float.__new__(cls, value)

    def __index__(self):
        return int(self)

    def __add__(self, other):
        return GGNumber(float(self) + float(other))

    def __radd__(self, other):
        return GGNumber(float(other) + float(self))

    def __sub__(self, other):
        return GGNumber(float(self) - float(other))

    def __rsub__(self, other):
        return GGNumber(float(other) - float(self))


class GGAnyType(str):
    def __ne__(self, other):
        return False


GG_ANY_TYPE = GGAnyType("*")


_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

_UNARY_OPERATORS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
    ast.Not: operator.not_,
}

_COMPARE_OPERATORS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}

_MATH_FUNCTIONS = {
    "abs": abs,
    "min": min,
    "max": max,
    "round": round,
    "sum": sum,
    "len": len,
    "floor": math.floor,
    "ceil": math.ceil,
    "sqrt": math.sqrt,
    "pow": pow,
}

_MATH_CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
}


def _clamp(数值, 最小值, 最大值):
    return max(最小值, min(最大值, 数值))


_MATH_FUNCTIONS["clamp"] = _clamp


def _shape_to_list(值: Any):
    形状 = getattr(值, "shape", None)
    if 形状 is None:
        return None
    if len(形状) == 0 and hasattr(值, "item"):
        return float(值.item())
    return [int(尺寸) for 尺寸 in 形状]


def _normalize_math_input(名称: str, 值: Any):
    if 值 is None:
        return 0.0
    if isinstance(值, bool):
        return int(值)
    if isinstance(值, numbers.Real):
        return float(值)
    if isinstance(值, str):
        文本 = 值.strip()
        if not 文本:
            return 0.0
        try:
            return float(文本)
        except ValueError as exc:
            raise ValueError(f"变量 {名称} 的文本值无法转为数字：{值}") from exc
    if isinstance(值, dict) and hasattr(值.get("samples"), "shape"):
        return _shape_to_list(值["samples"])

    形状值 = _shape_to_list(值)
    if 形状值 is not None:
        return 形状值
    if isinstance(值, (list, tuple)):
        return [_normalize_math_input(f"{名称}[{索引}]", 子值) for 索引, 子值 in enumerate(值)]

    try:
        return float(值)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"变量 {名称} 不是可计算的数值或形状列表。") from exc


class _SafeMathEvaluator:
    def __init__(self, 变量: dict[str, Any]):
        self.变量 = 变量

    def evaluate(self, 表达式: str) -> float:
        文本 = str(表达式 or "").strip()
        if not 文本:
            return 0.0
        if len(文本) > 512:
            raise ValueError("表达式过长，请控制在 512 个字符以内。")
        try:
            节点 = ast.parse(文本, mode="eval").body
        except SyntaxError as exc:
            raise ValueError(f"表达式语法错误：{文本}") from exc

        结果 = self._eval(节点)
        return self._to_float(结果, 文本)

    def _eval(self, 节点):
        if isinstance(节点, ast.Constant):
            if isinstance(节点.value, bool):
                return int(节点.value)
            if isinstance(节点.value, numbers.Real):
                return float(节点.value)
            raise ValueError("表达式只能包含数字、变量和受支持的函数。")

        if isinstance(节点, ast.Name):
            if 节点.id in self.变量:
                return self.变量[节点.id]
            if 节点.id in _MATH_CONSTANTS:
                return _MATH_CONSTANTS[节点.id]
            raise ValueError(f"未知变量：{节点.id}。可用变量为 a~z（按接线顺序出现）。")

        if isinstance(节点, ast.BinOp):
            操作 = _BINARY_OPERATORS.get(type(节点.op))
            if 操作 is None:
                raise ValueError("不支持的运算符。")
            左值 = self._eval(节点.left)
            右值 = self._eval(节点.right)
            if isinstance(节点.op, ast.Pow) and abs(float(右值)) > 1000:
                raise ValueError("指数过大，请使用较小的幂运算。")
            return 操作(左值, 右值)

        if isinstance(节点, ast.UnaryOp):
            操作 = _UNARY_OPERATORS.get(type(节点.op))
            if 操作 is None:
                raise ValueError("不支持的一元运算符。")
            return 操作(self._eval(节点.operand))

        if isinstance(节点, ast.BoolOp):
            值列表 = [bool(self._eval(子节点)) for 子节点 in 节点.values]
            if isinstance(节点.op, ast.And):
                return int(all(值列表))
            if isinstance(节点.op, ast.Or):
                return int(any(值列表))
            raise ValueError("不支持的布尔运算。")

        if isinstance(节点, ast.Compare):
            左值 = self._eval(节点.left)
            for 操作节点, 右节点 in zip(节点.ops, 节点.comparators):
                操作 = _COMPARE_OPERATORS.get(type(操作节点))
                if 操作 is None:
                    raise ValueError("不支持的比较运算符。")
                右值 = self._eval(右节点)
                if not 操作(左值, 右值):
                    return 0
                左值 = 右值
            return 1

        if isinstance(节点, ast.Call):
            if not isinstance(节点.func, ast.Name):
                raise ValueError("只支持直接调用白名单函数。")
            函数 = _MATH_FUNCTIONS.get(节点.func.id)
            if 函数 is None:
                raise ValueError(f"不支持的函数：{节点.func.id}。")
            if 节点.keywords:
                raise ValueError("函数暂不支持关键字参数。")
            参数 = [self._eval(参数节点) for 参数节点 in 节点.args]
            return 函数(*参数)

        if isinstance(节点, ast.Subscript):
            值 = self._eval(节点.value)
            索引 = self._eval_slice(节点.slice)
            return 值[索引]

        if isinstance(节点, ast.List):
            return [self._eval(子节点) for 子节点 in 节点.elts]

        if isinstance(节点, ast.Tuple):
            return tuple(self._eval(子节点) for 子节点 in 节点.elts)

        raise ValueError("表达式包含不支持的语法。")

    def _eval_slice(self, 节点):
        if isinstance(节点, ast.Slice):
            起点 = self._eval(节点.lower) if 节点.lower is not None else None
            终点 = self._eval(节点.upper) if 节点.upper is not None else None
            步长 = self._eval(节点.step) if 节点.step is not None else None
            return slice(_to_index(起点), _to_index(终点), _to_index(步长))
        return _to_index(self._eval(节点))

    @staticmethod
    def _to_float(结果, 表达式: str) -> float:
        if isinstance(结果, bool):
            数值 = float(int(结果))
        elif isinstance(结果, numbers.Real):
            数值 = float(结果)
        else:
            try:
                数值 = float(结果)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"表达式 `{表达式}` 的结果不是单个数值；"
                    "如果输入是图像或 Latent 形状，请使用 a[0]、a[1] 这类索引。"
                ) from exc

        if math.isnan(数值):
            return 0.0
        if not math.isfinite(数值):
            raise ValueError("计算结果不是有限数值，请检查除零或溢出。")
        return 数值


def _to_index(值):
    if 值 is None:
        return None
    return int(值)


def _evaluate_math_value(表达式: str, 变量: dict[str, Any]) -> GGNumber:
    """一条表达式只产出一个数值；整数/浮点下游都从同一个值取。"""
    浮点 = _SafeMathEvaluator(变量).evaluate(表达式)
    return GGNumber(round(浮点, 10))


# 前端按「接线才长下一个」逐格显示，后端必须把所有可能出现的名字一次声明完，
# 否则前端 addInput 长出来的端口会在 validate_inputs 里被判成未知输入。
GG_MATH_INPUT_NAMES = tuple(chr(ord("a") + index) for index in range(26))
GG_MATH_MAX_EXPRESSIONS = 10
GG_MATH_MAX_OUTPUTS = GG_MATH_MAX_EXPRESSIONS
# 新节点每条表达式默认就是对应的那个变量；老工作流里存着的 a*c/d、b*c/d
# 由 widgets_values 原样带回来，不在这里改。
GG_MATH_DEFAULT_EXPRESSIONS = tuple(
    GG_MATH_INPUT_NAMES[index] for index in range(GG_MATH_MAX_EXPRESSIONS)
)


class GGSimpleMath:
    @classmethod
    def INPUT_TYPES(cls):
        可选输入 = {
            名称: (GG_ANY_TYPE, {"forceInput": True})
            for 名称 in GG_MATH_INPUT_NAMES
        }
        必填表达式 = {}
        for 序号 in range(1, GG_MATH_MAX_EXPRESSIONS + 1):
            必填表达式[f"表达式_{序号}"] = (
                "STRING",
                {
                    "default": GG_MATH_DEFAULT_EXPRESSIONS[序号 - 1],
                    "multiline": False,
                    "tooltip": (
                        f"第 {序号} 组计算表达式，对应第 {序号} 个结果输出；"
                        "可使用 a~z 和 + - * / // % ** 等运算，示例 round(a/8)*8、max(a,b)、a[1]。"
                    ),
                },
            )
        return {"optional": 可选输入, "required": 必填表达式}

    # 每个输出都是同一个「整数/浮点通用」数值：下游要 INT 就取整，要 FLOAT 就保留小数。
    # 旧的 FLOAT 输出端口已删除，旧连线由 web/gg-simple-math.js 迁移到对应结果槽。
    RETURN_TYPES = (GG_ANY_TYPE,) * GG_MATH_MAX_OUTPUTS
    RETURN_NAMES = tuple(f"结果_{序号}" for 序号 in range(1, GG_MATH_MAX_OUTPUTS + 1))
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = (
        "输入源与结果输出都随接线自动增长；每条表达式对应一个结果输出，"
        "结果同时可用于整数和浮点下游。"
    )

    def execute(self, **kwargs):
        变量 = {}
        for 名称 in GG_MATH_INPUT_NAMES:
            # d 保持老默认 1：老工作流里 a*c/d 这类表达式没接 d 时不会除零。
            默认值 = 1.0 if 名称 == "d" else 0.0
            变量[名称] = _normalize_math_input(名称, kwargs.get(名称, 默认值))

        结果 = []
        for 序号 in range(1, GG_MATH_MAX_EXPRESSIONS + 1):
            键 = f"表达式_{序号}"
            表达式 = kwargs.get(键, GG_MATH_DEFAULT_EXPRESSIONS[序号 - 1])
            try:
                结果.append(_evaluate_math_value(表达式, 变量))
            except ValueError as exc:
                raise ValueError(f"{键} 计算失败：{exc}") from exc
        # 前端只显示前 N 个输出，多返回的值没有连线、不会被下游取到。
        return tuple(结果)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        表达式 = tuple(
            str(kwargs.get(f"表达式_{序号}", GG_MATH_DEFAULT_EXPRESSIONS[序号 - 1]))
            for 序号 in range(1, GG_MATH_MAX_EXPRESSIONS + 1)
        )
        变量 = tuple(
            (名称, repr(_normalize_math_input(名称, kwargs[名称])))
            for 名称 in GG_MATH_INPUT_NAMES
            if 名称 in kwargs
        )
        return (表达式, 变量)


class GGInteger:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "整数": (
                    "INT",
                    {
                        "default": 0,
                        "min": -2147483648,
                        "max": 2147483647,
                        "step": 1,
                        "tooltip": "输入需要输出的整数值。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("整数",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = "输入一个自定义整数并原样输出。"

    def execute(self, 整数: int = 0):
        return (int(整数),)


NODE_CLASS_MAPPINGS = {
    "GGSimpleMath": GGSimpleMath,
    "GGInteger": GGInteger,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSimpleMath": "GG 简单数学表达式",
    "GGInteger": "GG 整数",
}
