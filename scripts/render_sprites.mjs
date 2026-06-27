#!/usr/bin/env node
/**
 * Render a 16-direction sprite sheet from a GLB model.
 *
 * Auto-zoom: start at a conservative scale that definitely fits in frame, zoom in 5%
 * per pass until any direction clips the 1px border, then back off one step.
 * All 16 frames share the same scale, so the character is pixel-identical in size.
 *
 * Post-process: Sobel edge detection (hand-drawn ink lines) + subtle posterization,
 * rendered onto full PBR materials (all maps wired by GLTFLoader automatically).
 *
 * Output: sprites/<name>_sheet.png  (4×4 grid, row-major DIRS order)
 *
 * Usage:
 *   node scripts/render_sprites.mjs <model.glb> [frameSize] [output.png]
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

// load external PBR textures — only for model.glb; retextured.glb has embedded textures
// with correct UV layout that must not be overridden
const texDir = resolve(glbPath, '..', 'textures');
let texB64 = null;
if (rawName === 'model') {
  const tryRead = f => { try { return readFileSync(`${texDir}/${f}.png`).toString('base64'); } catch { return null; } };
  const bc = tryRead('base_color');
  if (bc) {
    texB64 = {
      base_color: bc,
      normal:     tryRead('normal'),
      metallic:   tryRead('metallic'),
      roughness:  tryRead('roughness'),
    };
    const maps = Object.entries(texB64).filter(([, v]) => v).map(([k]) => k).join(', ');
    console.log(`External textures found — applying: ${maps}`);
  } else {
    console.log('No textures/ dir — using embedded GLB materials.');
  }
} else {
  console.log('Non-base GLB — using embedded materials.');
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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SIZE = ${frameSize};

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

// IBL — essential for metallic PBR; metals have no diffuse component without it
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const roomEnv = new RoomEnvironment();
scene.environment = pmrem.fromScene(roomEnv).texture;
roomEnv.dispose();
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 200);

const hemi = new THREE.HemisphereLight(0x8899bb, 0x443322, 0.8);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffddc8, 2.2);
key.position.set(5, 8, 3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1; key.shadow.camera.far = 30;
key.shadow.camera.left = key.shadow.camera.bottom = -3;
key.shadow.camera.right = key.shadow.camera.top = 3;
key.shadow.bias = -0.001;
scene.add(key);

const rim = new THREE.DirectionalLight(0x3355aa, 0.6);
rim.position.set(-3, 2, -5);
scene.add(rim);

// --- post-process: render scene to this target, then apply Sobel+posterize ---
const renderTarget = new THREE.WebGLRenderTarget(SIZE, SIZE, { format: THREE.RGBAFormat });

// Sobel edge detection + posterize — gives ink-outline + hand-painted banding
// without replacing the PBR materials
const postMat = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse:   { value: renderTarget.texture },
    resolution: { value: new THREE.Vector2(SIZE, SIZE) },
  },
  vertexShader: \`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
  \`,
  fragmentShader: \`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    // quantise to N discrete steps — keeps colour identity but bands the shading
    vec3 posterize(vec3 c, float steps) {
      return floor(c * steps + 0.5) / steps;
    }

    void main() {
      vec2 px = 1.0 / resolution;
      vec4 col = texture2D(tDiffuse, vUv);
      if (col.a < 0.01) { gl_FragColor = vec4(0.0); return; }

      // Sobel kernel on luminance — detects both silhouette and internal panel edges
      float tl = luma(texture2D(tDiffuse, vUv + px * vec2(-1.,-1.)).rgb);
      float tc = luma(texture2D(tDiffuse, vUv + px * vec2( 0.,-1.)).rgb);
      float tr = luma(texture2D(tDiffuse, vUv + px * vec2( 1.,-1.)).rgb);
      float ml = luma(texture2D(tDiffuse, vUv + px * vec2(-1., 0.)).rgb);
      float mr = luma(texture2D(tDiffuse, vUv + px * vec2( 1., 0.)).rgb);
      float bl = luma(texture2D(tDiffuse, vUv + px * vec2(-1., 1.)).rgb);
      float bc = luma(texture2D(tDiffuse, vUv + px * vec2( 0., 1.)).rgb);
      float br = luma(texture2D(tDiffuse, vUv + px * vec2( 1., 1.)).rgb);
      float Gx = -tl - 2.*ml - bl + tr + 2.*mr + br;
      float Gy = -tl - 2.*tc - tr + bl + 2.*bc + br;
      // higher threshold = thinner lines, only major geometry edges fire
      float edge = smoothstep(0.30, 0.65, sqrt(Gx*Gx + Gy*Gy));

      // 12 steps — barely-visible banding, preserves most PBR smoothness
      vec3 rgb = posterize(col.rgb, 12.0);

      // boost saturation so colours stay vivid
      float grey = luma(rgb);
      rgb = mix(vec3(grey), rgb, 1.45);
      rgb = clamp(rgb, 0.0, 1.0);

      // lighter ink lines
      rgb *= 1.0 - edge * 0.55;

      gl_FragColor = vec4(rgb, col.a);
    }
  \`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});

const quadScene = new THREE.Scene();
const quadCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

let model = null;

// manually-loaded textures must have flipY=false — glTF UV origin is upper-left,
// THREE.Texture defaults to lower-left
function b64toTexture(b64, colorSpace) {
  const tex = new THREE.Texture();
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
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
      // external PBR maps — GLTFLoader not involved, build MeshStandardMaterial manually.
      // roughnessMap reads G channel; metalnessMap reads B channel; Meshy greyscale files
      // store the same value in all channels so both are correct
      const baseColorTex = b64toTexture(tex.base_color, THREE.SRGBColorSpace);
      const normalTex    = tex.normal    ? b64toTexture(tex.normal)    : null;
      const roughnessTex = tex.roughness ? b64toTexture(tex.roughness) : null;
      const metallicTex  = tex.metallic  ? b64toTexture(tex.metallic)  : null;
      model.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        obj.material = new THREE.MeshStandardMaterial({
          map:             baseColorTex,
          normalMap:       normalTex,
          roughnessMap:    roughnessTex,
          metalnessMap:    metallicTex,
          metalness:       metallicTex  ? 1.0 : 0.3,
          roughness:       roughnessTex ? 1.0 : 0.8,
          envMapIntensity: 1.0,
        });
      });
    } else {
      // embedded GLB materials — GLTFLoader has already wired all PBR maps correctly
      // (base color, normal, metalness, roughness, AO, emissive). Do not replace.
      model.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        if (obj.material) obj.material.envMapIntensity = 1.0;
      });
    }

    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    model.scale.setScalar(0.5 / Math.max(size.x, size.y, size.z));

    const elev = 60 * Math.PI / 180;
    const d = 5.5;
    camera.position.set(0, d * Math.sin(elev), d * Math.cos(elev));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    resolve();
  }, reject);
});

// WebGL canvas loses alpha at larger sizes in headless Chrome — copy through a 2D canvas
function capture2D() {
  const tmp = document.createElement('canvas');
  tmp.width = SIZE; tmp.height = SIZE;
  const ctx = tmp.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(canvas, 0, 0);
  return tmp;
}

function getPixels() {
  return capture2D().getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
}

// true if any pixel on the 1px border is non-transparent
function edgeClips(pixels) {
  const S = SIZE;
  for (let x = 0; x < S; x++) {
    if (pixels[x * 4 + 3] > 8) return true;
    if (pixels[((S - 1) * S + x) * 4 + 3] > 8) return true;
  }
  for (let y = 1; y < S - 1; y++) {
    if (pixels[y * S * 4 + 3] > 8) return true;
    if (pixels[(y * S + S - 1) * 4 + 3] > 8) return true;
  }
  return false;
}

// render scene through the post-process pipeline to the canvas
function renderFrame() {
  renderer.setRenderTarget(renderTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCam);
}

window.renderSheet = async () => {
  // zoom pass — render directly to canvas so getPixels() can read it;
  // post-process is skipped here since edge detection only needs alpha/transparency
  const STEP = 1.05;
  let pass = 0;
  while (true) {
    let clips = false;
    for (let i = 0; i < 16; i++) {
      model.rotation.y = i * 22.5 * Math.PI / 180;
      renderer.setRenderTarget(null); // canvas, not renderTarget
      renderer.render(scene, camera);
      if (edgeClips(getPixels())) { clips = true; break; }
    }
    if (clips) { model.scale.multiplyScalar(1 / STEP); break; }
    model.scale.multiplyScalar(STEP);
    if (++pass > 200) break;
  }

  // final pass — all 16 directions with full post-process
  const frames = [];
  for (let i = 0; i < 16; i++) {
    model.rotation.y = i * 22.5 * Math.PI / 180;
    renderFrame();
    frames.push(capture2D());
  }

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

console.log(`Rendering ${name} — iterative edge-zoom, post-process (Sobel + posterize), 4×4 sheet...`);
const sheetDataUrl = await page.evaluate(() => window.renderSheet(), { timeout: 180_000 });
await browser.close();

writeFileSync(sheetPath, Buffer.from(sheetDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(`\nDone → ${sheetPath}  (${frameSize}px × ${frameSize}px frames, ${4*frameSize}×${4*frameSize}px sheet)`);
console.log(`Frame order (row-major): S SSE SE ESE | E ENE NE NNE | N NNW NW WNW | W WSW SW SSW`);
