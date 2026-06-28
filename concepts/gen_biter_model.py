#!/usr/bin/env python3
"""
Full biter pipeline: image-to-3D → retexture → custom rig → walk animation → sprite sheet.

The rigging step uses a custom 15-bone quadruped skeleton built in rig_biter.mjs —
Meshy's humanoid auto-rig is NOT used (it fails on elongated quadruped geometry).

Input:
  - concepts/biter_portrait.png  (primary identity reference)

Output:
  - models/biter/model.glb        (200k poly image-to-3D)
  - models/biter/retextured.glb   (PBR retextured)
  - models/biter/animated.glb     (custom trot animation baked by rig_biter.mjs, gitignored)
  - sprites/biter_sheet.png       (16-dir × 8-frame walk sprite sheet)

Usage:
  .venv/bin/python concepts/gen_biter_model.py             # full pipeline
  .venv/bin/python concepts/gen_biter_model.py --skip-mesh  # retexture + rig (keeps model.glb)
  .venv/bin/python concepts/gen_biter_model.py --skip-model # rig only (keeps retextured.glb)
"""

import base64, json, subprocess, sys, time, urllib.request
from pathlib import Path

API_KEY_FILE = Path("/Users/oyvhvi/Code/local-mcp/.env")
BASE = "https://api.meshy.ai/openapi/v1"
ROOT = Path(__file__).resolve().parent.parent

BITER_OBJECT_PROMPT = (
    "Massive alien predator quadruped with a long bear-like body. "
    "The torso is elongated — body length from nose to haunches is 2.5× the shoulder height, "
    "like a bear, lion, or large hunting cat. "
    "Four thick muscled legs positioned directly under the elongated body, not splayed: "
    "front legs attach clearly at the chest and shoulders, rear legs at the haunches — "
    "all four legs roughly vertical, like a walking bear. "
    "Sickly pale grey-white and off-white mottled diseased skin covering most of the body — "
    "pallid, waxy, almost translucent in places. "
    "Dark blood-red tumorous growths, oozing crimson sores, and open weeping wounds "
    "concentrated on the back, shoulders, and spine ridge — the red is clustered growths and "
    "disease, not uniform coloring. Dark chitinous diamond-pattern scale armor plates erupting "
    "from the red growths. Pale cream smooth skin on the underbelly and inner legs. "
    "Enormous oversized head carried very low in a forward-charging posture, "
    "nearly level with the broad muscled shoulders. Long muscled neck. "
    "Wide gaping maw with rows of large jagged irregular fangs. "
    "Two large curved ivory bone horns sweeping upward and forward from the skull crown. "
    "A prominent ridge of large bone spikes running along the spine from neck to haunches. "
    "Each foot has three wide toes bearing thick curved claws. "
    "No tail. Weight-forward predatory posture, body close to the ground."
)

BITER_STYLE_PROMPT = (
    "photorealistic highly detailed PBR textures, dark sci-fi horror, "
    "sickly pale grey-white mottled diseased skin as the primary surface, "
    "dark blood-red tumorous growths and crimson oozing sores clustered on the back and spine, "
    "dark chitinous diamond-pattern scale plates growing from the growths, "
    "pale cream smooth underbelly, ivory curved horns and bone ridge spikes, "
    "cinematic harsh side lighting, hyper-detailed creature surface"
)


def load_api_key():
    for line in API_KEY_FILE.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise ValueError(f"MESHY_API_KEY not found in {API_KEY_FILE}")


def api_call(method, path, body, api_key):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
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
    skip_model = "--skip-model" in sys.argv
    skip_mesh  = "--skip-mesh"  in sys.argv

    portrait = ROOT / "concepts" / "biter_portrait.png"
    out_dir  = ROOT / "models" / "biter"

    if not portrait.exists():
        print(f"Missing: {portrait}", file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    api_key = load_api_key()

    if skip_model:
        retex_path = out_dir / "retextured.glb"
        if not retex_path.exists():
            print(f"--skip-model requires {retex_path}", file=sys.stderr)
            sys.exit(1)
        print("Skipping image-to-3D and retexture — using existing retextured.glb")
    else:
        if skip_mesh:
            # ── Step 1 skipped: re-use existing mesh ─────────────────────────
            model_path = out_dir / "model.glb"
            if not model_path.exists():
                print(f"--skip-mesh requires {model_path}", file=sys.stderr)
                sys.exit(1)
            model_b64 = base64.b64encode(model_path.read_bytes()).decode()
            model_url = f"data:model/gltf-binary;base64,{model_b64}"
            print("Skipping image-to-3D — retexturing existing model.glb with updated prompts")
        else:
            # ── Step 1: image-to-3D ──────────────────────────────────────────
            print("\n=== 1/3  image-to-3D (200k poly, meshy-5) ===")
            portrait_b64 = base64.b64encode(portrait.read_bytes()).decode()
            resp = api_call("POST", "/image-to-3d", {
                "image_url":        f"data:image/png;base64,{portrait_b64}",
                "ai_model":         "meshy-5",
                "topology":         "quad",
                "target_polycount": 200_000,
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

        # ── Step 2: retexture ────────────────────────────────────────────────
        step_label = "1/2" if skip_mesh else "2/3"
        print(f"\n=== {step_label}  retexture (portrait reference) ===")
        portrait_data_uri = "data:image/png;base64," + base64.b64encode(portrait.read_bytes()).decode()
        resp = api_call("POST", "/retexture", {
            "model_url":         model_url,
            "object_prompt":     BITER_OBJECT_PROMPT,
            "text_style_prompt": BITER_STYLE_PROMPT,
            "image_style_url":   portrait_data_uri,
            "art_style":         "realistic",
            "enable_pbr":        True,
        }, api_key)
        retex_id = resp["result"]
        print(f"  Task: {retex_id}")
        retex_task = poll(f"/retexture/{retex_id}", api_key, "Retexturing", interval=10)
        retex_url = retex_task["model_urls"]["glb"]
        download(retex_url, out_dir / "retextured.glb")
        # save the CDN URL for the rig step — base64 data URIs can confuse pose estimation
        (out_dir / "retextured_url.txt").write_text(retex_url)

    # ── Step 3: custom quadruped rig + trot animation + sprite sheet ─────────
    # rig_biter.mjs builds a 15-bone skeleton from scratch on retextured.glb —
    # Meshy's humanoid auto-rig is skipped (fails on elongated quadruped geometry)
    print("\n=== 3/3  custom rig + bake trot + render sprite sheet ===")
    result = subprocess.run(["node", "scripts/rig_biter.mjs"], cwd=ROOT)
    if result.returncode != 0:
        sys.exit(result.returncode)

    print("\n=== Done ===")
    print(f"  sprites/biter_sheet.png")


if __name__ == "__main__":
    main()
