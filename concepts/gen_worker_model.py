#!/usr/bin/env python3
"""
Full worker model pipeline: image-to-3D → retexture → Meshy rig → sprite sheet.

Input:
  - concepts/worker_portrait.png  (primary identity reference)

Output:
  - models/worker/model.glb        (150k poly image-to-3D)
  - models/worker/retextured.glb   (PBR retextured, self-contained)
  - models/worker/animated.glb     (Meshy-rigged with built-in walk animation)
  - sprites/worker_sheet.png       (16-dir × 8-frame sprite sheet)

Usage:
  .venv/bin/python concepts/gen_worker_model.py              # full pipeline
  .venv/bin/python concepts/gen_worker_model.py --skip-mesh  # retexture + rig + render (keeps model.glb)
  .venv/bin/python concepts/gen_worker_model.py --skip-anim  # render only (keeps animated.glb)
"""

import base64, io, json, subprocess, sys, time, urllib.request
from pathlib import Path
from PIL import Image, ImageEnhance

API_KEY_FILE = Path("/Users/oyvhvi/Code/local-mcp/.env")
BASE = "https://api.meshy.ai/openapi/v1"
ROOT = Path(__file__).resolve().parent.parent

WORKER_OBJECT_PROMPT = (
    "Heavy industrial bipedal exo-mech walker. Two massive mechanical legs with thick hydraulic "
    "pistons and multi-jointed knee and ankle mechanisms — legs slightly bent, weight-bearing stance. "
    "The torso is a boxy armored industrial frame with an open-top operator cockpit — the human pilot "
    "sits upright inside, visible from the chest up: bald, pale, heavily muscled with scars and "
    "subcutaneous veins. Two large mechanical arm-mounted claw grippers extend from the sides of the "
    "torso. Rugged yellow-painted industrial steel construction with black hydraulic hoses and cables "
    "running along the exterior. Warning stripes, battered paint with chips and rust. A small yellow "
    "warning light on top of the cockpit frame. No wheels — bipedal walking machine only."
)

# Strengthened yellow emphasis to prevent Meshy drifting toward orange/rust
WORKER_STYLE_PROMPT = (
    "photorealistic highly detailed PBR textures, bright yellow industrial construction equipment. "
    "ALL surfaces — top, back, sides, underside — are painted the SAME bright Caterpillar / CAT chrome yellow. "
    "The yellow is uniform across the whole machine: not orange, not brown, not rust — pure vivid yellow everywhere. "
    "Only very minor paint scratches and chips at joints showing bare steel underneath. "
    "Black rubber hydraulic hoses and dark gunmetal-grey joints provide contrast. "
    "Cinematic lighting, hyper-detailed mechanical PBR surface."
)


def load_api_key():
    for line in API_KEY_FILE.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise ValueError(f"MESHY_API_KEY not found in {API_KEY_FILE}")


def api_call(method, path, body, api_key, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}") from None


def poll(path, api_key, label, interval=15):
    while True:
        task = api_call("GET", path, None, api_key)
        status = task.get("status", "?")
        print(f"  {label}: {status} {task.get('progress', 0)}%", end="\r", flush=True)
        if status == "SUCCEEDED":
            print()
            return task
        if status in ("FAILED", "CANCELED"):
            print()
            raise RuntimeError(f"{label} {status}: {task.get('task_error')}")
        time.sleep(interval)


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as r:
        dest.write_bytes(r.read())
    print(f"  Saved: {dest}")


