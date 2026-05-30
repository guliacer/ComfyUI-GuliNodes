import hashlib

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGKeyInput"
DISPLAY_NAME = "GG 密钥输入"
CATEGORY = "GuliNodes/输入"
KEY_NAME = "密钥"


def _normalize_key(value: str | None) -> str:
    return str(value or "").strip()


def _fingerprint_key(value: str | None) -> str:
    return hashlib.sha256(_normalize_key(value).encode("utf-8")).hexdigest()


if io is not None:

    class GGKeyInput(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description="输入 API Key、访问令牌等密钥，并输出为字符串。",
                search_aliases=["KeyInput", "API Key Input", "密钥输入"],
                inputs=[
                    io.String.Input(
                        KEY_NAME,
                        default="",
                        multiline=False,
                        placeholder="输入 API Key 或访问令牌",
                    ),
                ],
                outputs=[
                    io.String.Output(display_name=KEY_NAME),
                ],
            )

        @classmethod
        def execute(cls, 密钥: str = ""):
            return io.NodeOutput(_normalize_key(密钥))

        @classmethod
        def IS_CHANGED(cls, 密钥: str = ""):
            return _fingerprint_key(密钥)

else:

    class GGKeyInput:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    KEY_NAME: (
                        "STRING",
                        {
                            "default": "",
                            "multiline": False,
                            "placeholder": "输入 API Key 或访问令牌",
                        },
                    ),
                },
            }

        RETURN_TYPES = ("STRING",)
        RETURN_NAMES = (KEY_NAME,)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "输入 API Key、访问令牌等密钥，并输出为字符串。"

        def execute(self, 密钥: str = ""):
            return (_normalize_key(密钥),)

        @classmethod
        def IS_CHANGED(cls, 密钥: str = ""):
            return _fingerprint_key(密钥)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGKeyInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
