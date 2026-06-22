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
    rgb = arr[:, :, :3].astype(float)

    # background color from top-left pixel
    bg = rgb[0, 0].copy()
    print(f"Background color : RGB({bg[0]:.0f}, {bg[1]:.0f}, {bg[2]:.0f})")

    dist = np.sqrt(np.sum((rgb - bg) ** 2, axis=2))

    # trimap thresholds — high is calibrated to the BG-to-neutral distance so the
    # unknown zone covers all genuine edge anti-alias pixels (typically dist 20–200
    # for a vivid chroma background like magenta)
    neutral_grey   = np.array([128.0, 128.0, 128.0])
    bg_to_neutral  = float(np.sqrt(np.sum((bg - neutral_grey) ** 2)))
    low  = 20.0
    high = max(200.0, bg_to_neutral * 0.90)
    print(f"Trimap thresholds: low={low:.1f}  high={high:.1f}")

    # 0=BG  0.5=unknown  1=FG
    trimap = np.where(dist < low, 0.0, np.where(dist > high, 1.0, 0.5))

    image_f   = np.clip(rgb / 255.0, 0.0, 1.0)
    alpha_mat = estimate_alpha_cf(image_f, trimap)

    # recover foreground colour using pymatting's unmodified alpha so the
    # colour estimate isn't skewed by any post-processing we apply to alpha
    fg_color = estimate_foreground_ml(image_f, alpha_mat)

    # suppress alpha for pixels that are colour-close to background — this
    # catches interior holes that matting smoothness pulls to high alpha
    bg_suppress = np.clip((dist - low) / (high - low), 0.0, 1.0)
    alpha = np.minimum(alpha_mat, bg_suppress)

    # chroma despill: any pixel within `high` distance of background may carry
    # background hue in the recovered foreground colour. find channels that are
    # "hot" in the background (above neutral 128) and clamp them to the value of
    # the "clean" (low) channels. keyed off colour distance, not alpha, so it
    # fires even for fully-opaque edge pixels that sit just outside the trimap
    # unknown zone.
    key_chs   = [i for i, v in enumerate(bg) if v > 128.0]
    clean_chs = [i for i in range(3) if i not in key_chs]
    if key_chs and clean_chs:
        clean_ref  = np.max(np.stack([fg_color[:, :, i] for i in clean_chs], axis=2), axis=2)

        # primary zone: pixels colour-close to background
        near_bg = dist < high
        # secondary zone: pixels whose recovered foreground still carries the
        # background hue signature — dark purple has large dist from bright magenta
        # but still has R≈B>>G, so we catch it here regardless of dist
        hue_spill = np.ones(dist.shape, dtype=bool)
        for kc in key_chs:
            hue_spill &= (fg_color[:, :, kc] - clean_ref > 0.05)
        apply_despill = near_bg | hue_spill

        fg_out = fg_color.copy()
        for ch in key_chs:
            fg_out[:, :, ch] = np.where(apply_despill,
                                        np.minimum(fg_color[:, :, ch], clean_ref),
                                        fg_color[:, :, ch])
        fg_color = fg_out

    result = np.empty((*arr.shape[:2], 4), dtype=np.uint8)
    result[:, :, :3] = np.clip(fg_color * 255.0, 0, 255).astype(np.uint8)
    result[:, :,  3] = np.clip(alpha    * 255.0, 0, 255).astype(np.uint8)

    Image.fromarray(result, "RGBA").save(dst)
    print(f"Saved: {dst}")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "sprites/command_center.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    remove_bg(src, dst)
