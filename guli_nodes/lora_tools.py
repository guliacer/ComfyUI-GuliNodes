import json

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

        # 启用开关必须声明在名称/强度之后：widgets_values 是按声明顺序存的位置数组，
        # 插在中间会让老工作流里所有的名称/强度整体错位，追加到末尾旧值才对得上。
        for index in range(1, cls.MAX_LORAS + 1):
            optional[f"LoRA{index}启用"] = ("BOOLEAN", {"default": True})

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
            enabled = kwargs.get(f"LoRA{index}启用", True)
            # 老工作流存的是位置数组：末尾那个「新增LoRA」按钮的值会顶到启用开关上，
            # 传进来的可能是 "新增LoRA" 这种字符串，不能当 False 处理。
            if isinstance(enabled, str):
                enabled = enabled.strip().lower() not in ("false", "0", "off", "")
            if not enabled:
                # 关掉的槽位保留名称与强度，只是这次不加载，下次打开不用重选。
                continue
            lora_name = kwargs.get(f"LoRA{index}名称", "None")
            strength = float(kwargs.get(f"LoRA{index}强度", 1.0))
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength, lora_name))

        if not lora_data:
            return (模型,)

        return (self.apply_lora_stack(模型, lora_data),)


class GGLoRAGroupLoader(GGLoRACustomLoader):
    """LoRA 组加载：画布上维护多组 LoRA，选中哪组就只加载哪组。

    组配置随 UI 工作流保存，提交时一并传给后端。未连接组选择时沿用
    画布当前组；连接后即使选择其他组，也能在执行时加载对应的 LoRA。

    「当前组」这个隐藏控件唯一的作用是参与 IS_CHANGED 的哈希：两组 LoRA
    值碰巧相同时，切换组也必须重新执行，不能吃到上一组的缓存。
    """

    MAX_GROUPS = 30

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        # 新节点没有老存档，直接追加在 required 末尾即可；控件由前端隐藏。
        spec["required"]["当前组"] = (
            "INT",
            {"default": 1, "min": 1, "max": cls.MAX_GROUPS, "step": 1},
        )
        # 追加在全部旧控件之后，保持老工作流的位置数组及连线顺序。
        spec["optional"]["选择组"] = ("STRING", {"default": ""})
        spec["optional"]["组数据"] = ("STRING", {"default": ""})
        return spec

    FUNCTION = "load_group"

    def load_group(
        self, 模型: object, LoRA数量: int = 0, 当前组: int = 1,
        选择组: str = "", 组数据: str = "", **kwargs,
    ) -> tuple:
        if not 选择组:
            return self.load_loras(模型, LoRA数量, **kwargs)

        try:
            groups = json.loads(组数据)
        except (TypeError, ValueError) as exc:
            raise ValueError("LoRA 组数据无效，请重新打开工作流并检查组配置。") from exc
        if not isinstance(groups, list) or not groups or not all(isinstance(group, dict) for group in groups):
            raise ValueError("LoRA 组数据为空或格式错误，请检查组配置。")

        # 下拉值含位置和组名，重名时也能准确选择；外部 STRING 节点可直接给唯一组名。
        choices = [f"{index + 1}. {group.get('name') or f'LoRA组{index + 1}'}"
                   for index, group in enumerate(groups)]
        choice = str(选择组).strip()
        if choice in choices:
            index = choices.index(choice)
        else:
            matches = [i for i, group in enumerate(groups) if str(group.get("name", "")) == choice]
            if len(matches) != 1:
                raise ValueError(f"选择的 LoRA 组「{choice}」不存在或名称重复，请从组选择列表中重新选择。")
            index = matches[0]

        # 当前编辑组的控件可能接了真实上游输入，保留 ComfyUI 已解析的值。
        if index == int(当前组) - 1:
            return self.load_loras(模型, LoRA数量, **kwargs)

        loras = groups[index].get("loras", [])
        if not isinstance(loras, list):
            raise ValueError("所选 LoRA 组的内容格式错误，请检查该组的 LoRA 配置。")
        loras = loras[:self.MAX_LORAS]
        group_inputs = {}
        for slot, lora in enumerate(loras, 1):
            if not isinstance(lora, dict):
                raise ValueError(f"所选 LoRA 组的第 {slot} 条配置无效，请重新设置该 LoRA。")
            group_inputs[f"LoRA{slot}名称"] = lora.get("name", "None")
            group_inputs[f"LoRA{slot}强度"] = lora.get("strength", 1.0)
            group_inputs[f"LoRA{slot}启用"] = lora.get("enable", True)
        return self.load_loras(模型, len(loras), **group_inputs)


NODE_CLASS_MAPPINGS = {
    "GGLoRACustomLoader": GGLoRACustomLoader,
    "GGLoRAGroupLoader": GGLoRAGroupLoader,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGLoRACustomLoader": "GG LoRA自定义加载",
    "GGLoRAGroupLoader": "GG LoRA组加载",
}
