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

const [,, glbPath, sizeArg, outArg, framesArg, cycleRangeArg, exposureArg, saturationArg, edgeArg, hlArg] = process.argv;
if (!glbPath) {
  console.error('Usage: node render_sprites.mjs <model.glb> [frameSize] [output.png] [numAnimFrames] [cycleRange] [exposure] [saturation] [edgeStrength] [hlCompress]');
  process.exit(1);
}
const numAnimFrames = parseInt(framesArg || '1');
const exposure      = exposureArg  != null ? parseFloat(exposureArg)  : 1.1;
const saturation    = saturationArg != null ? parseFloat(saturationArg) : 1.5;
// edgeStrength: 0.55 is good for organic/creature models; reduce for mechanical surfaces
// to prevent Sobel edge darkening from turning saturated colors muddy
const edgeStrength  = edgeArg != null ? parseFloat(edgeArg) : 0.55;
// hlCompress: floor brightness for highlights; 0.55 is aggressive (squashes bright yellows
// to orange-brown); use 0.80 or higher for saturated mechanical/painted surfaces
const hlCompress    = hlArg != null ? parseFloat(hlArg) : 0.55;

const rawName = basename(glbPath, '.glb');
// for canonical filenames, derive identity from the parent dir
const CANONICAL = ['model', 'retextured', 'animated', 'hand_animated'];
const name = CANONICAL.includes(rawName)
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
// Reinhard preserves hue fidelity — ACES aggressively desaturates blues/cyans
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = ${exposure};
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

const hemi = new THREE.HemisphereLight(0x8899bb, 0x443322, 0.4);
scene.add(hemi);

// front-angled key — more z than y so it hits the face, not the top of the head
const key = new THREE.DirectionalLight(0xffddc8, 1.2);
key.position.set(3, 3, 6);
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


// --- post-process: two render targets ---
// tDiffuse  = full PBR scene (lighting, shadows, IBL)
// tAlbedo   = same scene rendered with MeshBasicMaterial (true texture colors, no lighting)
// The shader picks the more-saturated version per pixel so flame blue survives warm lighting.
const renderTarget = new THREE.WebGLRenderTarget(SIZE, SIZE, { format: THREE.RGBAFormat });
const albedoTarget = new THREE.WebGLRenderTarget(SIZE, SIZE, { format: THREE.RGBAFormat });

