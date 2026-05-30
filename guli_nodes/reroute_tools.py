from typing import Any

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGPrettyReroute"
DISPLAY_NAME = "GG 转接"
CATEGORY = "GuliNodes/工作流"
ANY_TYPE = "*"


if io is not None:
    AnySocket = io.Custom(ANY_TYPE)

    class GGPrettyReroute(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description=(
                    "A compact pass-through reroute node with a polished frontend. "
                    "It keeps workflow execution/API export compatible while the UI extension "
                    "matches socket colors and layout to connected types."
                ),
                search_aliases=["Reroute", "GG Reroute", "美化 Reroute", "Pretty Reroute"],
                inputs=[
                    AnySocket.Input("值", extra_dict={"forceInput": True}),
                ],
                outputs=[
                    AnySocket.Output(display_name="值"),
                ],
            )

        @classmethod
        def execute(cls, 值: Any):
            return io.NodeOutput(值)

else:

    class GGPrettyReroute:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "值": (ANY_TYPE, {"forceInput": True}),
                },
            }

        RETURN_TYPES = (ANY_TYPE,)
        RETURN_NAMES = ("值",)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = (
            "A compact pass-through reroute node with a polished frontend. "
            "It keeps workflow execution/API export compatible while the UI extension "
            "matches socket colors and layout to connected types."
        )

        def execute(self, 值: Any):
            return (值,)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGPrettyReroute,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
