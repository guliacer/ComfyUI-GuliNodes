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


class GGFloat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "数值": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": -3.4028234663852886e38,
                        "max": 3.4028234663852886e38,
                        "step": 0.01,
                        "round": 0.000001,
                        "display": "number",
                        "tooltip": "自定义浮点数值。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("FLOAT,INT",)
    RETURN_NAMES = ("数值",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = "Custom numeric literal node that can connect to FLOAT and INT inputs."

    def execute(self, 数值: float):
        return (GGNumber(数值),)

    @classmethod
    def IS_CHANGED(cls, 数值: float):
        return float(数值)


class GGFloatSlider:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "数值": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "round": 0.01,
                        "display": "slider",
                        "tooltip": "输出 0 到 1 之间的浮点滑条数值，结果保留两位小数。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("浮点",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = "0 到 1 范围的浮点滑条输入节点。"

    @staticmethod
    def _normalize(数值: float) -> float:
        try:
            数值 = float(数值)
        except (TypeError, ValueError):
            数值 = 1.0
        数值 = max(0.0, min(1.0, 数值))
        return round(数值, 2)

    def execute(self, 数值: float):
        return (self._normalize(数值),)

    @classmethod
    def IS_CHANGED(cls, 数值: float):
        return cls._normalize(数值)


class GGUniversalSlider:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "数值": (
                    "FLOAT",
                    {
                        "default": 0.75,
                        "min": -999999.0,
                        "max": 999999.0,
                        "step": 0.01,
                        "round": 0.0000000001,
                        "display": "slider",
                        "tooltip": "可自定义范围、步长和输出类型的数值滑条。",
                    },
                ),
            },
            "hidden": {
                "输出类型": (["浮点", "整数"], {"default": "浮点"}),
            },
        }

    RETURN_TYPES = (GG_ANY_TYPE,)
    RETURN_NAMES = ("数值",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = "可自定义范围、步长、显示名称和浮点/整数输出的万能滑条。"

    @staticmethod
    def _normalize_type(输出类型: str) -> str:
        文本 = str(输出类型 or "浮点").strip().lower()
        if 文本 in {"整数", "整型", "int", "integer"}:
            return "整数"
        return "浮点"

    @classmethod
    def _normalize(cls, 数值: float, 输出类型: str = "浮点"):
        try:
            结果 = round(float(数值), 10)
        except (TypeError, ValueError, OverflowError):
            结果 = 0.0

        if cls._normalize_type(输出类型) == "整数":
            return int(round(结果))
        return GGNumber(结果)

    def execute(self, 数值: float, 输出类型: str = "浮点"):
        return (self._normalize(数值, 输出类型),)

    @classmethod
    def IS_CHANGED(cls, 数值: float, 输出类型: str = "浮点"):
        return cls._normalize(数值, 输出类型)


NODE_CLASS_MAPPINGS = {
    "GGFloat": GGFloat,
    "GGFloatSlider": GGFloatSlider,
    "GGUniversalSlider": GGUniversalSlider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGFloat": "GG 数值",
    "GGFloatSlider": "GG 浮点滑条",
    "GGUniversalSlider": "GG 万能滑条",
}
