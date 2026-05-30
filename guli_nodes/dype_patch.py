import math
import types

import torch
import torch.nn as nn
from comfy import model_sampling
from comfy.model_patcher import ModelPatcher

# Adapted for GuliNodes from the local ComfyUI-DyPE implementation (Apache-2.0).


def _find_correction_factor(num_rotations, dim, base, max_position_embeddings):
    return (dim * math.log(max_position_embeddings / (num_rotations * 2 * math.pi))) / (
        2 * math.log(base)
    )


def _find_correction_range(low_ratio, high_ratio, dim, base, ori_max_pe_len):
    low = math.floor(_find_correction_factor(low_ratio, dim, base, ori_max_pe_len))
    high = math.ceil(_find_correction_factor(high_ratio, dim, base, ori_max_pe_len))
    return max(low, 0), min(high, dim - 1)


def _linear_ramp_mask(min_val, max_val, dim, device, dtype):
    if min_val == max_val:
        max_val += 0.001
    linear_func = (torch.arange(dim, dtype=torch.float32, device=device) - min_val) / (
        max_val - min_val
    )
    return torch.clamp(linear_func, 0, 1).to(dtype)


def _find_newbase_ntk(dim, base, scale):
    return base * (scale ** (dim / (dim - 2)))


def _get_1d_dype_yarn_pos_embed(
    dim: int,
    pos: torch.Tensor,
    theta: float,
    freqs_dtype: torch.dtype,
    linear_scale: float,
    ntk_scale: float,
    ori_max_pe_len: int,
    dype: bool,
    current_timestep: float,
    dype_scale: float,
    dype_exponent: float,
    override_mscale: float | None = None,
):
    device = pos.device
    linear_scale = max(linear_scale, 1.0)
    ntk_scale = max(ntk_scale, 1.0)

    beta_0, beta_1 = 1.25, 0.75
    gamma_0, gamma_1 = 16, 2

    if dype:
        k_t = dype_scale * (current_timestep**dype_exponent)
        beta_0 = beta_0**k_t
        beta_1 = beta_1**k_t
        gamma_0 = gamma_0**k_t
        gamma_1 = gamma_1**k_t

    half_dim = dim // 2
    index = torch.arange(0, dim, 2, dtype=freqs_dtype, device=device) / dim
    freqs_base = 1.0 / (theta**index)
    freqs_linear = freqs_base / linear_scale

    new_base = _find_newbase_ntk(dim, theta, ntk_scale)
    if isinstance(new_base, torch.Tensor) and new_base.dim() > 0:
        new_base = new_base.view(-1, 1)
    freqs_ntk = 1.0 / torch.pow(new_base, index)
    if freqs_ntk.dim() > 1:
        freqs_ntk = freqs_ntk.squeeze()

    low, high = _find_correction_range(beta_0, beta_1, dim, theta, ori_max_pe_len)
    low, high = max(0, low), min(half_dim, high)
    mask_beta = 1 - _linear_ramp_mask(low, high, half_dim, device, freqs_dtype)
    freqs = freqs_linear * (1 - mask_beta) + freqs_ntk * mask_beta

    low, high = _find_correction_range(gamma_0, gamma_1, dim, theta, ori_max_pe_len)
    low, high = max(0, low), min(half_dim, high)
    mask_gamma = 1 - _linear_ramp_mask(low, high, half_dim, device, freqs_dtype)
    freqs = freqs * (1 - mask_gamma) + freqs_base * mask_gamma

    freqs = torch.einsum("...s,d->...sd", pos, freqs)
    freqs_cos = freqs.cos().repeat_interleave(2, dim=-1).float()
    freqs_sin = freqs.sin().repeat_interleave(2, dim=-1).float()

    if override_mscale is not None:
        mscale = torch.tensor(override_mscale, dtype=freqs_dtype, device=device)
    else:
        mscale = torch.tensor(
            1.0 + 0.1 * math.log(ntk_scale) / math.sqrt(ntk_scale),
            dtype=freqs_dtype,
            device=device,
        )
    return freqs_cos * mscale, freqs_sin * mscale


