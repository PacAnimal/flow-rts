#!/usr/bin/env python3
"""
Remove a solid-color background from a sprite image.

The background color is auto-detected from the edge pixels — no hardcoding needed.
Anti-aliased / semi-blended edge pixels are handled with chroma keying:
    P = α·F + (1−α)·B  →  F = (P − (1−α)·B) / α
so a pixel that's 50% pink + 50% foreground becomes 50%-opaque foreground color
with the pink contribution subtracted out.

Usage:
    python scripts/remove_bg.py sprites/command_center.png [out.png]
"""

import sys
from pathlib import Path
import numpy as np
from PIL import Image


def detect_bg_color(arr: np.ndarray, edge_px: int = 4) -> np.ndarray:
    """Return the dominant background color sampled from the image edges."""
    h, w = arr.shape[:2]
    samples = np.concatenate([
        arr[:edge_px,  :,        :3].reshape(-1, 3),
        arr[-edge_px:, :,        :3].reshape(-1, 3),
        arr[:,  :edge_px,        :3].reshape(-1, 3),
        arr[:, -edge_px:,        :3].reshape(-1, 3),
    ])
    alphas = np.concatenate([
        arr[:edge_px,  :,        3].reshape(-1),
        arr[-edge_px:, :,        3].reshape(-1),
        arr[:,  :edge_px,        3].reshape(-1),
        arr[:, -edge_px:,        3].reshape(-1),
    ])
    # accept semi-opaque edge pixels too (handles already-partially-processed images)
    opaque = samples[alphas > 64]
    pool = opaque if len(opaque) >= 8 else samples
    bg = np.median(pool, axis=0)

    # adaptive threshold: generous minimum so anti-aliased edge blends are caught.
    # A pixel needs to be ~80 RGB-distance away from BG before it gets full opacity.
    dists = np.sqrt(np.sum((pool.astype(float) - bg) ** 2, axis=1))
    spread = np.median(dists)
    threshold = max(130.0, spread * 8.0)

    return bg, threshold


def remove_bg(src: str, dst: str) -> None:
    import shutil
    src_path = Path(src)
    orig_path = src_path.with_suffix(".orig" + src_path.suffix)

    if orig_path.exists():
        # always process the untouched original so re-runs are idempotent
        read_from = orig_path
        print(f"Using backup   : {orig_path}")
    else:
        shutil.copy2(src, orig_path)
        read_from = src_path
        print(f"Backup created : {orig_path}")

    img = Image.open(read_from).convert("RGBA")
    arr = np.array(img, dtype=float)

    bg, threshold = detect_bg_color(arr.astype(np.uint8))
    print(f"Background color : RGB({bg[0]:.0f}, {bg[1]:.0f}, {bg[2]:.0f})")
    print(f"Keying threshold : {threshold:.1f}")

    rgb = arr[:, :, :3]
    src_alpha = arr[:, :, 3] / 255.0        # existing alpha (usually 1 for JPG-sourced PNGs)

    # per-pixel distance from background in RGB space
    dist = np.sqrt(np.sum((rgb - bg) ** 2, axis=2))

    # fg_alpha: 0 = pure background, 1 = pure foreground
    fg_alpha = np.clip(dist / threshold, 0.0, 1.0)

    # chroma-key decontamination: recover F from P = α·F + (1−α)·B.
    # Only applied in the alpha ramp zone (dist < threshold).
    # Pixels beyond threshold are pure foreground — keep their RGB unchanged.
    a3   = fg_alpha[:, :, np.newaxis]
    bg3  = bg[np.newaxis, np.newaxis, :]
    safe = np.where(a3 > 1e-6, a3, 1.0)
    decontaminated = (rgb - (1.0 - a3) * bg3) / safe
    decontaminated = np.clip(decontaminated, 0.0, 255.0)

    out_rgb = np.where(a3 >= 1.0, rgb, decontaminated)

    # combine keyed alpha with any pre-existing source alpha
    out_alpha = fg_alpha * src_alpha * 255.0

    result = np.zeros_like(arr)
    result[:, :, :3] = out_rgb
    result[:, :, 3]  = out_alpha
    result = np.clip(result, 0, 255).astype(np.uint8)

    Image.fromarray(result, "RGBA").save(dst)
    print(f"Saved: {dst}")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "sprites/command_center.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else src  # overwrite by default
    remove_bg(src, dst)
