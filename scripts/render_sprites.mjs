#!/usr/bin/env node
/**
 * Render a 16-direction sprite sheet from a rigged GLB model.
 *
 * Auto-zoom: renders all 16 directions, finds the tightest non-transparent
 * bounding box across ALL of them, scales so the largest extent fills 90% of
 * the frame (5% transparent margin on each side), then re-renders at that scale.
 * This guarantees the model is the same pixel size in every direction.
 *
 * Output: sprites/<name>_sheet.png  (4×4 grid, row-major in DIRS order)
 *
 * Usage:
 *   node scripts/render_sprites.mjs models/marine-original/model.glb [frameSize]
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';

const [,, glbPath, sizeArg, outArg] = process.argv;
if (!glbPath) {
  console.error('Usage: node render_sprites.mjs <model.glb> [frameSize] [output.png]');
  process.exit(1);
}

const rawName = basename(glbPath, '.glb');
const name = rawName === 'model'
  ? basename(resolve(glbPath, '..')).replace(/-(tpose|original|rigged|hq|t2t|raw)$/, '')
  : rawName;

const frameSize = parseInt(sizeArg || '256');
const sheetPath = outArg || `sprites/${name}_sheet.png`;

// load PBR textures if present in sibling textures/ dir
const texDir = resolve(glbPath, '..', 'textures');
let texB64 = null;
try {
  texB64 = {
    base_color: readFileSync(`${texDir}/base_color.png`).toString('base64'),
    normal:     readFileSync(`${texDir}/normal.png`).toString('base64'),
  };
  console.log('Textures found — applying base color + normal map.');
} catch {
  console.log('No textures/ dir — using embedded GLB materials.');
}

const glbBase64 = readFileSync(resolve(glbPath)).toString('base64');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(180_000);
await page.setViewportSize({ width: frameSize, height: frameSize });

await page.setContent(`<!DOCTYPE html>
<html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"}}</script>
</head><body style="margin:0;overflow:hidden;background:transparent">
<canvas id="c" width="${frameSize}" height="${frameSize}" style="display:block"></canvas>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SIZE = ${frameSize};
const DIRS = ['S','SSE','SE','ESE','E','ENE','NE','NNE','N','NNW','NW','WNW','W','WSW','SW','SSW'];

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0); // fully transparent background
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 200);

// no IBL — pure directional lighting avoids faceted geometry reflections
const key = new THREE.DirectionalLight(0xfff0d8, 8.0);
key.position.set(4, 5, 1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1; key.shadow.camera.far = 30;
key.shadow.camera.left = key.shadow.camera.bottom = -3;
key.shadow.camera.right = key.shadow.camera.top = 3;
key.shadow.bias = -0.001;
scene.add(key);

const rim = new THREE.DirectionalLight(0x3355bb, 3.0);
rim.position.set(-3, 4, -3);
scene.add(rim);

const bounce = new THREE.DirectionalLight(0x664422, 0.5);
bounce.position.set(0, -3, 2);
scene.add(bounce);

let model = null;

function b64toTexture(b64, colorSpace) {
  const tex = new THREE.Texture();
  tex.flipY = false; // glTF UVs are Y-up; THREE.Texture defaults to Y-down
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  img.onload = () => { tex.image = img; tex.needsUpdate = true; };
  if (colorSpace) tex.colorSpace = colorSpace;
  return tex;
}

window.loadModel = ({ glb, tex }) => new Promise((resolve, reject) => {
  const binary = atob(glb);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    model = gltf.scene;

    if (tex) {
      const baseColorTex = b64toTexture(tex.base_color, THREE.SRGBColorSpace);
      const normalTex    = b64toTexture(tex.normal,     THREE.LinearSRGBColorSpace);
      model.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        obj.material = new THREE.MeshStandardMaterial({
          map: baseColorTex, normalMap: normalTex,
          normalScale: new THREE.Vector2(1, 1),
          metalness: 0, roughness: 1.0,
        });
      });
    } else {
      // use embedded textures but standardise PBR values for consistent lighting
      model.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        if (obj.material) { obj.material.metalness = 0; obj.material.roughness = 1.0; }
      });
    }

    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    // conservative initial scale — must fit fully in frame so pass-1 bbox measurement is accurate
    model.scale.setScalar(0.5 / Math.max(size.x, size.y, size.z));

    const elev = 60 * Math.PI / 180;
    const d = 5.5;
    camera.position.set(0, d * Math.sin(elev), d * Math.cos(elev));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    resolve();
  }, reject);
});

// WebGL canvas can't give a 2D context — copy through a tmp 2D canvas for both
// pixel reading and frame capture; this also correctly preserves the alpha channel
// (direct WebGL canvas.toDataURL() loses alpha in headless Chrome at larger sizes)
function capture2D() {
  const tmp = document.createElement('canvas');
  tmp.width = SIZE; tmp.height = SIZE;
  const ctx = tmp.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(canvas, 0, 0);
  return tmp;
}

function getPixels() {
  const tmp = capture2D();
  return tmp.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
}

// true if any pixel on the 1px border is non-transparent
function edgeClips(pixels) {
  const S = SIZE;
  for (let x = 0; x < S; x++) {
    if (pixels[x * 4 + 3] > 8) return true;                       // top row
    if (pixels[((S - 1) * S + x) * 4 + 3] > 8) return true;      // bottom row
  }
  for (let y = 1; y < S - 1; y++) {
    if (pixels[y * S * 4 + 3] > 8) return true;                   // left col
    if (pixels[(y * S + S - 1) * 4 + 3] > 8) return true;        // right col
  }
  return false;
}

window.renderSheet = async () => {
  // zoom in 5% per pass until any direction clips the 1px frame border,
  // then back off 5% from the first scale that clipped
  const STEP = 1.05;
  let pass = 0;
  while (true) {
    let clips = false;
    for (let i = 0; i < 16; i++) {
      model.rotation.y = i * 22.5 * Math.PI / 180;
      renderer.render(scene, camera);
      if (edgeClips(getPixels())) { clips = true; break; }
    }
    if (clips) {
      model.scale.multiplyScalar(1 / STEP); // undo last step
      break;
    }
    model.scale.multiplyScalar(STEP);
    if (++pass > 200) break; // safety cap
  }

  // pass 2: render all 16 at the calibrated scale, capture via 2D copy for alpha
  const frames = [];
  for (let i = 0; i < 16; i++) {
    model.rotation.y = i * 22.5 * Math.PI / 180;
    renderer.render(scene, camera);
    frames.push(capture2D());
  }

  // composite into 4×4 sprite sheet
  const sheet = document.createElement('canvas');
  sheet.width = 4 * SIZE; sheet.height = 4 * SIZE;
  const ctx = sheet.getContext('2d');
  for (let i = 0; i < 16; i++) {
    ctx.drawImage(frames[i], (i % 4) * SIZE, Math.floor(i / 4) * SIZE);
  }

  return sheet.toDataURL('image/png');
};

window.__threeReady = true;
</script>
</body></html>`);

await page.waitForFunction(() => window.__threeReady === true, { timeout: 30_000 });
await page.evaluate(({ glb, tex }) => window.loadModel({ glb, tex }), { glb: glbBase64, tex: texB64 });

console.log(`Rendering ${name} — iterative edge-zoom, 4×4 sprite sheet...`);
const sheetDataUrl = await page.evaluate(() => window.renderSheet(), { timeout: 180_000 });
await browser.close();

writeFileSync(sheetPath, Buffer.from(sheetDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(`\nDone → ${sheetPath}  (${frameSize}px × ${frameSize}px frames, ${4*frameSize}×${4*frameSize}px sheet)`);
console.log(`Frame order (row-major): S SSE SE ESE | E ENE NE NNE | N NNW NW WNW | W WSW SW SSW`);