def _get_1d_yarn_pos_embed(
    dim: int,
    pos: torch.Tensor,
    theta: float,
    freqs_dtype: torch.dtype,
    max_pe_len: torch.Tensor,
    ori_max_pe_len: int,
    dype: bool,
    current_timestep: float,
    dype_scale: float,
    dype_exponent: float,
    use_aggressive_mscale: bool = False,
):
    device = pos.device
    scale = torch.clamp_min(max_pe_len / ori_max_pe_len, 1.0)

    beta_0, beta_1 = 1.25, 0.75
    gamma_0, gamma_1 = 16, 2

    index = torch.arange(0, dim, 2, dtype=freqs_dtype, device=device) / dim
    freqs_base = 1.0 / (theta**index)
    freqs_linear = 1.0 / torch.einsum("...,f->...f", scale, theta**index)

    new_base = _find_newbase_ntk(dim, theta, scale)
    if new_base.dim() > 0:
        new_base = new_base.view(-1, 1)
    freqs_ntk = 1.0 / torch.pow(new_base, index)
    if freqs_ntk.dim() > 1:
        freqs_ntk = freqs_ntk.squeeze()

    if dype:
        k_t = dype_scale * (current_timestep**dype_exponent)
        beta_0 = beta_0**k_t
        beta_1 = beta_1**k_t

    half_dim = dim // 2
    low, high = _find_correction_range(beta_0, beta_1, dim, theta, ori_max_pe_len)
    low, high = max(0, low), min(half_dim, high)
    freqs_mask = 1 - _linear_ramp_mask(low, high, half_dim, device, freqs_dtype)
    freqs = freqs_linear * (1 - freqs_mask) + freqs_ntk * freqs_mask

    if dype:
        k_t = dype_scale * (current_timestep**dype_exponent)
        gamma_0 = gamma_0**k_t
        gamma_1 = gamma_1**k_t

    low, high = _find_correction_range(gamma_0, gamma_1, dim, theta, ori_max_pe_len)
    low, high = max(0, low), min(half_dim, high)
    freqs_mask = 1 - _linear_ramp_mask(low, high, half_dim, device, freqs_dtype)
    freqs = freqs * (1 - freqs_mask) + freqs_base * freqs_mask

    freqs = torch.einsum("...s,d->...sd", pos, freqs)
    freqs_cos = freqs.cos().repeat_interleave(2, dim=-1).float()
    freqs_sin = freqs.sin().repeat_interleave(2, dim=-1).float()

    if use_aggressive_mscale:
        mscale = torch.where(scale <= 1, torch.tensor(1.0, device=device), 0.1 * torch.log(scale) + 1.0)
    else:
        mscale = torch.where(
            scale <= 1,
            torch.tensor(1.0, device=device),
            1.0 + 0.1 * torch.log(scale) / torch.sqrt(scale),
        )
    return freqs_cos * mscale.to(freqs_cos), freqs_sin * mscale.to(freqs_sin)


def _get_1d_ntk_pos_embed(
    dim: int,
    pos: torch.Tensor,
    theta: float,
    freqs_dtype: torch.dtype,
    ntk_factor: float,
):
    device = pos.device
    theta_ntk = theta * ntk_factor
    freqs = 1.0 / (
        theta_ntk ** (torch.arange(0, dim, 2, dtype=freqs_dtype, device=device) / dim)
    )
    freqs = torch.einsum("...s,d->...sd", pos, freqs)
    return freqs.cos().repeat_interleave(2, dim=-1).float(), freqs.sin().repeat_interleave(2, dim=-1).float()