const postMat = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse:   { value: renderTarget.texture },
    tAlbedo:    { value: albedoTarget.texture },
    resolution: { value: new THREE.Vector2(SIZE, SIZE) },
  },
  vertexShader: \`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
  \`,
  fragmentShader: \`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAlbedo;
    uniform vec2 resolution;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float saturation(vec3 c) { float mx = max(c.r,max(c.g,c.b)); float mn = min(c.r,min(c.g,c.b)); return mx - mn; }

    vec3 posterize(vec3 c, float steps) {
      return floor(c * steps + 0.5) / steps;
    }

    void main() {
      vec2 px = 1.0 / resolution;
      vec4 col = texture2D(tDiffuse, vUv);
      if (col.a < 0.01) { gl_FragColor = vec4(0.0); return; }

      // Sobel on PBR render (has good luminance contrast for edges)
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
      float edge = smoothstep(0.30, 0.65, sqrt(Gx*Gx + Gy*Gy));

      vec3 pbrRgb    = posterize(col.rgb, 12.0);
      vec3 albedoRgb = posterize(texture2D(tAlbedo, vUv).rgb, 12.0);

      // flame rescue: only fires on pixels that are BOTH bright AND blue-leading in
      // the albedo — this targets the pale sky-blue flame geometry specifically and
      // ignores dark cybernetic accents, eyes, and other incidentally-blue surfaces
      float albedoLum  = luma(albedoRgb);
      float albedoBlueLead = albedoRgb.b - max(albedoRgb.r, albedoRgb.g);
      float pbrSat     = saturation(pbrRgb);
      float albedoSat  = saturation(albedoRgb);
      float isFlame = smoothstep(0.40, 0.65, albedoLum)       // must be bright
                    * smoothstep(0.05, 0.20, albedoBlueLead)  // must be clearly blue
                    * smoothstep(0.0,  0.15, albedoSat - pbrSat); // albedo more saturated
      float pbrLum = luma(pbrRgb);
      vec3 flameColor = vec3(0.05, 0.30, 1.0) * pbrLum * 2.2;
      flameColor = clamp(flameColor, 0.0, 1.0);
      vec3 rgb = mix(pbrRgb, flameColor, isFlame);

      // highlight compression on the final mix
      float lum = luma(rgb);
      float bluedom = smoothstep(0.0, 0.12, rgb.b - max(rgb.r, rgb.g));
      float compress = mix(1.0, ${hlCompress.toFixed(4)}, smoothstep(0.55, 1.0, lum));
      compress = mix(compress, 1.0, bluedom);
      rgb *= compress;

      // saturation boost (per-sprite multiplier passed from JS)
      float grey = luma(rgb);
      rgb = mix(vec3(grey), rgb, ${saturation.toFixed(4)});
      rgb = clamp(rgb, 0.0, 1.0);

      rgb *= 1.0 - edge * ${edgeStrength.toFixed(4)};

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
          envMapIntensity: 0.3,
        });
      });
    } else {
      // embedded GLB materials — GLTFLoader has already wired all PBR maps correctly
      // (base color, normal, metalness, roughness, AO, emissive). Do not replace.
      model.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        if (obj.material) obj.material.envMapIntensity = 0.3;
      });
    }

    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    const modelExtent = 0.5 / Math.max(size.x, size.y, size.z);
    model.scale.setScalar(modelExtent);
    window.__baseModelY = model.position.y;

    // set up AnimationMixer if the GLB has embedded animation clips
    window.__mixer    = null;
    window.__animClip = null;
    if (gltf.animations && gltf.animations.length > 0) {
      const clip = gltf.animations[0];
      const mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(clip);
      action.play();
      mixer.setTime(0);
      window.__mixer    = mixer;
      window.__animClip = clip;
      console.log('Animation clip found:', clip.name, 'duration:', clip.duration.toFixed(2) + 's');
    }

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

// swap every mesh to MeshBasicMaterial (map only), render, restore
function renderAlbedo() {
  const saved = [];
  scene.traverse(obj => {
    if (!obj.isMesh) return;
    saved.push({ obj, mat: obj.material });
    obj.material = new THREE.MeshBasicMaterial({ map: obj.material.map || null, transparent: true, alphaTest: 0.01 });
  });
  renderer.setRenderTarget(albedoTarget);
  renderer.render(scene, camera);
  saved.forEach(({ obj, mat }) => { obj.material = mat; });
}

// render scene through the post-process pipeline to the canvas
function renderFrame() {
  renderer.setRenderTarget(renderTarget);
  renderer.render(scene, camera);
  renderAlbedo();
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCam);
}

window.renderSheet = async (numFrames, isHover, cycleRange, rotOffset) => {
  numFrames  = numFrames  || 1;
  cycleRange = cycleRange ?? 1.0;
  rotOffset  = rotOffset  || 0;

  if (window.__animClip) {
    console.log('clip:', window.__animClip.name, 'duration:', window.__animClip.duration.toFixed(3) + 's', 'cycleRange:', cycleRange.toFixed(3));
  }

  // zoom pass — bind/rest pose (t=0), render directly to canvas
  if (window.__mixer) window.__mixer.setTime(0);
  const STEP = 1.05;
  let pass = 0;
  while (true) {
    let clips = false;
    for (let i = 0; i < 16; i++) {
      model.rotation.y = rotOffset + i * 22.5 * Math.PI / 180;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      if (edgeClips(getPixels())) { clips = true; break; }
    }
    if (clips) { model.scale.multiplyScalar(1 / STEP); break; }
    model.scale.multiplyScalar(STEP);
    if (++pass > 200) break;
  }

  // animation frames — 16 directions × numFrames animation steps
  const frames = [];
  const baseY = window.__baseModelY || 0;
  for (let f = 0; f < numFrames; f++) {
    // t ∈ [0, cycleRange) — for walk: covers one stride (1/3 of a 3-stride clip)
    const t = (f / numFrames) * cycleRange;

    if (numFrames > 1) {
      if (window.__mixer && window.__animClip) {
        // skeletal animation — position is fully driven by the baked clip; no extra bob here
        window.__mixer.setTime(t * window.__animClip.duration);
      } else {
        // fallback: procedural animation (no rig in this GLB)
        const amp = model.scale.x * 0.30;
        const phase = (f / numFrames) * 2 * Math.PI;
        if (isHover) {
          // fly-forward cycle: Y-bob + pronounced forward lean (no z/y rotation = no spin)
          model.position.y = baseY + Math.sin(phase) * amp;
          model.rotation.x = 0.15 + Math.sin(phase) * 0.20; // leans forward, rocks back slightly
        } else {
          model.position.y = baseY + Math.sin(phase * 2) * amp;
          model.rotation.z = Math.cos(phase) * 0.18;
        }
      }
    }

    for (let i = 0; i < 16; i++) {
      model.rotation.y = rotOffset + i * 22.5 * Math.PI / 180;
      renderFrame();
      frames.push(capture2D());
    }
  }

  // reset pose
  model.position.y = baseY;
  if (window.__mixer) {
    window.__mixer.setTime(0);
  } else {
    model.rotation.x = 0;
    model.rotation.z = 0;
  }

  // sheet layout: 16 cols (directions) × numFrames rows (animation frames)
  const sheet = document.createElement('canvas');
  sheet.width = 16 * SIZE;
  sheet.height = numFrames * SIZE;
  const ctx = sheet.getContext('2d');
  for (let f = 0; f < numFrames; f++) {
    for (let i = 0; i < 16; i++) {
      ctx.drawImage(frames[f * 16 + i], i * SIZE, f * SIZE);
    }
  }

  return sheet.toDataURL('image/png');
};

window.__threeReady = true;
</script>
</body></html>`);

