#!/usr/bin/env node
/**
 * Diagnostic renderer for the worker rig.
 * Outputs debug frames to worker-debug/ for inspecting bone placement and animation.
 *
 * Run standalone:  node scripts/test_worker_rig.mjs
 * Or via pipeline: node scripts/rig_worker.mjs  (calls this automatically)
 *
 * ── Research notes ─────────────────────────────────────────────────────────────
 *
 * 1. BONE NAMES
 *    Meshy's humanoid rig uses names that vary by model — run this script once to
 *    see BONE <name> world=(...) lines in the output and verify the skeleton.
 *    Common Meshy humanoid naming: Hips, Spine, Spine1, Spine2, Head,
 *    LeftUpLeg/LeftLeg/LeftFoot, RightUpLeg/RightLeg/RightFoot,
 *    LeftArm/LeftForeArm/LeftHand, RightArm/RightForeArm/RightHand.
 *
 * 2. BODY ORIENTATION
 *    Meshy bipeds typically face -Z (front face toward camera). Left arm/leg
 *    should have X > 0 in the standard right-hand coordinate system.
 *    Verify with tpose_front_bones.png and tpose_side_bones.png.
 *
 * 3. VERTEX SCAN OUTPUT
 *    LEFT_FOOT / RIGHT_FOOT: bottom-15% vertices split left (x>0.1) vs right (x<-0.1).
 *    HIP_CENTROID: centre-region vertices near y=0 — should land at the pelvis.
 *    HEAD_CENTROID: top-15% vertices, central X — should sit at head/cockpit level.
 *
 * 4. ANIMATION
 *    The Meshy walk clip may be named 'Walk', 'walking', or 'mixamo.com'.
 *    This script prints the clip name and duration; walk_frame_0-7.png shows 8
 *    evenly-spaced frames across the full clip duration.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const SIZE   = 512;
const outDir = 'worker-debug';
mkdirSync(outDir, { recursive: true });

async function renderView(page, rotY, boneMode, label) {
  const png = await page.evaluate(
    ({ rotY, boneMode, size }) => {
      const renderer = window.__renderer;
      const scene    = window.__scene;
      const camera   = window.__camera;
      const model    = window.__model;
      const canvas   = window.__canvas;

      model.rotation.set(0, rotY, 0);
      if (window.__boneOverlay) window.__boneOverlay.rotation.set(0, rotY, 0);
      scene.updateMatrixWorld(true);

      if (boneMode && window.__skeleton) window.__skeleton.forEach(h => { h.visible = true; });
      renderer.render(scene, camera);
      if (boneMode && window.__skeleton) window.__skeleton.forEach(h => { h.visible = false; });

      const tmp = document.createElement('canvas');
      tmp.width = size; tmp.height = size;
      tmp.getContext('2d').drawImage(canvas, 0, 0);
      return tmp.toDataURL('image/png');
    },
    { rotY, boneMode, size: SIZE }
  );
  const path = `${outDir}/${label}.png`;
  writeFileSync(path, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
  console.log(`  → ${path}`);
}

async function renderAnimFrame(page, frameIdx, numFrames, label) {
  const png = await page.evaluate(
    ({ fi, nf, size }) => {
      const renderer = window.__renderer;
      const scene    = window.__scene;
      const camera   = window.__camera;
      const model    = window.__model;
      const canvas   = window.__canvas;
      const mixer    = window.__mixer;
      const clip     = window.__animClip;

      if (mixer && clip) {
        mixer.setTime((fi / nf) * clip.duration);
        scene.updateMatrixWorld(true);
      }
      model.rotation.set(0, 0, 0);
      if (window.__boneOverlay) window.__boneOverlay.rotation.set(0, 0, 0);
      renderer.render(scene, camera);

      const tmp = document.createElement('canvas');
      tmp.width = size; tmp.height = size;
      tmp.getContext('2d').drawImage(canvas, 0, 0);
      return tmp.toDataURL('image/png');
    },
    { fi: frameIdx, nf: numFrames, size: SIZE }
  );
  const path = `${outDir}/${label}.png`;
  writeFileSync(path, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
  console.log(`  → ${path}`);
}

const glbPath   = resolve('models/worker/animated.glb');
const glbBase64 = readFileSync(glbPath).toString('base64');

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
page.setDefaultTimeout(120_000);
page.on('console', msg => console.log('[browser]', msg.text()));

await page.setViewportSize({ width: SIZE, height: SIZE });
await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#1a1a1a">
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas   = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(${SIZE}, ${SIZE});
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffd080, 1.4);
dir.position.set(3, 5, 4);
scene.add(dir);
const fill = new THREE.DirectionalLight(0x8090ff, 0.5);
fill.position.set(-3, 2, -4);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);

window.__renderer = renderer;
window.__scene    = scene;
window.__camera   = camera;
window.__canvas   = canvas;
window.__model    = null;
window.__skeleton = [];
window.__mixer    = null;
window.__animClip = null;

window.loadGLB = (b64) => new Promise((resolve, reject) => {
  const bytes = new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    const model = gltf.scene;
    scene.add(model);
    model.updateMatrixWorld(true);

    // raw bounds before centering
    const rawBox  = new THREE.Box3().setFromObject(model);
    const rawMin  = rawBox.min; const rawMax = rawBox.max;
    const rawSize = rawBox.getSize(new THREE.Vector3());
    console.log('MESH_BOUNDS min=(' + rawMin.x.toFixed(3) + ',' + rawMin.y.toFixed(3) + ',' + rawMin.z.toFixed(3) + ') max=(' + rawMax.x.toFixed(3) + ',' + rawMax.y.toFixed(3) + ',' + rawMax.z.toFixed(3) + ')');
    console.log('MESH_SIZE x=' + rawSize.x.toFixed(3) + ' y=' + rawSize.y.toFixed(3) + ' z=' + rawSize.z.toFixed(3));

    // vertex scan — biped-specific: left/right feet on X axis, not front/rear on Z
    model.traverse(node => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      const pos = node.geometry.attributes.position;
      let minY=Infinity, maxY=-Infinity;
      const allVerts = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        allVerts.push([x, y, z]);
      }
      console.log('VERT_Y_RANGE min=' + minY.toFixed(3) + ' max=' + maxY.toFixed(3));

      const centroid = verts => {
        if (!verts.length) return null;
        const c = [0,0,0]; verts.forEach(v => { c[0]+=v[0]; c[1]+=v[1]; c[2]+=v[2]; });
        return c.map(x => (x/verts.length).toFixed(3)).join(',');
      };

      // bottom 15% → feet (split left x>0 vs right x<0)
      const footYThresh = minY + (maxY - minY) * 0.15;
      console.log('FOOT_Y_THRESH=' + footYThresh.toFixed(3) + ' (bottom 15%)');
      const leftFoot  = allVerts.filter(v => v[1] < footYThresh && v[0] >  0.05);
      const rightFoot = allVerts.filter(v => v[1] < footYThresh && v[0] < -0.05);
      console.log('LEFT_FOOT=' + (centroid(leftFoot) || 'none') + '  RIGHT_FOOT=' + (centroid(rightFoot) || 'none'));

      // hip band: y in [-15%, +15%] around vertical midpoint, central X (within 30% of model width)
      const midY = (minY + maxY) / 2;
      const halfW = rawSize.x * 0.30;
      const hipBand = allVerts.filter(v => Math.abs(v[1] - midY) < (maxY-minY)*0.15 && Math.abs(v[0]) < halfW);
      console.log('HIP_CENTROID=' + (centroid(hipBand) || 'none'));

      // head: top 15%, central X
      const headYThresh = maxY - (maxY - minY) * 0.15;
      const headVerts = allVerts.filter(v => v[1] > headYThresh && Math.abs(v[0]) < halfW);
      console.log('HEAD_CENTROID=' + (centroid(headVerts) || 'none') + ' (top 15%, center X)');

      // shoulder width: y in upper 25-60% of height, broadest X extent
      const shoulderBand = allVerts.filter(v => v[1] > minY + (maxY-minY)*0.60 && v[1] < minY + (maxY-minY)*0.80);
      let maxX=0;
      shoulderBand.forEach(v => { if (Math.abs(v[0]) > maxX) maxX = Math.abs(v[0]); });
      console.log('SHOULDER_HALF_WIDTH=' + maxX.toFixed(3));
    });

    // log all bones
    const allBones = [];
    model.traverse(n => { if (n.isBone) allBones.push(n); });
    console.log('BONE_COUNT=' + allBones.length);
    allBones.forEach(b => {
      const wp = new THREE.Vector3(); b.getWorldPosition(wp);
      console.log('BONE ' + b.name.padEnd(24) + ' world=(' + wp.x.toFixed(3) + ',' + wp.y.toFixed(3) + ',' + wp.z.toFixed(3) + ')');
    });

    // center and fit
    const box    = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov    = camera.fov * Math.PI / 180;
    const dist   = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
    // slight upward camera offset so the worker's cockpit/head is centred in frame
    camera.position.set(0, dist * 0.1, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    // bone overlay (explicit LineSegments + sphere dots, same pattern as test_biter_rig.mjs)
    scene.updateMatrixWorld(true);

    // model is already centered (model.position.sub(center) above + updateMatrixWorld),
    // so getWorldPosition returns centered coordinates — no further offset needed
    const linePts = [];
    allBones.forEach(b => {
      if (b.parent && b.parent.isBone) {
        const p1 = new THREE.Vector3(); b.parent.getWorldPosition(p1);
        const p2 = new THREE.Vector3(); b.getWorldPosition(p2);
        linePts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
    const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ff44, depthTest: false }));

    const sphereGeo = new THREE.SphereGeometry(0.03, 6, 6);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, depthTest: false });
    const dots = [];
    allBones.forEach(b => {
      const wp = new THREE.Vector3(); b.getWorldPosition(wp);
      const m = new THREE.Mesh(sphereGeo, sphereMat);
      m.position.copy(wp);
      dots.push(m);
    });

    const boneOverlayGroup = new THREE.Group();
    boneOverlayGroup.add(lines);
    dots.forEach(d => boneOverlayGroup.add(d));
    boneOverlayGroup.visible = false;
    scene.add(boneOverlayGroup);
    window.__boneOverlay = boneOverlayGroup;
    window.__skeleton    = [boneOverlayGroup];

    // animation
    if (gltf.animations && gltf.animations.length > 0) {
      const clip   = gltf.animations[0];
      const mixer  = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(clip);
      action.play();
      mixer.setTime(0);
      window.__mixer    = mixer;
      window.__animClip = clip;
      console.log('clip: ' + clip.name + ' duration: ' + clip.duration.toFixed(2) + 's');
    } else {
      console.log('WARNING: no animation clips found in GLB');
    }

    window.__model = model;
    resolve();
  }, reject);
});

window.__ready = true;
</script></body></html>`);

await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
await page.evaluate(b => window.loadGLB(b), glbBase64);

console.log('Rendering diagnostic frames...');

await renderView(page, 0,           true,  'tpose_front_bones');
await renderView(page, Math.PI / 2, true,  'tpose_side_bones');

const NUM_FRAMES = 8;
for (let f = 0; f < NUM_FRAMES; f++) {
  await renderAnimFrame(page, f, NUM_FRAMES, `walk_frame_${f}`);
}

// side view at frame 0
await page.evaluate(({ fi, nf, rotY }) => {
  const mixer = window.__mixer;
  const clip  = window.__animClip;
  if (mixer && clip) mixer.setTime((fi / nf) * clip.duration);
  window.__model.rotation.y = rotY;
  window.__scene.updateMatrixWorld(true);
}, { fi: 0, nf: NUM_FRAMES, rotY: Math.PI / 2 });
const sideF0 = await page.evaluate(({ size }) => {
  window.__renderer.render(window.__scene, window.__camera);
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  tmp.getContext('2d').drawImage(window.__canvas, 0, 0);
  return tmp.toDataURL('image/png');
}, { size: SIZE });
writeFileSync(`${outDir}/walk_side_f0.png`, Buffer.from(sideF0.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(`  → ${outDir}/walk_side_f0.png`);

await browser.close();
console.log('\nDiagnostic renders saved to ' + outDir + '/');
