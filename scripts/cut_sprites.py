#!/usr/bin/env python3
"""
Cut a sprite sheet into individual sprites by detecting connected non-transparent regions.

Runs background removal (chroma key + alpha matting) on the source image first,
so solid-colour backgrounds are stripped before the cut rather than ending up
inside individual sprite PNGs.

Each output PNG is a transparent canvas with ONLY the pixels belonging to that sprite —
neighbouring sprites that fall inside the bounding box are zeroed out, so irregular /
diagonal shapes never bleed into each other.

A dilation pass (up to merge_frac of image size) bridges small gaps before grouping,
so disconnected parts of the same sprite (e.g. a detached shadow) are kept together.

Usage:
    python scripts/cut_sprites.py sprites/obstacles.png [sprites/obstacles/]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

# allow importing remove_bg from the same scripts/ directory
sys.path.insert(0, str(Path(__file__).parent))
from remove_bg import process_rgba


def cut_sprites(
    input_path: str,
    output_dir: str,
    alpha_threshold: int = 16,
    min_area_frac: float = 0.0005,  # ignore specks < 0.05% of image area
    merge_frac: float = 0.025,       # bridge gaps up to 2.5% of image size
    padding: int = 2,
):
    img = Image.open(input_path).convert("RGBA")
    raw = np.array(img)

    # skip background removal if the image already carries meaningful transparency
    # (e.g. a sheet that was pre-cut or exported with transparency)
    transparent_frac = (raw[:, :, 3] < 16).mean()
    if transparent_frac < 0.05:
        print(f"Removing background from {input_path} …")
        arr = process_rgba(raw)
        print(f"  Background removed.")
    else:
        print(f"  Image already has transparency ({transparent_frac:.1%}) — skipping BG removal.")
        arr = raw

    print(f"Cutting sprites …")

    h, w = arr.shape[:2]
    mask = arr[:, :, 3] > alpha_threshold

    # dilation radius: merge_frac is the total gap to bridge; each side contributes half
    radius = max(1, int(min(h, w) * merge_frac / 2))
    struct = ndimage.generate_binary_structure(2, 1)
    dilated = ndimage.binary_dilation(mask, structure=struct, iterations=radius)

    # 8-connected labeling on dilated mask
    labeled, num = ndimage.label(dilated, structure=np.ones((3, 3)))
    print(f"  {num} raw components (dilation radius={radius}px)")

    min_area = int(h * w * min_area_frac)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(input_path).stem

    saved = 0
    for i in range(1, num + 1):
        comp = labeled == i

        # filter by real (undilated) pixel count to drop noise
        real_area = int((comp & mask).sum())
        if real_area < min_area:
            continue

        # bounding box of the dilated component, plus padding
        rows = np.where(np.any(comp, axis=1))[0]
        cols = np.where(np.any(comp, axis=0))[0]
        r0 = max(0, int(rows[0])  - padding)
        r1 = min(h - 1, int(rows[-1]) + padding)
        c0 = max(0, int(cols[0])  - padding)
        c1 = min(w - 1, int(cols[-1]) + padding)

        # copy the crop, then zero-alpha every pixel NOT in this component
        crop_arr = arr[r0:r1 + 1, c0:c1 + 1].copy()
        comp_crop = comp[r0:r1 + 1, c0:c1 + 1]
        crop_arr[~comp_crop, 3] = 0

        out_path = out / f"{stem}_{saved + 1:02d}.png"
        Image.fromarray(crop_arr, "RGBA").save(out_path)
        print(f"  [{saved + 1:02d}] {out_path.name}  {c1-c0+1}x{r1-r0+1}px  area={real_area}px")
        saved += 1

    print(f"\nSaved {saved} sprites → {out}/")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "sprites/obstacles.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else f"sprites/{Path(src).stem}"
    cut_sprites(src, dst)