page.on('console', msg => console.log('[browser]', msg.text()));

await page.waitForFunction(() => window.__threeReady === true, { timeout: 30_000 });
await page.evaluate(({ glb, tex }) => window.loadModel({ glb, tex }), { glb: glbBase64, tex: texB64 });

const isHover = name.includes('reaper');
// default cycleRange: full clip for custom single-cycle animations (hover/walk baked in rig_*.mjs);
// 1/3 for raw Meshy walk clips which contain 3 strides — one stride = first 1/3 of the clip.
// override via the optional 6th argument.
const cycleRange = cycleRangeArg != null ? parseFloat(cycleRangeArg)
  : isHover ? 1.0 : (1 / 3);
const rotOffset  = 0;
console.log(`Rendering ${name} — ${numAnimFrames} anim frame(s), 16 dirs, cycleRange=${cycleRange.toFixed(3)}, exposure=${exposure.toFixed(2)}, sat=${saturation.toFixed(2)}, post-process...`);
const sheetDataUrl = await page.evaluate(
  ({ nf, ih, cr, ro }) => window.renderSheet(nf, ih, cr, ro),
  { nf: numAnimFrames, ih: isHover, cr: cycleRange, ro: rotOffset }
);
await browser.close();

writeFileSync(sheetPath, Buffer.from(sheetDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
const sheetW = 16 * frameSize, sheetH = numAnimFrames * frameSize;
console.log(`\nDone → ${sheetPath}  (${frameSize}px frames, ${sheetW}×${sheetH}px sheet, ${numAnimFrames} anim frames × 16 dirs)`);
console.log(`Frame index: animFrame * 16 + dirIndex  (dirs: S SSE SE ESE E ENE NE NNE N NNW NW WNW W WSW SW SSW)`);
