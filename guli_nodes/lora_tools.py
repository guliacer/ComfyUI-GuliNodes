import comfy.utils
import comfy.sd
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
        for i in range(1, count + 1):
            inputs[f"lora{i}_name"] = (lora_list, {"default": "None"})
            inputs[f"strength{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01})
        return inputs

    def load_lora_file(self, lora_name: str, strength: float) -> dict:
        if lora_name == "None" or strength == 0:
            return None
        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            lora_key = f"{lora_name}_{strength}"
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
        except Exception as e:
            print(f"Error loading LoRA {lora_name}: {e}")
            return None

    def apply_lora_stack(self, model: object, lora_data: list) -> object:
        m = model
        for lora, strength in lora_data:
            if lora is not None and strength != 0:
                try:
                    m, _ = comfy.sd.load_lora_for_models(m, None, lora, strength, 0)
                except Exception as e:
                    print(f"Error applying LoRA: {e}")
                    continue
        return m


class GGLoRAFileStacker4V2(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(4)
        return inputs

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model: object, lora1_name: str = "None", lora2_name: str = "None", lora3_name: str = "None", lora4_name: str = "None",
              strength1: float = 1.0, strength2: float = 1.0, strength3: float = 1.0, strength4: float = 1.0) -> tuple:
        if model is None:
            return (None,)
        lora_data = []
        for lora_name, strength in [(lora1_name, strength1), (lora2_name, strength2),
                                   (lora3_name, strength3), (lora4_name, strength4)]:
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
        if not lora_data:
            return (model,)
        result = self.apply_lora_stack(model, lora_data)
        if result is None:
            return (model,)
        return (result,)


class GGLoRAFileStacker8V2(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(8)
        return inputs

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model: object, **kwargs) -> tuple:
        if model is None:
            return (None,)
        lora_data = []
        for i in range(1, 9):
            lora_name = kwargs.get(f"lora{i}_name", "None")
            strength = kwargs.get(f"strength{i}", 1.0)
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
        if not lora_data:
            return (model,)
        result = self.apply_lora_stack(model, lora_data)
        if result is None:
            return (model,)
        return (result,)


NODE_CLASS_MAPPINGS = {
    "GGLoRAFileStacker4V2": GGLoRAFileStacker4V2,
    "GGLoRAFileStacker8V2": GGLoRAFileStacker8V2,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGLoRAFileStacker4V2": "GG LoRA选择 4个",
    "GGLoRAFileStacker8V2": "GG LoRA选择 8个",
}
