import comfy.sd
import comfy.utils
import folder_paths


class LoRAStackerBase:
    def __init__(self):
        self.loaded_loras = {}
        self.cache_size = 50

    @classmethod
    def get_base_inputs(cls):
        return {"required": {"模型": ("MODEL",)}}

    @classmethod
    def get_lora_file_inputs(cls, count: int) -> dict:
        lora_list = folder_paths.get_filename_list("loras")
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list

        inputs = {}
        for index in range(1, count + 1):
            inputs[f"LoRA{index}名称"] = (lora_list, {"default": "None"})
            inputs[f"LoRA{index}强度"] = (
                "FLOAT",
                {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01},
            )
        return inputs

    def load_lora_file(self, lora_name: str, strength: float):
        if lora_name == "None" or strength == 0:
            return None
        return self.load_lora_file_by_name(lora_name)

    def load_lora_file_by_name(self, lora_name: str):
        if lora_name == "None":
            return None

        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            lora_key = lora_name

            if lora_key in self.loaded_loras:
                lora_data = self.loaded_loras.pop(lora_key)
                self.loaded_loras[lora_key] = lora_data
                return lora_data

            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            if len(self.loaded_loras) >= self.cache_size:
                first_key = next(iter(self.loaded_loras))
                del self.loaded_loras[first_key]

            self.loaded_loras[lora_key] = lora
            return lora
        except Exception as exc:
            raise RuntimeError(
                f"加载 LoRA 失败：{lora_name}。请确认文件位于 ComfyUI/models/loras，且文件未损坏。\n原始错误：{exc}"
            ) from exc

    def apply_lora_stack(self, model: object, lora_data: list) -> object:
        result_model = model
        for lora, strength, lora_name in lora_data:
            if lora is None or strength == 0:
                continue
            try:
                result_model, _ = comfy.sd.load_lora_for_models(result_model, None, lora, strength, 0)
            except Exception as exc:
                raise RuntimeError(
                    f"应用 LoRA 失败：{lora_name}。请确认它与当前基础模型兼容，或调整 LoRA 强度。\n原始错误：{exc}"
                ) from exc
        return result_model

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import hashlib
        m = hashlib.sha256()
        m.update(str(id(kwargs.get("模型", kwargs.get("model", None)))).encode("utf-8"))
        for key in sorted(kwargs.keys()):
            val = kwargs.get(key)
            if isinstance(val, (str, int, float, bool)):
                m.update(f"{key}={val}".encode("utf-8"))
        return m.hexdigest()


class GGLoRACustomLoader(LoRAStackerBase):
    MAX_LORAS = 20

    @classmethod
    def INPUT_TYPES(cls):
        lora_list = folder_paths.get_filename_list("loras")
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list

        optional = {}
        for index in range(1, cls.MAX_LORAS + 1):
            optional[f"LoRA{index}名称"] = (lora_list, {"default": "None"})
            optional[f"LoRA{index}强度"] = (
                "FLOAT",
                {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01},
            )

        return {
            "required": {
                "模型": ("MODEL",),
                "LoRA数量": ("INT", {"default": 0, "min": 0, "max": cls.MAX_LORAS, "step": 1}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "load_loras"
    CATEGORY = "GuliNodes/模型"

    def load_loras(self, 模型: object, LoRA数量: int = 0, **kwargs) -> tuple:
        if 模型 is None:
            return (None,)

        lora_count = max(0, min(int(LoRA数量), self.MAX_LORAS))
        lora_data = []

        for index in range(1, lora_count + 1):
            lora_name = kwargs.get(f"LoRA{index}名称", "None")
            strength = float(kwargs.get(f"LoRA{index}强度", 1.0))
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength, lora_name))

        if not lora_data:
            return (模型,)

        return (self.apply_lora_stack(模型, lora_data),)


NODE_CLASS_MAPPINGS = {
    "GGLoRACustomLoader": GGLoRACustomLoader,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGLoRACustomLoader": "GG LoRA自定义加载",
}
