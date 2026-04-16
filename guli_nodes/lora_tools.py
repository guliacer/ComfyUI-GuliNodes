import comfy.utils
import comfy.sd
import folder_paths
import re


class LoRAStackerBase:
    def __init__(self):
        self.loaded_loras = {}
        self.cache_size = 50  # 缓存大小限制
        # 常见的LoRA触发关键词模式
        self.trigger_word_patterns = [
            r'\btrigger\w*\s*[:=]\s*["\'](.*?)["\']',
            r'\bkeyword\w*\s*[:=]\s*["\'](.*?)["\']',
            r'\bactivate\w*\s*[:=]\s*["\'](.*?)["\']',
        ]
    
    @classmethod
    def get_base_inputs(cls):
        return {"required": {"model": ("MODEL",), "prompt": ("STRING", {"default": "", "multiline": True})}}
    
    @classmethod
    def get_lora_file_inputs(cls, count: int) -> dict:
        """获取LoRA文件输入"""
        lora_list = folder_paths.get_filename_list("loras")
        # Ensure "None" option is available
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list
        inputs = {}
        for i in range(1, count + 1):
            inputs[f"lora{i}_name"] = (lora_list, {"default": "None"})
            inputs[f"strength{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01})
        return inputs
    
    def extract_trigger_words(self, lora_name: str, lora_data: dict) -> str:
        """从LoRA文件中提取触发关键词"""
        trigger_words = []
        
        # 1. 从文件名中提取触发关键词
        # 常见格式: [trigger_word1,trigger_word2]lora_name.safetensors
        filename_match = re.search(r'\[(.*?)\]', lora_name)
        if filename_match:
            trigger_words.extend(filename_match.group(1).split(','))
        
        # 2. 从LoRA数据的元数据中提取触发关键词
        if lora_data and 'metadata' in lora_data:
            metadata = lora_data['metadata']
            if isinstance(metadata, str):
                # 搜索元数据中的触发关键词
                for pattern in self.trigger_word_patterns:
                    matches = re.findall(pattern, metadata, re.IGNORECASE)
                    trigger_words.extend(matches)
            elif isinstance(metadata, dict):
                # 检查常见的元数据键
                for key in ['trigger', 'keywords', 'activation', 'trigger_words']:
                    if key in metadata:
                        value = metadata[key]
                        if isinstance(value, str):
                            trigger_words.append(value)
                        elif isinstance(value, list):
                            trigger_words.extend(value)
        
        # 3. 如果没有找到触发关键词，尝试从文件名中推断
        if not trigger_words:
            # 移除文件扩展名和特殊字符
            base_name = lora_name.split('.')[0]
            # 移除常见前缀和后缀
            base_name = re.sub(r'^\d*_?', '', base_name)
            base_name = re.sub(r'(_v\d+)?$', '', base_name)
            # 分割驼峰命名和下划线
            words = re.findall(r'[A-Z][a-z]*|[a-z]+|\d+', base_name)
            if words:
                # 使用第一个词作为触发关键词
                trigger_words.append(words[0].lower())
        
        # 去重并返回
        unique_trigger_words = list(set(trigger_words))
        return ', '.join([word.strip() for word in unique_trigger_words if word.strip()])
    
    def load_lora_file(self, lora_name: str, strength: float) -> dict:
        """加载LoRA文件"""
        if lora_name == "None" or strength == 0:
            return None
        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            lora_key = f"{lora_name}_{strength}"
            if lora_key in self.loaded_loras:
                # 将使用的项目移到缓存末尾
                lora_data = self.loaded_loras.pop(lora_key)
                self.loaded_loras[lora_key] = lora_data
                return lora_data
            # 检查缓存大小
            if len(self.loaded_loras) >= self.cache_size:
                # 删除最旧的缓存项
                first_key = next(iter(self.loaded_loras))
                del self.loaded_loras[first_key]
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            self.loaded_loras[lora_key] = lora
            return lora
        except Exception as e:
            print(f"Error loading LoRA {lora_name}: {e}")
            return None
    
    def apply_lora_stack(self, model: object, lora_data: list) -> object:
        """应用LoRA堆栈"""
        m = model
        for lora, strength in lora_data:
            if lora is not None and strength != 0:
                try:
                    m, _ = comfy.sd.load_lora_for_models(m, None, lora, strength, 0)
                except Exception as e:
                    print(f"Error applying LoRA: {e}")
                    continue
        return m


class GGLoRAFileStacker4(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(4)
        return inputs
    
    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("模型", "增强提示词")
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model: object, prompt: str = "", lora1_name: str = "None", lora2_name: str = "None", lora3_name: str = "None", lora4_name: str = "None",
              strength1: float = 1.0, strength2: float = 1.0, strength3: float = 1.0, strength4: float = 1.0) -> tuple:
        """堆叠4个LoRA并自动添加触发关键词"""
        # Protect: model cannot be None
        if model is None:
            return (None, prompt)
        lora_data = []
        trigger_words = []
        for lora_name, strength in [(lora1_name, strength1), (lora2_name, strength2),
                                   (lora3_name, strength3), (lora4_name, strength4)]:
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
                # 提取触发关键词
                words = self.extract_trigger_words(lora_name, lora)
                if words:
                    trigger_words.append(words)
        # If no valid LoRAs selected, return original model
        if not lora_data:
            return (model, prompt)
        result = self.apply_lora_stack(model, lora_data)
        # 合并触发关键词到提示词
        enhanced_prompt = prompt
        if trigger_words:
            trigger_text = ", ".join(trigger_words)
            # 检查提示词是否已经包含触发关键词
            if trigger_text not in prompt:
                enhanced_prompt = f"{prompt}, {trigger_text}" if prompt else trigger_text
        # Double protection: never return None
        if result is None:
            return (model, enhanced_prompt)  # Fallback to original
        return (result, enhanced_prompt)


class GGLoRAFileStacker8(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(8)
        return inputs
    
    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("模型", "增强提示词")
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model: object, prompt: str = "", **kwargs) -> tuple:
        """堆叠8个LoRA并自动添加触发关键词"""
        # Protect: model cannot be None
        if model is None:
            return (None, prompt)
        lora_data = []
        trigger_words = []
        for i in range(1, 9):
            lora_name = kwargs.get(f"lora{i}_name", "None")
            strength = kwargs.get(f"strength{i}", 1.0)
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
                # 提取触发关键词
                words = self.extract_trigger_words(lora_name, lora)
                if words:
                    trigger_words.append(words)
        # If no valid LoRAs selected, return original model
        if not lora_data:
            return (model, prompt)
        result = self.apply_lora_stack(model, lora_data)
        # 合并触发关键词到提示词
        enhanced_prompt = prompt
        if trigger_words:
            trigger_text = ", ".join(trigger_words)
            # 检查提示词是否已经包含触发关键词
            if trigger_text not in prompt:
                enhanced_prompt = f"{prompt}, {trigger_text}" if prompt else trigger_text
        # Double protection: never return None
        if result is None:
            return (model, enhanced_prompt)  # Fallback to original
        return (result, enhanced_prompt)


NODE_CLASS_MAPPINGS = {
    "GGLoRAFileStacker4": GGLoRAFileStacker4,
    "GGLoRAFileStacker8": GGLoRAFileStacker8,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGLoRAFileStacker4": "GG LoRA 文件选择堆 4个",
    "GGLoRAFileStacker8": "GG LoRA 文件选择堆 8个",
}