class _DyPEBasePosEmbed(nn.Module):
    def __init__(
        self,
        theta: int,
        axes_dim: list[int],
        method: str = "yarn",
        yarn_alt_scaling: bool = False,
        dype: bool = True,
        dype_scale: float = 2.0,
        dype_exponent: float = 2.0,
        base_resolution: int = 1024,
        dype_start_sigma: float = 1.0,
        base_patch_grid: tuple[int, int] | int | None = None,
    ):
        super().__init__()
        self.theta = theta
        self.axes_dim = axes_dim
        self.method = method
        self.yarn_alt_scaling = yarn_alt_scaling
        self.dype = True if method == "vision_yarn" else (dype if method != "base" else False)
        self.dype_scale = dype_scale
        self.dype_exponent = dype_exponent
        self.base_resolution = base_resolution
        self.dype_start_sigma = max(0.001, min(1.0, dype_start_sigma))
        self.current_timestep = 1.0

        if base_patch_grid is None:
            val = (self.base_resolution // 8) // 2
            self.base_patch_grid = (val, val)
        elif isinstance(base_patch_grid, int):
            self.base_patch_grid = (base_patch_grid, base_patch_grid)
        else:
            self.base_patch_grid = base_patch_grid
        self.base_patches = max(self.base_patch_grid)

    def set_timestep(self, timestep: float):
        self.current_timestep = timestep

    @staticmethod
    def _axis_token_span(axis_pos: torch.Tensor) -> float:
        flat = axis_pos.float().reshape(-1)
        if flat.numel() <= 1:
            return 1.0
        span = flat.max() - flat.min()
        if span <= 0:
            return 1.0
        unique_vals = torch.unique(flat)
        if unique_vals.numel() <= 1:
            return 1.0
        step = torch.diff(unique_vals).min().item()
        if step <= 1e-6:
            return float(flat.numel())
        return float((span / step) + 1.0)

    def _get_mscale(self, scale_global):
        mscale_start = 0.1 * math.log(scale_global) + 1.0
        t_norm = 1.0 if self.current_timestep > self.dype_start_sigma else (
            self.current_timestep / self.dype_start_sigma
        )
        return 1.0 + (mscale_start - 1.0) * math.pow(t_norm, self.dype_exponent)

    def _calc_vision_yarn_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        n_axes = pos.shape[-1]
        components = []

        if n_axes >= 3:
            h_span = self._axis_token_span(pos[..., 1])
            w_span = self._axis_token_span(pos[..., 2])
            scale_global = max(1.0, max(h_span / self.base_patch_grid[0], w_span / self.base_patch_grid[1]))
        else:
            scale_global = max(1.0, self._axis_token_span(pos) / self.base_patches)

        current_mscale = self._get_mscale(scale_global)

        for i in range(n_axes):
            axis_pos = pos[..., i]
            axis_dim = self.axes_dim[i]
            if i > 0:
                base_axis_len = (
                    self.base_patch_grid[i - 1]
                    if n_axes >= 3 and i - 1 < len(self.base_patch_grid)
                    else self.base_patches
                )
                scale_local = max(1.0, self._axis_token_span(axis_pos) / base_axis_len)
                if scale_global > 1.0:
                    cos, sin = _get_1d_dype_yarn_pos_embed(
                        axis_dim,
                        axis_pos,
                        self.theta,
                        freqs_dtype,
                        scale_local,
                        scale_global,
                        base_axis_len,
                        self.dype,
                        self.current_timestep,
                        self.dype_scale,
                        self.dype_exponent,
                        current_mscale,
                    )
                else:
                    cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, 1.0)
            else:
                cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, 1.0)
            components.append((cos, sin))
        return components

    def _calc_yarn_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        n_axes = pos.shape[-1]
        components = []
        if n_axes >= 3:
            h_span = self._axis_token_span(pos[..., 1])
            w_span = self._axis_token_span(pos[..., 2])
            max_current_patches = max(h_span, w_span)
        else:
            max_current_patches = self._axis_token_span(pos)

        needs_extrapolation = max_current_patches > self.base_patches
        if needs_extrapolation and self.yarn_alt_scaling:
            for i in range(n_axes):
                axis_pos = pos[..., i]
                axis_dim = self.axes_dim[i]
                current_patches = self._axis_token_span(axis_pos)
                base_axis_len = (
                    self.base_patch_grid[i - 1]
                    if n_axes >= 3 and i > 0 and i - 1 < len(self.base_patch_grid)
                    else self.base_patches
                )
                if i > 0 and current_patches > base_axis_len:
                    max_pe_len = torch.tensor(current_patches, dtype=freqs_dtype, device=pos.device)
                    cos, sin = _get_1d_yarn_pos_embed(
                        axis_dim,
                        axis_pos,
                        self.theta,
                        freqs_dtype,
                        max_pe_len,
                        base_axis_len,
                        self.dype,
                        self.current_timestep,
                        self.dype_scale,
                        self.dype_exponent,
                        True,
                    )
                else:
                    cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, 1.0)
                components.append((cos, sin))
            return components

        cos_full_spatial = sin_full_spatial = None
        if needs_extrapolation:
            spatial_axis_dim = self.axes_dim[1]
            square_pos = torch.arange(0, max_current_patches, device=pos.device).float()
            max_pe_len = torch.tensor(max_current_patches, dtype=freqs_dtype, device=pos.device)
            cos_full_spatial, sin_full_spatial = _get_1d_yarn_pos_embed(
                spatial_axis_dim,
                square_pos,
                self.theta,
                freqs_dtype,
                max_pe_len,
                self.base_patches,
                self.dype,
                self.current_timestep,
                self.dype_scale,
                self.dype_exponent,
                False,
            )

        for i in range(n_axes):
            axis_pos = pos[..., i]
            axis_dim = self.axes_dim[i]
            if i > 0 and needs_extrapolation:
                offset_indices = axis_pos.long() - axis_pos.long().min()
                pos_indices = torch.clamp(offset_indices.reshape(-1), max=cos_full_spatial.shape[0] - 1)
                cos = cos_full_spatial[pos_indices].view(*axis_pos.shape, -1)
                sin = sin_full_spatial[pos_indices].view(*axis_pos.shape, -1)
            else:
                cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, 1.0)
            components.append((cos, sin))
        return components

    def _calc_ntk_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        n_axes = pos.shape[-1]
        components = []
        if n_axes >= 3:
            h_span = self._axis_token_span(pos[..., 1])
            w_span = self._axis_token_span(pos[..., 2])
            scale_global = max(1.0, max(h_span / self.base_patch_grid[0], w_span / self.base_patch_grid[1]))
        else:
            scale_global = max(1.0, self._axis_token_span(pos) / self.base_patches)

        for i in range(n_axes):
            axis_pos = pos[..., i]
            axis_dim = self.axes_dim[i]
            ntk_factor = 1.0
            if i > 0 and scale_global > 1.0:
                base_ntk = scale_global ** (axis_dim / (axis_dim - 2))
                if self.dype:
                    k_t = self.dype_scale * (self.current_timestep**self.dype_exponent)
                    ntk_factor = base_ntk**k_t
                else:
                    ntk_factor = base_ntk
                ntk_factor = max(1.0, ntk_factor)
            cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, ntk_factor)
            components.append((cos, sin))
        return components

    def get_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        if self.method == "vision_yarn":
            return self._calc_vision_yarn_components(pos, freqs_dtype)
        if self.method == "yarn":
            return self._calc_yarn_components(pos, freqs_dtype)
        return self._calc_ntk_components(pos, freqs_dtype)


