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


NODE_CLASS_MAPPINGS = {
    "GGFloat": GGFloat,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGFloat": "GG 数值",
}
