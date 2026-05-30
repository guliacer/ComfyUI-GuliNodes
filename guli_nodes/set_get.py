from typing import Any

try:
    from comfy_api.latest import io
except Exception:
    io = None


SET_NODE_ID = "GGSetNode"
GET_NODE_ID = "GGGetNode"
SET_DISPLAY_NAME = "GG Set"
GET_DISPLAY_NAME = "GG Get"
CATEGORY = "GuliNodes/工作流"
ANY_TYPE = "*"
WIDGET_NAME = "Constant"
VALUE_NAME = "值"
DEFAULT_NAME = "UNKNOWN"


if io is not None:
    AnySocket = io.Custom(ANY_TYPE)

    class GGSetNode(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=SET_NODE_ID,
                display_name=SET_DISPLAY_NAME,
                category=CATEGORY,
                description="前端虚拟设置节点，用于在画布内声明可被 GG 获取节点引用的连接值。",
                search_aliases=["GG Set", "Set", "设置", "变量设置"],
                inputs=[
                    io.String.Input(
                        WIDGET_NAME,
                        default=DEFAULT_NAME,
                        multiline=False,
                        placeholder="设置名称",
                    ),
                    AnySocket.Input(VALUE_NAME, extra_dict={"forceInput": True}),
                ],
                outputs=[
                    AnySocket.Output(display_name=VALUE_NAME),
                ],
            )

        @classmethod
        def execute(cls, Constant: str = DEFAULT_NAME, 值: Any = None):
            return io.NodeOutput(值)

    class GGGetNode(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=GET_NODE_ID,
                display_name=GET_DISPLAY_NAME,
                category=CATEGORY,
                description="前端虚拟获取节点，用于引用同名 GG 设置节点的连接值。",
                search_aliases=["GG Get", "Get", "获取", "变量获取"],
                inputs=[
                    io.String.Input(
                        WIDGET_NAME,
                        default="",
                        multiline=False,
                        placeholder="选择设置名称",
                    ),
                ],
                outputs=[
                    AnySocket.Output(display_name=VALUE_NAME),
                ],
            )

        @classmethod
        def execute(cls, Constant: str = ""):
            return io.NodeOutput(None)

else:

    class GGSetNode:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    WIDGET_NAME: (
                        "STRING",
                        {
                            "default": DEFAULT_NAME,
                            "multiline": False,
                            "placeholder": "设置名称",
                        },
                    ),
                    VALUE_NAME: (ANY_TYPE, {"forceInput": True}),
                },
            }

        RETURN_TYPES = (ANY_TYPE,)
        RETURN_NAMES = (VALUE_NAME,)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "前端虚拟设置节点，用于在画布内声明可被 GG 获取节点引用的连接值。"
        OUTPUT_NODE = False

        def execute(self, Constant: str = DEFAULT_NAME, 值: Any = None):
            return (值,)

    class GGGetNode:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    WIDGET_NAME: (
                        "STRING",
                        {
                            "default": "",
                            "multiline": False,
                            "placeholder": "选择设置名称",
                        },
                    ),
                },
            }

        RETURN_TYPES = (ANY_TYPE,)
        RETURN_NAMES = (VALUE_NAME,)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "前端虚拟获取节点，用于引用同名 GG 设置节点的连接值。"
        OUTPUT_NODE = False

        def execute(self, Constant: str = ""):
            return (None,)


NODE_CLASS_MAPPINGS = {
    SET_NODE_ID: GGSetNode,
    GET_NODE_ID: GGGetNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    SET_NODE_ID: SET_DISPLAY_NAME,
    GET_NODE_ID: GET_DISPLAY_NAME,
}