def main():
    skip_mesh = "--skip-mesh" in sys.argv  # skip image-to-3D; use existing model.glb
    skip_anim = "--skip-anim" in sys.argv  # skip everything; render from existing animated.glb

    portrait = ROOT / "concepts" / "worker_portrait.png"
    out_dir  = ROOT / "models" / "worker"

    if not portrait.exists():
        print(f"Missing: {portrait}", file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)

    if skip_anim:
        anim_path = out_dir / "animated.glb"
        if not anim_path.exists():
            print(f"--skip-anim requires {anim_path}", file=sys.stderr)
            sys.exit(1)
        print("Skipping mesh + retexture + rig — rendering from existing animated.glb")
    else:
        api_key = load_api_key()
        retex_url = None  # CDN URL from this run — passed directly to rigging step

        if skip_mesh:
            model_path = out_dir / "model.glb"
            if not model_path.exists():
                print(f"--skip-mesh requires {model_path}", file=sys.stderr)
                sys.exit(1)
            model_b64 = base64.b64encode(model_path.read_bytes()).decode()
            model_url = f"data:model/gltf-binary;base64,{model_b64}"
            print("Skipping image-to-3D — retexturing existing model.glb")
        else:
            # ── Step 1: image-to-3D ──────────────────────────────────────────────
            print("\n=== 1/3  image-to-3D (300k poly, meshy-5) ===")
            portrait_b64 = base64.b64encode(portrait.read_bytes()).decode()
            resp = api_call("POST", "/image-to-3d", {
                "image_url":        f"data:image/png;base64,{portrait_b64}",
                "ai_model":         "meshy-5",
                "topology":         "quad",
                "target_polycount": 300_000,
                "should_remesh":    True,
                "enable_pbr":       True,
                "target_formats":   ["glb"],
            }, api_key)
            task_id = resp["result"]
            print(f"  Task: {task_id}")
            task = poll(f"/image-to-3d/{task_id}", api_key, "Meshing", interval=15)
            model_url = task["model_urls"]["glb"]
            download(model_url, out_dir / "model.glb")
            (out_dir / "model_url.txt").write_text(model_url)

        # ── Step 2: retexture ────────────────────────────────────────────────────
        # Prepare the portrait:
        # 1. Composite onto black (remove the yellow-green gradient background).
        # 2. Boost green channel slightly to push orange rust → yellow.
        # 3. Reduce contrast so dark rust patches are less dominant.
        # 4. Increase saturation and brightness so the yellow reads clearly.
        # Without this, Meshy amplifies the rust/dark areas onto all non-front
        # surfaces and the whole model comes out dark orange from above.
        step_label = "1/2" if skip_mesh else "2/3"
        print(f"\n=== {step_label}  retexture (yellow-boosted portrait) ===")
        img = Image.open(portrait).convert("RGBA")
        bg  = Image.new("RGBA", img.size, (0, 0, 0, 255))
        bg.paste(img, mask=img.split()[3])
        rgb = bg.convert("RGB")
        r, g, b = rgb.split()
        # shift orange toward yellow: slight red dampen + green lift
        r = r.point(lambda x: min(255, int(x * 0.95)))
        g = g.point(lambda x: min(255, int(x * 1.05)))
        rgb = Image.merge("RGB", (r, g, b))
        # pull in the darks so rust patches are less aggressive
        rgb = ImageEnhance.Contrast(rgb).enhance(0.75)
        rgb = ImageEnhance.Brightness(rgb).enhance(1.25)
        rgb = ImageEnhance.Color(rgb).enhance(1.3)
        buf = io.BytesIO()
        rgb.save(buf, format="PNG")
        portrait_data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        # model_url may be a large data URI (local GLB) — use a generous upload timeout
        resp = api_call("POST", "/retexture", {
            "model_url":         model_url,
            "object_prompt":     WORKER_OBJECT_PROMPT,
            "text_style_prompt": WORKER_STYLE_PROMPT,
            "image_style_url":   portrait_data_uri,
            "art_style":         "realistic",
            "enable_pbr":        True,
        }, api_key, timeout=180)
        retex_id = resp["result"]
        print(f"  Task: {retex_id}")
        retex_task = poll(f"/retexture/{retex_id}", api_key, "Retexturing", interval=10)
        retex_url = retex_task["model_urls"]["glb"]
        download(retex_url, out_dir / "retextured.glb")

        # ── Step 3: Meshy humanoid rigging ───────────────────────────────────────
        step_label = "2/2" if skip_mesh else "3/3"
        print(f"\n=== {step_label}  Meshy humanoid rigging + walk animation ===")
        # retex_url is a fresh CDN URL from this run — pass it directly to avoid
        # re-uploading; for a future --skip-retex path, encode local file as data URI
        resp = api_call("POST", "/rigging", {
            "model_url":    retex_url,
            "height_meters": 1.8,
        }, api_key)
        rig_id = resp["result"]
        print(f"  Task: {rig_id}")
        rig_task = poll(f"/rigging/{rig_id}", api_key, "Rigging", interval=15)
        walking_url = rig_task["result"]["basic_animations"]["walking_glb_url"]
        download(walking_url, out_dir / "animated.glb")

        # strip arm swing tracks — Meshy animates arms like a human biped; a heavy
        # industrial mech with massive claws should keep arms rigid
        print("  Stripping arm animation tracks...")
        subprocess.run(["node", "scripts/strip_worker_arms.mjs"], cwd=ROOT, check=True)

    # ── Step 4: render 16-direction × 8-frame sprite sheet ───────────────────────
    print("\n=== render 16-direction sprite sheet (8 walk frames) ===")

    # Low saturation + moderate exposure — yellow metal must stay yellow, not shift orange.
    # Sobel edges are still enabled in render_sprites.mjs; keep edge contribution low by
    # not cranking saturation (high sat + strong edges = dark orange mud for this palette).
    result = subprocess.run([
        "node", "scripts/render_sprites.mjs",
        str(out_dir / "animated.glb"),
        "256", "sprites/worker_sheet.png",
        "8",    # 8 animation frames
        "1.0",  # cycleRange (Meshy walk is one complete stride cycle)
        "1.8",  # exposure
        "0.9",  # saturation — was 1.3, pulled back to avoid over-saturated orange
        "0.20", # edgeStrength — keep low for yellow metal
        "0.70", # hlCompress — was 0.80; allow more shadow variation
    ], cwd=ROOT)
    if result.returncode != 0:
        sys.exit(result.returncode)

    print("\n=== Done ===")
    print(f"  sprites/worker_sheet.png")


if __name__ == "__main__":
    main()