class _PosEmbedFlux(_DyPEBasePosEmbed):
    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        pos = ids.float()
        freqs_dtype = torch.bfloat16 if pos.device.type == "cuda" else torch.float32
        emb_parts = []
        for cos, sin in self.get_components(pos, freqs_dtype):
            cos_reshaped = cos.view(*cos.shape[:-1], -1, 2)[..., :1]
            sin_reshaped = sin.view(*sin.shape[:-1], -1, 2)[..., :1]
            row1 = torch.cat([cos_reshaped, -sin_reshaped], dim=-1)
            row2 = torch.cat([sin_reshaped, cos_reshaped], dim=-1)
            emb_parts.append(torch.stack([row1, row2], dim=-2))
        return torch.cat(emb_parts, dim=-3).unsqueeze(1).to(ids.device)


class _PosEmbedQwen(_DyPEBasePosEmbed):
    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        pos = ids.float()
        freqs_dtype = torch.bfloat16 if pos.device.type == "cuda" else torch.float32
        emb_parts = []
        for cos, sin in self.get_components(pos, freqs_dtype):
            cos_half = cos[..., ::2]
            sin_half = sin[..., ::2]
            col0 = torch.stack([cos_half, sin_half], dim=-1)
            col1 = torch.stack([-sin_half, cos_half], dim=-1)
            emb_parts.append(torch.stack([col0, col1], dim=-1))
        return torch.cat(emb_parts, dim=-3).unsqueeze(1).to(ids.device)


