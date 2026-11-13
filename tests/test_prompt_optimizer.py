"""GG Qwen Image 2.1 prompt encoding performance contract tests."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]
for root in (PLUGIN_ROOT, COMFY_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from guli_nodes import prompt_optimizer as optimizer


class FakeClip:
    def __init__(self):
        self.tokenize_calls = []
        self.encode_calls = []

    def tokenize(self, prompt, **kwargs):
        tokens = {"prompt": prompt, **kwargs}
        self.tokenize_calls.append(tokens)
        return tokens

    def encode_from_tokens_scheduled(self, tokens):
        self.encode_calls.append(tokens)
        return [[torch.tensor([[len(self.encode_calls)]], dtype=torch.float32), {"prompt": tokens["prompt"]}]]


class FakeVae:
    def __init__(self):
        self.latents = []

    def encode(self, image):
        latent = torch.tensor([len(self.latents)], dtype=torch.float32)
        self.latents.append(latent)
        return latent


class PromptOptimizerPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.image = torch.full((1, 32, 32, 3), 0.5)

    def encode(self, positive, negative, *, with_vae=True, images=True):
        clip = FakeClip()
        vae = FakeVae() if with_vae else None
        image_inputs = {"图像1": self.image} if images else {}
        with patch.object(optimizer, "_prepare_reference_image", side_effect=lambda image, resolution: image):
            result = optimizer._encode_qwen_image21(
                clip,
                vae,
                positive,
                negative,
                1024,
                image_inputs,
            )
        return clip, vae, result

    def test_positive_and_negative_outputs_match_native_two_encodings(self):
        clip, vae, (positive, negative) = self.encode("一只猫", "模糊，低质量")

        self.assertEqual(len(clip.encode_calls), 2)
        self.assertEqual([call["prompt"] for call in clip.tokenize_calls], ["一只猫", "模糊，低质量"])
        self.assertIsNot(positive, negative)
        self.assertEqual(len(vae.latents), 1)
        self.assertIs(positive[0][1]["reference_latents"][0], vae.latents[0])
        self.assertIs(negative[0][1]["reference_latents"][0], vae.latents[0])

    def test_without_vae_reference_images_remain_in_clip_vision_input(self):
        clip, vae, (positive, negative) = self.encode("一只猫", "", with_vae=False)

        self.assertEqual(len(clip.encode_calls), 2)
        self.assertIsNot(positive, negative)
        self.assertIsNone(vae)
        self.assertEqual([len(call["images"]) for call in clip.tokenize_calls], [1, 1])
        self.assertIs(clip.tokenize_calls[0]["images"], clip.tokenize_calls[1]["images"])
        self.assertTrue(all(call["keep_vision"] for call in clip.tokenize_calls))

    def test_without_reference_images_still_encodes_both_prompts(self):
        clip, vae, (positive, negative) = self.encode("一只猫", "杂乱背景", images=False)

        self.assertEqual(len(clip.encode_calls), 2)
        self.assertEqual([call["prompt"] for call in clip.tokenize_calls], ["一只猫", "杂乱背景"])
        self.assertIsNot(positive, negative)
        self.assertEqual(vae.latents, [])
        self.assertTrue(all(call["images"] == [] for call in clip.tokenize_calls))

    def test_unconnected_clip_has_actionable_chinese_error(self):
        with self.assertRaisesRegex(RuntimeError, "请连接 CLIPLoader"):
            optimizer._encode_qwen_image21(None, None, "正向", "负向", 1024, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
