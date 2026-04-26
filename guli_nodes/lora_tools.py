import comfy.sd
import comfy.utils
import folder_paths


class LoRAStackerBase:
    def __init__(self):
        self.loaded_loras = {}
        self.cache_size = 50

    @classmethod
    def get_base_inputs(cls):
        return {"required": {"model": ("MODEL",)}}

    @classmethod
    def get_lora_file_inputs(cls, count: int) -> dict:
        lora_list = folder_paths.get_filename_list("loras")
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list

        inputs = {}
        for index in range(1, count + 1):
            inputs[f"lora{index}_name"] = (lora_list, {"default": "None"})
            inputs[f"strength{index}"] = (
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

            if len(self.loaded_loras) >= self.cache_size:
                first_key = next(iter(self.loaded_loras))
                del self.loaded_loras[first_key]

            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            self.loaded_loras[lora_key] = lora
            return lora
        except Exception as exc:
            print(f"Error loading LoRA {lora_name}: {exc}")
            return None

    def apply_lora_stack(self, model: object, lora_data: list) -> object:
        result_model = model
        for lora, strength in lora_data:
            if lora is None or strength == 0:
                continue
            try:
                result_model, _ = comfy.sd.load_lora_for_models(result_model, None, lora, strength, 0)
            except Exception as exc:
                print(f"Error applying LoRA: {exc}")
        return result_model


class GGLoRAFileStacker4V2(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = cls.get_base_inputs()
        inputs["optional"] = cls.get_lora_file_inputs(4)
        return inputs

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(
        self,
        model: object,
        lora1_name: str = "None",
        lora2_name: str = "None",
        lora3_name: str = "None",
        lora4_name: str = "None",
        strength1: float = 1.0,
        strength2: float = 1.0,
        strength3: float = 1.0,
        strength4: float = 1.0,
    ) -> tuple:
        if model is None:
            return (None,)

        lora_data = []
        for lora_name, strength in [
            (lora1_name, strength1),
            (lora2_name, strength2),
            (lora3_name, strength3),
            (lora4_name, strength4),
        ]:
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))

        if not lora_data:
            return (model,)

        return (self.apply_lora_stack(model, lora_data),)


class GGLoRACustomLoader(LoRAStackerBase):
    MAX_LORAS = 20

    @classmethod
    def INPUT_TYPES(cls):
        lora_list = folder_paths.get_filename_list("loras")
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list

        optional = {}
        for index in range(1, cls.MAX_LORAS + 1):
            optional[f"lora{index}_name"] = (lora_list, {"default": "None"})
            optional[f"strength{index}"] = (
                "FLOAT",
                {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01},
            )

        return {
            "required": {
                "model": ("MODEL",),
                "LoRA数量": ("INT", {"default": 0, "min": 0, "max": cls.MAX_LORAS, "step": 1}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "load_loras"
    CATEGORY = "GuliNodes/LoRA工具"

    def load_loras(self, model: object, LoRA数量: int = 0, **kwargs) -> tuple:
        if model is None:
            return (None,)

        lora_count = max(0, min(int(LoRA数量), self.MAX_LORAS))
        lora_data = []

        for index in range(1, lora_count + 1):
            lora_name = kwargs.get(f"lora{index}_name", "None")
            strength = float(kwargs.get(f"strength{index}", 1.0))
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))

        if not lora_data:
            return (model,)

        return (self.apply_lora_stack(model, lora_data),)


class GGLoRAFileStacker8V2(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = cls.get_base_inputs()
        inputs["optional"] = cls.get_lora_file_inputs(8)
        return inputs

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model: object, **kwargs) -> tuple:
        if model is None:
            return (None,)

        lora_data = []
        for index in range(1, 9):
            lora_name = kwargs.get(f"lora{index}_name", "None")
            strength = kwargs.get(f"strength{index}", 1.0)
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))

        if not lora_data:
            return (model,)

        return (self.apply_lora_stack(model, lora_data),)


NODE_CLASS_MAPPINGS = {
    "GGLoRAFileStacker4V2": GGLoRAFileStacker4V2,
    "GGLoRACustomLoader": GGLoRACustomLoader,
    "GGLoRAFileStacker8V2": GGLoRAFileStacker8V2,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGLoRAFileStacker4V2": "GG LoRA选择 4个",
    "GGLoRACustomLoader": "GG LoRA自定义加载",
    "GGLoRAFileStacker8V2": "GG LoRA选择 8个",
}
