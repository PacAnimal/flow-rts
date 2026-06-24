"""
Assembles the terrain tileset PNG from AI-generated source images.
Produces: public/sprites/terrain/tileset.png
Format: 22 tiles x (TILE+2) wide, (TILE+2) tall, with 1px extrude border per tile.
Same layout as MapScene._makeTileset() but from real art.
"""
import os
import sys
from PIL import Image, ImageDraw

TILE    = 64
EXTRUDE = 1
SLOT    = TILE + 2 * EXTRUDE   # 66
TOTAL   = 22

T_GRASS_A   = 0
T_GRASS_B   = 1
T_GRASS_C   = 2
T_HILL_BASE = 3   # 3..18 (mask 0..15)
T_SHADOW    = 19
T_RAMP      = 20
T_RAMP_GND  = 21

# south cliff face occupies this many px at bottom of tile
CLIFF_S_H = int(TILE * 0.45)   # 28px
# east/west cliff strip width
CLIFF_E_W = int(TILE * 0.34)   # 22px
# north edge dark band height
NORTH_H   = 5

SRC_DIR = '/tmp'

def load(name):
    img = Image.open(f'{SRC_DIR}/terrain_{name}.png').convert('RGBA')
    return img.resize((TILE, TILE), Image.LANCZOS)

print('Loading source tiles...')
hill_top    = load('hill_top')
cliff_south = load('cliff_south')
east_ridge  = load('east_ridge')
shadow      = load('shadow')
ramp        = load('ramp')
ramp_ground = load('ramp_ground')

# west ridge = horizontal mirror of east
west_ridge = east_ridge.transpose(Image.FLIP_LEFT_RIGHT)

def make_hill_variant(mask):
    # base: use cliff_south when S is exposed (avoids seam), hill_top otherwise
    base = cliff_south.copy() if (mask & 2) else hill_top.copy()

    # east cliff strip
    if mask & 4:
        strip = east_ridge.crop((TILE - CLIFF_E_W, 0, TILE, TILE))
        base.paste(strip, (TILE - CLIFF_E_W, 0))

    # west cliff strip
    if mask & 8:
        strip = west_ridge.crop((0, 0, CLIFF_E_W, TILE))
        base.paste(strip, (0, 0))

    # north edge: thin dark overlay at top
    if mask & 1:
        overlay = Image.new('RGBA', (TILE, NORTH_H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        for y in range(NORTH_H):
            a = int(200 * (1.0 - y / NORTH_H))
            draw.rectangle([(0, y), (TILE - 1, y)], fill=(8, 5, 3, a))
        base.paste(Image.new('RGBA', (TILE, NORTH_H), (0, 0, 0, 0)), (0, 0), overlay)
        base.alpha_composite(overlay, (0, 0))

    return base

def extrude(img):
    """Return SLOT x SLOT image with 1px stretched border + crisp TILE interior."""
    out = img.resize((SLOT, SLOT), Image.LANCZOS)
    out.paste(img, (EXTRUDE, EXTRUDE))
    return out

# Build the strip
strip = Image.new('RGBA', (SLOT * TOTAL, SLOT), (0, 0, 0, 0))

def place(tile_img, idx):
    strip.paste(extrude(tile_img), (idx * SLOT, 0))

print('Compositing hill autotile variants...')
for mask in range(16):
    place(make_hill_variant(mask), T_HILL_BASE + mask)

print('Adding special tiles...')
place(shadow,      T_SHADOW)
place(ramp,        T_RAMP)
place(ramp_ground, T_RAMP_GND)

# grass tiles 0-2 stay fully transparent (WebGL ground shader shows through)

out_path = '/Users/oyvhvi/Code/flow-rts/public/sprites/terrain/tileset.png'
os.makedirs(os.path.dirname(out_path), exist_ok=True)
strip.save(out_path)
print(f'Saved {out_path}  ({strip.width}x{strip.height})')