class _PosEmbedZImage(_DyPEBasePosEmbed):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.external_scale_hint = 1.0

    def set_scale_hint(self, scale: float):
        self.external_scale_hint = max(1.0, scale)

    def _blend_to_full_scale(self) -> float:
        t_norm = 1.0 if self.current_timestep > self.dype_start_sigma else (
            self.current_timestep / self.dype_start_sigma
        )
        return 1.0 - math.pow(t_norm, self.dype_exponent)

    def _resize_rope_grid(self, pos: torch.Tensor) -> torch.Tensor:
        if not self.dype:
            return pos
        image_mask = (pos[..., 1] != 0) | (pos[..., 2] != 0)
        if not image_mask.any():
            return pos
        blend_val = self._blend_to_full_scale()
        if blend_val <= 0.001:
            return pos

        pos_rescaled = pos.clone()
        blend = torch.tensor(blend_val, device=pos.device, dtype=pos.dtype)
        for axis in (1, 2):
            coords = pos[..., axis]
            coords_image = coords[image_mask]
            if coords_image.numel() <= 1:
                continue
            unique_sorted, _ = torch.sort(torch.unique(coords_image))
            deltas = torch.diff(unique_sorted)
            if deltas.numel() == 0:
                continue
            step = torch.median(deltas)
            if torch.isclose(step, torch.tensor(1.0, device=pos.device, dtype=pos.dtype), atol=1e-3):
                continue
            if torch.isclose(step, torch.tensor(0.0, device=pos.device, dtype=pos.dtype)):
                continue
            start = coords_image.min()
            full_scale_coords = (coords - start) / step + start
            pos_rescaled[..., axis] = coords + (full_scale_coords - coords) * blend
        return pos_rescaled

    def _calc_zimage_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        n_axes = pos.shape[-1]
        components = []
        scale_global = self.external_scale_hint
        if scale_global > 1.0 and self.dype:
            mscale_start = 0.05 * math.log(scale_global) + 1.0
            t_norm = 1.0 if self.current_timestep > self.dype_start_sigma else (
                self.current_timestep / self.dype_start_sigma
            )
            current_mscale = 1.0 + (mscale_start - 1.0) * math.pow(t_norm, self.dype_exponent)
        else:
            current_mscale = 1.0

        for i in range(n_axes):
            axis_pos = pos[..., i]
            axis_dim = self.axes_dim[i]
            if i > 0 and scale_global > 1.0:
                grid_idx = i - 1
                base_axis_len = (
                    self.base_patch_grid[grid_idx] if grid_idx < len(self.base_patch_grid) else self.base_patches
                )
                if self.method == "vision_yarn":
                    cos, sin = _get_1d_dype_yarn_pos_embed(
                        axis_dim,
                        axis_pos,
                        self.theta,
                        freqs_dtype,
                        scale_global,
                        scale_global,
                        base_axis_len,
                        self.dype,
                        self.current_timestep,
                        self.dype_scale,
                        self.dype_exponent,
                        current_mscale,
                    )
                elif self.method == "yarn":
                    max_pe_len = torch.tensor(int(base_axis_len * scale_global), dtype=freqs_dtype, device=pos.device)
                    cos, sin = _get_1d_yarn_pos_embed(
                        axis_dim,
                        axis_pos,
                        self.theta,
                        freqs_dtype,
                        max_pe_len,
                        base_axis_len,
                        self.dype,
                        self.current_timestep,
                        self.dype_scale,
                        self.dype_exponent,
                        False,
                    )
                    if self.dype:
                        mscale_tensor = torch.tensor(current_mscale, dtype=cos.dtype, device=cos.device)
                        cos = cos * mscale_tensor
                        sin = sin * mscale_tensor
                else:
                    base_ntk = scale_global ** (axis_dim / (axis_dim - 2))
                    if self.dype:
                        k_t = self.dype_scale * (self.current_timestep**self.dype_exponent)
                        ntk_factor = base_ntk**k_t
                    else:
                        ntk_factor = base_ntk
                    cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, max(1.0, ntk_factor))
            else:
                cos, sin = _get_1d_ntk_pos_embed(axis_dim, axis_pos, self.theta, freqs_dtype, 1.0)
            components.append((cos, sin))
        return components

    def get_components(self, pos: torch.Tensor, freqs_dtype: torch.dtype):
        return self._calc_zimage_components(pos, freqs_dtype)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        pos = self._resize_rope_grid(ids.float())
        freqs_dtype = torch.bfloat16 if pos.device.type == "cuda" else torch.float32
        emb_parts = []
        for cos, sin in self.get_components(pos, freqs_dtype):
            cos_reshaped = cos.view(*cos.shape[:-1], -1, 2)[..., :1]
            sin_reshaped = sin.view(*sin.shape[:-1], -1, 2)[..., :1]
            row1 = torch.cat([cos_reshaped, -sin_reshaped], dim=-1)
            row2 = torch.cat([sin_reshaped, cos_reshaped], dim=-1)
            emb_parts.append(torch.stack([row1, row2], dim=-2))
        return torch.cat(emb_parts, dim=-3).unsqueeze(1).to(ids.device)


