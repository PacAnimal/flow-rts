#!/usr/bin/env node
/**
 * Diagnostic renderer for the biter rig.
 * Outputs debug renders to biter-debug/ for inspecting bone weights and animation.
 *
 * Run standalone:  node scripts/test_biter_rig.mjs
 * Or via pipeline: node scripts/rig_biter.mjs  (calls this automatically)
 *
 * ── Research notes ────────────────────────────────────────────────────────────
 *
 * 1. QUADRUPED RIG NAMING
 *    Meshy's quadruped Auto-Rig does not use standardised bone names. Run
 *    rig_biter.mjs with BONE_DISCOVERY_ONLY=true to print all bones + world
 *    positions, then update the BONE_* constants to match.
 *
 *    Common patterns:
 *      Humanoid-style  : LeftUpLeg/LeftLeg/LeftFoot + LeftArm/LeftForeArm
 *      Animal-style    : FrontLeft_Thigh/FrontLeft_Shin/FrontLeft_Foot
 *      Indexed         : Leg1/Leg2/Leg3/Leg4
 *
 * 2. BODY ORIENTATION
 *    Meshy typically exports quadrupeds facing +Z. Front legs should have
 *    world Z > 0 (body center) and back legs Z < 0. Left legs have X > 0,
 *    right legs X < 0. Verify in the tpose_bones.png render.
 *
 * 3. DIAGONAL TROT PHASING
 *    FL + BR move in sync (phase 0); FR + BL move in sync (phase π).
 *    At frame 0 the FL and BR legs are fully forward; FR and BL are fully back.
 *    If it looks wrong, swap FL↔FR or BL↔BR in rig_biter.mjs constants.
 *
 * 4. KNEE BEND DIRECTION
 *    The lower leg bend uses world −X rotation. If knees bend the wrong way
 *    (outward or backward), negate the bendAngle sign in rig_biter.mjs.
 *
 * 5. SCALE / GROUND PLANE
 *    The biter is a large quadruped — its feet should rest near Y=0 in model
 *    space. If it floats or clips below the floor, the model's scale or origin
 *    is off. Check tpose_bones.png for the foot positions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const SIZE   = 512;
const outDir = 'biter-debug';
mkdirSync(outDir, { recursive: true });

async function renderView(page, rotY, boneMode, label) {
  const png = await page.evaluate(
    ({ rotY, boneMode, size }) => {
      const canvas = document.getElementById('c');
      const renderer = window.__renderer;
      const scene    = window.__scene;
      const camera   = window.__camera;
      const model    = window.__model;
      const skeleton = window.__skeleton;

      model.rotation.set(0, rotY, 0);
      // rotate overlay with the model so bones align with anatomy in debug renders
      if (window.__boneOverlay) window.__boneOverlay.rotation.set(0, rotY, 0);
      scene.updateMatrixWorld(true);

      if (boneMode) {
        skeleton.forEach(h => { h.visible = true; });
      }
      renderer.render(scene, camera);
      if (boneMode) {
        skeleton.forEach(h => { h.visible = false; });
      }

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
      const canvas   = window.__canvas;
      const renderer = window.__renderer;
      const scene    = window.__scene;
      const camera   = window.__camera;
      const model    = window.__model;
      const mixer    = window.__mixer;
      const clip     = window.__animClip;

      if (mixer && clip) {
        const t = (fi / nf) * clip.duration;
        mixer.setTime(t);
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

const glbPath   = resolve('models/biter/animated.glb');
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
const dir = new THREE.DirectionalLight(0xffc080, 1.4);
dir.position.set(3, 5, 4);
scene.add(dir);

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

    // measure raw bounding box BEFORE centering
    const rawBox  = new THREE.Box3().setFromObject(model);
    const rawMin  = rawBox.min; const rawMax = rawBox.max;
    const rawSize = rawBox.getSize(new THREE.Vector3());
    console.log('MESH_BOUNDS min=(' + rawMin.x.toFixed(3) + ',' + rawMin.y.toFixed(3) + ',' + rawMin.z.toFixed(3) + ') max=(' + rawMax.x.toFixed(3) + ',' + rawMax.y.toFixed(3) + ',' + rawMax.z.toFixed(3) + ')');
    console.log('MESH_SIZE x=' + rawSize.x.toFixed(3) + ' y=' + rawSize.y.toFixed(3) + ' z=' + rawSize.z.toFixed(3));

    // scan vertex positions to find extrema for foot / hip / head calibration
    model.traverse(node => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      const pos = node.geometry.attributes.position;
      let minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;
      const frontVertices = [], rearVertices = [], bottomVertices = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (y < 0.12) bottomVertices.push([x, y, z]);
        if (z < rawMin.z + 0.1) frontVertices.push([x, y, z]);
        if (z > rawMax.z - 0.1) rearVertices.push([x, y, z]);
      }
      // centroid of bottom, front, rear clusters
      const centroid = verts => {
        if (!verts.length) return null;
        const c = [0,0,0]; verts.forEach(v => { c[0]+=v[0]; c[1]+=v[1]; c[2]+=v[2]; });
        return c.map(x => (x/verts.length).toFixed(3));
      };
      const bot = centroid(bottomVertices), front = centroid(frontVertices), rear = centroid(rearVertices);
      console.log('VERT_BOTTOM_CENTROID=' + (bot || 'none'));
      console.log('VERT_FRONT_CENTROID=' + (front || 'none'));
      console.log('VERT_REAR_CENTROID=' + (rear || 'none'));
      console.log('VERT_Y_RANGE min=' + minY.toFixed(3) + ' max=' + maxY.toFixed(3));
      console.log('VERT_Z_RANGE min=' + minZ.toFixed(3) + ' max=' + maxZ.toFixed(3));

      // foot cluster scan: use only the bottom 15% of the model (y < minY + 15% of height)
      // to isolate actual claw/toe tips rather than averaging over the whole lower body
      const footYThresh = minY + (maxY - minY) * 0.15;
      console.log('FOOT_Y_THRESH=' + footYThresh.toFixed(3) + ' (bottom 15% of model)');
      const midZ = (rawMin.z + rawMax.z) / 2;
      const allVerts = [];
      for (let i = 0; i < pos.count; i++) allVerts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      const flFoot = allVerts.filter(v => v[1] < footYThresh && v[0] >  0.1 && v[2] < midZ);
      const frFoot = allVerts.filter(v => v[1] < footYThresh && v[0] < -0.1 && v[2] < midZ);
      const rlFoot = allVerts.filter(v => v[1] < footYThresh && v[0] >  0.1 && v[2] > midZ);
      const rrFoot = allVerts.filter(v => v[1] < footYThresh && v[0] < -0.1 && v[2] > midZ);
      console.log('FL_FOOT=' + (centroid(flFoot) || 'none') + '  FR_FOOT=' + (centroid(frFoot) || 'none'));
      console.log('RL_FOOT=' + (centroid(rlFoot) || 'none') + '  RR_FOOT=' + (centroid(rrFoot) || 'none'));
      // also find centroid of the mid-section top vertices as a proxy for spine height
      const spineYThresh = maxY - (maxY - minY) * 0.15;
      const spineMidVerts = allVerts.filter(v => v[1] > spineYThresh && Math.abs(v[0]) < 0.15);
      console.log('SPINE_TOP_CENTROID=' + (centroid(spineMidVerts) || 'none') + ' (top-15%, center X)');
      // front shoulder area: top of front leg attachment
      const frontShoulderV = allVerts.filter(v => v[2] < midZ && v[1] > 0 && v[1] < 0.4 && Math.abs(v[0]) < 0.15);
      console.log('FRONT_SHOULDER_APPROX=' + (centroid(frontShoulderV) || 'none'));
      const rearHaunchV = allVerts.filter(v => v[2] > midZ && v[1] > 0 && v[1] < 0.4 && Math.abs(v[0]) < 0.15);
      console.log('REAR_HAUNCH_APPROX=' + (centroid(rearHaunchV) || 'none'));
    });

    // log all bones with world positions
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
    const dist   = (maxDim / 2) / Math.tan(fov / 2) * 1.5;
    camera.position.set(0, dist * 0.3, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    // explicit bone overlay — SkeletonHelper silently drops zero-length segments
    // (upper leg bones co-located with spine pivot), so we draw manually:
    // spheres at each bone + lines from parent to child.
    scene.updateMatrixWorld(true);

    // line segments: parent world pos → child world pos
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

    // spheres at each bone joint (0.05m radius for a ~2m model)
    const sphereGeo = new THREE.SphereGeometry(0.05, 6, 6);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, depthTest: false });
    const dots = [];
    allBones.forEach(b => {
      const wp = new THREE.Vector3(); b.getWorldPosition(wp);
      const m = new THREE.Mesh(sphereGeo, sphereMat);
      m.position.copy(wp);
      dots.push(m);
    });

    // wrap in a group so renderView can rotate it alongside the model
    const boneOverlayGroup = new THREE.Group();
    boneOverlayGroup.add(lines);
    dots.forEach(d => boneOverlayGroup.add(d));
    boneOverlayGroup.visible = false;
    scene.add(boneOverlayGroup);
    window.__boneOverlay = boneOverlayGroup;
    window.__skeleton = [boneOverlayGroup];

    // animation
    if (gltf.animations && gltf.animations.length > 0) {
      const clip   = gltf.animations[0];
      const mixer  = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(clip);
      action.play();
      mixer.setTime(0);
      window.__mixer    = mixer;
      window.__animClip = clip;
      console.log('clip:', clip.name, 'duration:', clip.duration.toFixed(2) + 's');
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

// T-pose views with bones overlay
await renderView(page, 0,                  true,  'tpose_front_bones');
await renderView(page, Math.PI / 2,        true,  'tpose_side_bones');

// animation frames (8 frames of the walk cycle, front view)
const NUM_FRAMES = 8;
for (let f = 0; f < NUM_FRAMES; f++) {
  await renderAnimFrame(page, f, NUM_FRAMES, `walk_frame_${f}`);
}

// side view of frame 0
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
