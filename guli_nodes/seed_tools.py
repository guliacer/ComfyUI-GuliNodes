import hashlib
import random
import secrets
import threading
import time


class GGSeedGenerator:
    _MAX_SEED = 0xFFFFFFFF
    _SOURCE_RANDOM = "随机"
    _SOURCE_MANUAL = "手动"
    _SOURCE_LAST = "上次"
    _OFFSET_KEEP = "保持"
    _OFFSET_ADD = "增加"
    _OFFSET_SUB = "减少"

    _state_lock = threading.Lock()
    _rng_by_node = {}
    _last_seed_by_node = {}
    _last_config_by_node = {}
    _change_counter = 0
    _random_source = secrets.SystemRandom()

    @classmethod
    def _state_key(cls, unique_id) -> str:
        return str(unique_id) if unique_id not in (None, "") else "__global__"

    @classmethod
    def _normalize_seed(cls, seed_value: int) -> int:
        try:
            return int(seed_value) % (cls._MAX_SEED + 1)
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _seed_material(cls, state_key: str) -> int:
        payload = f"{state_key}|{time.time_ns()}|{cls._random_source.getrandbits(64)}"
        digest = hashlib.sha256(payload.encode("utf-8")).digest()
        return int.from_bytes(digest[:8], "big")

    @classmethod
    def _new_random_seed(cls, state_key: str) -> int:
        with cls._state_lock:
            seed_material = cls._seed_material(state_key)
            rng = random.Random(seed_material)
            cls._rng_by_node[state_key] = rng
            return rng.randint(0, cls._MAX_SEED)

    @classmethod
    def _get_last_seed(cls, state_key: str, fallback_seed: int | None = None) -> int:
        with cls._state_lock:
            if state_key in cls._last_seed_by_node:
                return cls._last_seed_by_node[state_key]
        if fallback_seed is None:
            return 1
        return cls._normalize_seed(fallback_seed)

    @classmethod
    def _set_last_seed(cls, state_key: str, seed: int) -> None:
        with cls._state_lock:
            cls._last_seed_by_node[state_key] = seed

    @classmethod
    def _get_sequence_seed(cls, state_key: str, config_key: str, fallback_seed: int) -> int:
        with cls._state_lock:
            if cls._last_config_by_node.get(state_key) == config_key and state_key in cls._last_seed_by_node:
                return cls._last_seed_by_node[state_key]
        return cls._normalize_seed(fallback_seed)

    @classmethod
    def _set_node_state(cls, state_key: str, seed: int, config_key: str) -> None:
        with cls._state_lock:
            cls._last_seed_by_node[state_key] = seed
            cls._last_config_by_node[state_key] = config_key

    @classmethod
    def _next_change_nonce(cls) -> int:
        with cls._state_lock:
            cls._change_counter += 1
            return cls._change_counter

    @classmethod
    def _change_token(cls, state_key: str) -> str:
        payload = f"{state_key}|{time.time_ns()}|{cls._next_change_nonce()}|{cls._random_source.getrandbits(64)}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "种子来源": (
                    [cls._SOURCE_RANDOM, cls._SOURCE_MANUAL, cls._SOURCE_LAST],
                    {"default": cls._SOURCE_RANDOM},
                ),
                "种子": ("INT", {"default": 1, "min": 0, "max": cls._MAX_SEED}),
                "偏移模式": (
                    [
                        cls._OFFSET_KEEP,
                        cls._OFFSET_ADD,
                        cls._OFFSET_SUB,
                    ],
                    {"default": cls._OFFSET_KEEP},
                ),
                "步长": ("INT", {"default": 500, "min": 1, "max": cls._MAX_SEED}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("种子",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/采样"

    @classmethod
    def _config_key(cls, 种子来源: str, 种子: int, 偏移模式: str, 步长: int) -> str:
        return f"{种子来源}|{种子}|{偏移模式}|{步长}"

    @classmethod
    def _resolve_base_seed(cls, 种子来源: str, 种子: int, 偏移模式: str, 步长: int, state_key: str) -> int:
        if 种子来源 == cls._SOURCE_RANDOM:
            return cls._new_random_seed(state_key)
        if 种子来源 == cls._SOURCE_MANUAL:
            if 偏移模式 != cls._OFFSET_KEEP:
                return cls._get_sequence_seed(state_key, cls._config_key(种子来源, 种子, 偏移模式, 步长), 种子)
            return 种子
        return cls._get_last_seed(state_key, fallback_seed=种子)

    @classmethod
    def _apply_offset(cls, 种子: int, 偏移模式: str, 步长: int) -> int:
        if 偏移模式 == cls._OFFSET_ADD:
            return 种子 + 步长
        if 偏移模式 == cls._OFFSET_SUB:
            return 种子 - 步长
        return 种子

    @classmethod
    def IS_CHANGED(
        cls,
        种子来源: str = _SOURCE_RANDOM,
        种子: int = 1,
        偏移模式: str = _OFFSET_KEEP,
        步长: int = 500,
        prompt: dict = None,
        extra_pnginfo: dict = None,
        unique_id: str = None,
        **kwargs,
    ):
        unique_id = kwargs.get("unique_id", unique_id)
        state_key = cls._state_key(unique_id)
        种子 = cls._normalize_seed(种子)
        步长 = max(1, cls._normalize_seed(步长))

        if 种子来源 == cls._SOURCE_RANDOM:
            return f"{state_key}:random:{cls._change_token(state_key)}"

        if 种子来源 == cls._SOURCE_MANUAL:
            config_key = cls._config_key(种子来源, 种子, 偏移模式, 步长)
            当前种子 = 种子 if 偏移模式 == cls._OFFSET_KEEP else cls._get_sequence_seed(state_key, config_key, 种子)
            payload = f"{state_key}|manual|{当前种子}|{config_key}"
            return hashlib.sha256(payload.encode("utf-8")).hexdigest()

        当前种子 = cls._get_last_seed(state_key, fallback_seed=种子)
        payload = f"{state_key}|last|{当前种子}|{偏移模式}|{步长}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def generate(
        self,
        种子来源: str = _SOURCE_RANDOM,
        种子: int = 1,
        偏移模式: str = _OFFSET_KEEP,
        步长: int = 500,
        prompt: dict = None,
        extra_pnginfo: dict = None,
        unique_id: str = None,
    ) -> dict:
        state_key = self._state_key(unique_id)
        种子 = self._normalize_seed(种子)
        步长 = max(1, self._normalize_seed(步长))

        config_key = self._config_key(种子来源, 种子, 偏移模式, 步长)
        result_seed = self._resolve_base_seed(种子来源, 种子, 偏移模式, 步长, state_key)
        result_seed = self._apply_offset(result_seed, 偏移模式, 步长)
        result_seed = self._normalize_seed(result_seed)

        self._set_node_state(state_key, result_seed, config_key)
        return {
            "ui": {
                "seed": [result_seed],
                "source": [种子来源],
                "offset_mode": [偏移模式],
                "state_key": [state_key],
            },
            "result": (result_seed,),
        }


NODE_CLASS_MAPPINGS = {
    "GGSeedGenerator": GGSeedGenerator,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSeedGenerator": "GG 种子生成器",
}