def _detect_model_type(model: ModelPatcher, requested: str):
    requested = (requested or "auto").lower()
    if requested == "qwen":
        return False, True, False
    if requested in {"zimage", "z_image"}:
        return False, False, True
    if requested == "flux":
        return False, False, False

    if not hasattr(model.model, "diffusion_model"):
        raise ValueError("提供的模型不是兼容的 FLUX / Qwen / Z-Image 结构。")

    diffusion_model = model.model.diffusion_model
    model_class_name = diffusion_model.__class__.__name__
    if "QwenImage" in model_class_name:
        return False, True, False
    if hasattr(diffusion_model, "rope_embedder"):
        return False, False, True
    return False, False, False


def apply_dype_to_model(
    model: ModelPatcher,
    model_type: str,
    width: int,
    height: int,
    method: str,
    yarn_alt_scaling: bool,
    enable_dype: bool,
    dype_scale: float,
    dype_exponent: float,
    base_shift: float,
    max_shift: float,
    base_resolution: int = 1024,
    dype_start_sigma: float = 1.0,
) -> ModelPatcher:
    patched = model.clone()
    is_qwen, is_z_image = _detect_model_type(patched, model_type)

    new_dype_params = (
        width,
        height,
        base_shift,
        max_shift,
        method,
        yarn_alt_scaling,
        base_resolution,
        dype_start_sigma,
        is_qwen,
        is_z_image,
    )
    should_patch_schedule = getattr(patched.model, "_gg_dype_params", None) != new_dype_params

    base_patch_h_tokens = base_patch_w_tokens = None
    if is_z_image:
        axes_lens = getattr(patched.model.diffusion_model, "axes_lens", None)
        if isinstance(axes_lens, (list, tuple)) and len(axes_lens) >= 3:
            base_patch_h_tokens = int(axes_lens[1])
            base_patch_w_tokens = int(axes_lens[2])

    patch_size = 2
    try:
        patch_size = patched.model.diffusion_model.patch_size
    except Exception:
        pass

    if base_patch_h_tokens is not None and base_patch_w_tokens is not None:
        derived_base_patches = max(base_patch_h_tokens, base_patch_w_tokens)
        derived_base_seq_len = base_patch_h_tokens * base_patch_w_tokens
    else:
        derived_base_patches = (base_resolution // 8) // 2
        derived_base_seq_len = derived_base_patches * derived_base_patches

    if enable_dype and should_patch_schedule:
        try:
            if isinstance(patched.model.model_sampling, model_sampling.ModelSamplingFlux) or is_qwen or is_z_image:
                latent_h, latent_w = height // 8, width // 8
                padded_h = math.ceil(latent_h / patch_size) * patch_size
                padded_w = math.ceil(latent_w / patch_size) * patch_size
                image_seq_len = (padded_h // patch_size) * (padded_w // patch_size)

                if image_seq_len <= derived_base_seq_len:
                    dype_shift = base_shift
                else:
                    slope = (max_shift - base_shift) / (image_seq_len - derived_base_seq_len)
                    intercept = base_shift - slope * derived_base_seq_len
                    dype_shift = image_seq_len * slope + intercept
                dype_shift = max(0.0, dype_shift)

                class _DypeModelSamplingFlux(model_sampling.ModelSamplingFlux, model_sampling.CONST):
                    pass

                new_model_sampler = _DypeModelSamplingFlux(patched.model.model_config)
                new_model_sampler.set_parameters(shift=dype_shift)
                patched.add_object_patch("model_sampling", new_model_sampler)
                patched.model._gg_dype_params = new_dype_params
        except Exception:
            pass
    elif not enable_dype and hasattr(patched.model, "_gg_dype_params"):
        class _DefaultModelSamplingFlux(model_sampling.ModelSamplingFlux, model_sampling.CONST):
            pass

        default_sampler = _DefaultModelSamplingFlux(patched.model.model_config)
        patched.add_object_patch("model_sampling", default_sampler)
        del patched.model._gg_dype_params

    try:
        if is_z_image:
            orig_embedder = patched.model.diffusion_model.rope_embedder
            target_patch_path = "diffusion_model.rope_embedder"
        else:
            orig_embedder = patched.model.diffusion_model.pe_embedder
            target_patch_path = "diffusion_model.pe_embedder"
        theta, axes_dim = orig_embedder.theta, orig_embedder.axes_dim
    except AttributeError as exc:
        raise ValueError("提供的模型不是兼容的 FLUX / Qwen / Z-Image 结构。") from exc

    embedder_cls = _PosEmbedFlux
    if is_qwen:
        embedder_cls = _PosEmbedQwen
    elif is_z_image:
        embedder_cls = _PosEmbedZImage

    new_pe_embedder = embedder_cls(
        theta,
        axes_dim,
        method,
        yarn_alt_scaling,
        enable_dype,
        dype_scale,
        dype_exponent,
        base_resolution,
        dype_start_sigma,
        derived_base_patches if is_z_image else None,
    )
    patched.add_object_patch(target_patch_path, new_pe_embedder)

    if is_z_image:
        _patch_zimage_embed_flow(
            patched,
            new_pe_embedder,
            height,
            width,
            base_resolution,
            patch_size,
            base_patch_h_tokens,
            base_patch_w_tokens,
            derived_base_patches,
        )

    try:
        sigma_max = patched.model.model_sampling.sigma_max.item()
    except Exception:
        sigma_max = 1.0

    def dype_wrapper_function(model_function, args_dict):
        timestep_tensor = args_dict.get("timestep")
        if timestep_tensor is not None and timestep_tensor.numel() > 0 and sigma_max > 0:
            current_sigma = timestep_tensor.flatten()[0].item()
            normalized_timestep = min(max(current_sigma / sigma_max, 0.0), 1.0)
            new_pe_embedder.set_timestep(normalized_timestep)

        input_x = args_dict.get("input")
        cond = args_dict.get("c", {})
        if is_z_image and isinstance(input_x, torch.Tensor) and input_x.dim() >= 4:
            cond = dict(cond)
            transformer_options = dict(cond.get("transformer_options", {}))
            transformer_options["dype_original_hw"] = (input_x.shape[-2], input_x.shape[-1])
            transformer_options["dype_requested_hw"] = (height, width)
            transformer_options["dype_base_resolution"] = base_resolution
            cond["transformer_options"] = transformer_options
        return model_function(input_x, args_dict.get("timestep"), **cond)

    patched.set_model_unet_function_wrapper(dype_wrapper_function)
    return patched


def _patch_zimage_embed_flow(
    patched,
    new_pe_embedder,
    height,
    width,
    base_resolution,
    patch_size,
    base_patch_h_tokens,
    base_patch_w_tokens,
    derived_base_patches,
):
    if base_patch_h_tokens is not None and base_patch_w_tokens is not None:
        patched.model.diffusion_model._dype_base_hw = (base_patch_h_tokens, base_patch_w_tokens)
    elif derived_base_patches is not None:
        patched.model.diffusion_model._dype_base_hw = (derived_base_patches, derived_base_patches)

    def dype_patchify_and_embed(self, x, cap_feats, cap_mask, t, num_tokens, transformer_options={}):
        bsz = len(x)
        p_h = p_w = self.patch_size
        device = x[0].device

        if self.pad_tokens_multiple is not None:
            pad_extra = (-cap_feats.shape[1]) % self.pad_tokens_multiple
            if pad_extra:
                cap_pad = self.cap_pad_token.to(device=cap_feats.device, dtype=cap_feats.dtype, copy=True).unsqueeze(0)
                cap_feats = torch.cat((cap_feats, cap_pad.repeat(cap_feats.shape[0], pad_extra, 1)), dim=1)

        cap_pos_ids = torch.zeros(bsz, cap_feats.shape[1], 3, dtype=torch.float32, device=device)
        cap_pos_ids[:, :, 0] = torch.arange(cap_feats.shape[1], dtype=torch.float32, device=device) + 1.0

        batch, channels, latent_h, latent_w = x.shape
        x = self.x_embedder(
            x.view(batch, channels, latent_h // p_h, p_h, latent_w // p_w, p_w)
            .permute(0, 2, 4, 3, 5, 1)
            .flatten(3)
            .flatten(1, 2)
        )

        requested_hw = transformer_options.get("dype_requested_hw", (height, width))
        rope_base_resolution = transformer_options.get("dype_base_resolution", base_resolution)
        raw_scale_y = float(rope_base_resolution) / max(1.0, float(requested_hw[0]))
        raw_scale_x = float(rope_base_resolution) / max(1.0, float(requested_hw[1]))
        iso_scale = min(raw_scale_y, raw_scale_x)
        new_pe_embedder.set_scale_hint(1.0 / iso_scale)

        original_hw = transformer_options.get("dype_original_hw") or (latent_h, latent_w)
        h_tokens = math.ceil(original_hw[0] / p_h)
        w_tokens = math.ceil(original_hw[1] / p_w)
        token_stride_y = (original_hw[0] / max(1, h_tokens)) * iso_scale
        token_stride_x = (original_hw[1] / max(1, w_tokens)) * iso_scale

        def _build_spatial_pos_ids(batch_size, total_len, width_tokens, cap_len, stride_y, stride_x):
            base_pos = torch.arange(total_len, device=device, dtype=torch.float32)
            y = torch.div(base_pos, width_tokens, rounding_mode="floor") * stride_y
            x_pos = torch.remainder(base_pos, width_tokens) * stride_x
            pos = torch.stack([torch.full_like(base_pos, cap_len + 1), y, x_pos], dim=-1)
            return pos.unsqueeze(0).repeat(batch_size, 1, 1)

        base_img_tokens = h_tokens * w_tokens
        x_pos_ids = _build_spatial_pos_ids(
            bsz,
            base_img_tokens,
            w_tokens,
            cap_feats.shape[1],
            token_stride_y,
            token_stride_x,
        )

        if self.pad_tokens_multiple is not None:
            pad_extra = (-x.shape[1]) % self.pad_tokens_multiple
            if pad_extra:
                x = torch.cat(
                    (x, self.x_pad_token.to(device=x.device, dtype=x.dtype, copy=True).unsqueeze(0).repeat(x.shape[0], pad_extra, 1)),
                    dim=1,
                )

        if x.shape[1] != x_pos_ids.shape[1]:
            x_pos_ids = _build_spatial_pos_ids(
                bsz,
                x.shape[1],
                w_tokens,
                cap_feats.shape[1],
                token_stride_y,
                token_stride_x,
            )

        freqs_cis = self.rope_embedder(torch.cat((cap_pos_ids, x_pos_ids), dim=1)).movedim(1, 2)

        for layer in self.context_refiner:
            cap_feats = layer(cap_feats, cap_mask, freqs_cis[:, : cap_pos_ids.shape[1]], transformer_options=transformer_options)

        padded_img_mask = None
        for layer in self.noise_refiner:
            x = layer(x, padded_img_mask, freqs_cis[:, cap_pos_ids.shape[1] :], t, transformer_options=transformer_options)

        padded_full_embed = torch.cat((cap_feats, x), dim=1)
        img_sizes = [(latent_h, latent_w)] * bsz
        effective_cap_len = [cap_feats.shape[1]] * bsz
        return padded_full_embed, None, img_sizes, effective_cap_len, freqs_cis

    patched.add_object_patch(
        "diffusion_model.patchify_and_embed",
        types.MethodType(dype_patchify_and_embed, patched.model.diffusion_model),
    )
