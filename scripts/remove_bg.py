#!/usr/bin/env python3
"""
Remove a solid-color background from a sprite image using alpha matting.

Background color is read from the top-left pixel of the image.
A trimap is generated automatically (definite BG / unknown boundary / definite FG),
then PyMatting's closed-form algorithm computes a clean per-pixel alpha with
color decontamination — no manual tuning needed.

Usage:
    python scripts/remove_bg.py sprites/command_center.png [out.png]
"""

import sys
import shutil
from pathlib import Path
import numpy as np
from PIL import Image
from pymatting import estimate_alpha_cf, estimate_foreground_ml


def process_rgba(arr: np.ndarray) -> np.ndarray:
    """
    Apply chroma key + alpha matting + despill to an RGBA numpy array.
    Background colour is read from the top-left pixel.
    Returns a processed RGBA uint8 array of the same shape.
    """
    rgb = arr[:, :, :3].astype(float)

    bg = rgb[0, 0].copy()

    dist = np.sqrt(np.sum((rgb - bg) ** 2, axis=2))

    neutral_grey  = np.array([128.0, 128.0, 128.0])
    bg_to_neutral = float(np.sqrt(np.sum((bg - neutral_grey) ** 2)))
    low  = 20.0
    high = max(200.0, bg_to_neutral * 0.90)

    trimap = np.where(dist < low, 0.0, np.where(dist > high, 1.0, 0.5))

    # if the entire image is background (no FG pixels), return fully transparent
    if (trimap >= 0.9).sum() == 0:
        result = np.zeros((*arr.shape[:2], 4), dtype=np.uint8)
        return result

    image_f   = np.clip(rgb / 255.0, 0.0, 1.0)
    alpha_mat = estimate_alpha_cf(image_f, trimap)
    fg_color  = estimate_foreground_ml(image_f, alpha_mat)

    bg_suppress = np.clip((dist - low) / (high - low), 0.0, 1.0)
    alpha = np.minimum(alpha_mat, bg_suppress)

    key_chs   = [i for i, v in enumerate(bg) if v > 128.0]
    clean_chs = [i for i in range(3) if i not in key_chs]
    if key_chs and clean_chs:
        clean_ref  = np.max(np.stack([fg_color[:, :, i] for i in clean_chs], axis=2), axis=2)
        hue_spill  = np.ones(dist.shape, dtype=bool)
        for kc in key_chs:
            hue_spill &= (fg_color[:, :, kc] - clean_ref > 0.05)
        apply_despill = (dist < high) | hue_spill
        fg_out = fg_color.copy()
        for ch in key_chs:
            fg_out[:, :, ch] = np.where(apply_despill,
                                        np.minimum(fg_color[:, :, ch], clean_ref),
                                        fg_color[:, :, ch])
        fg_color = fg_out

    result = np.empty((*arr.shape[:2], 4), dtype=np.uint8)
    result[:, :, :3] = np.clip(fg_color * 255.0, 0, 255).astype(np.uint8)
    result[:, :,  3] = np.clip(alpha    * 255.0, 0, 255).astype(np.uint8)
    return result


def remove_bg(src: str, dst: str) -> None:
    src_path = Path(src)
    orig_path = src_path.with_suffix(".orig" + src_path.suffix)

    if orig_path.exists():
        read_from = orig_path
        print(f"Using backup   : {orig_path}")
    else:
        shutil.copy2(src, orig_path)
        read_from = src_path
        print(f"Backup created : {orig_path}")

    img = Image.open(read_from).convert("RGBA")
    arr = np.array(img)

    bg = arr[0, 0, :3].astype(float)
    print(f"Background color : RGB({bg[0]:.0f}, {bg[1]:.0f}, {bg[2]:.0f})")

    result = process_rgba(arr)
    Image.fromarray(result, "RGBA").save(dst)
    print(f"Saved: {dst}")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "sprites/command_center.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    remove_bg(src, dst)
