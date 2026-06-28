#!/usr/bin/env node
/**
 * Diagnostic renderer — 4 views with skeleton overlaid on the mesh.
 * Called automatically by rig_reaper.mjs; run standalone to inspect rig quality.
 *
 * Outputs to reaper-debug/ (created if missing):
 *   tpose_bones.png      — front view, bind pose
 *   side_bones.png       — side view from -X, bind pose
 *   diag_arms_fwd.png    — 45° front-left, arms swept forward (+Z)
 *   diag_arms_bwd.png    — 45° front-left, arms swept backward (−Z, thruster direction)
 *
 * ── Reaper rig notes ────────────────────────────────────────────────────────
 *
 * Model source: Meshy pre-rigged reaper (models/reaper/rigged.glb).
 * Meshy outputs a standard humanoid skeleton. Several fixes are needed:
 *
 * 1. FOOT PADS (stripLegGeometry)
 *    Meshy bakes small geometry blocks onto the foot bones (ground collision pads).
 *    The reaper hovers — no legs, no pads. We identify them as vertices at Y < 0.20
 *    with dominant foot-bone weight, drop those triangles from the index buffer, and
 *    redistribute any remaining partial leg-bone weights to Hips so nothing floats.
 *
 * 2. COLLARBONE PIVOT (widenCollarbones)
 *    Meshy places LeftArm/RightArm at the clavicle midpoint — fine for a human, but
 *    the reaper's shoulder mass is much wider (mechanical cylinder hardware). Rotating
 *    at the stock pivot makes the arm appear to swing around empty air.
 *    Fix: shift LeftArm/RightArm outward by COLLARBONE_EXTEND = 0.10 world units.
 *    This puts the pivot inside the shoulder cylinder. After shifting, we call
 *    skeleton.calculateInverses() to rebind — this MUST happen BEFORE centering the
 *    model root, because calculateInverses bakes bone.matrixWorld which must still be
 *    in the GLTF-node coordinate frame (the GLTF node has a Y-offset from origin).
 *    If you call it after model.position.sub(ctr), the centering ends up double-counted
 *    and the mesh renders at the wrong position. Center AFTER rebinding.
 *    Conversion formula (world delta → parent-local):
 *      inv = parent.matrixWorld.invert()
 *      bone.position += (inv * worldTarget) − (inv * worldOrigin)
 *
 * 3. CANNON LOCK (fixCannonWeights)
 *    The shoulder-mounted cannon is on the character's right side (−X in world space).
 *    Meshy assigned partial weight to RightArm/RightForeArm/RightHand in this area,
 *    which causes the cannon to partially rotate during the arm sweep.
 *    Fix: in the cannon zone (−0.06 > x > −0.32, y > 1.15, z > −0.15) transfer any
 *    RightArm/RightForeArm/RightHand weight to RightShoulder. RightShoulder is not
 *    animated and holds the cannon in bind-pose orientation regardless of arm angle.
 *    The threshold x > −0.32 excludes the arm cylinder (which starts near x = −0.29
 *    after widening and extends further out) so the arm still sweeps correctly.
 *
 * 4. THRUSTER FLAMES
 *    The blue ice/flame effect comes from Meshy's material — it bakes a specular-heavy
 *    translucent material onto the thruster geometry. render_sprites.mjs preserves this
 *    by loading the GLB with embedded materials and using SRGBColorSpace output.
 *    Do NOT override materials on the loaded model or the flames will go grey.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const glbBase64 = readFileSync(resolve('models/reaper/rigged.glb')).toString('base64');

const SIZE              = 512;
const COLLARBONE_EXTEND = 0.10;
const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
page.setDefaultTimeout(120_000);
page.on('console', msg => console.log('[browser]', msg.text()));
await page.setViewportSize({ width: SIZE, height: SIZE });

await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${SIZE}" height="${SIZE}" style="display:block"></canvas>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SIZE              = ${SIZE};
const COLLARBONE_EXTEND = ${COLLARBONE_EXTEND};
const LEG_BONES = new Set([
  'LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase',
  'RightUpLeg','RightLeg','RightFoot','RightToeBase'
]);

// Push LeftArm/RightArm outward so the shoulder-rotation pivot sits inside the
// mechanical shoulder mass. Rebinds the skeleton at the new pose so rest pose is unchanged.
// Push LeftArm/RightArm outward so the shoulder-rotation pivot sits inside the
// mechanical shoulder mass. Must be called BEFORE centering the model so that
// calculateInverses() operates in the same coordinate frame as the original GLTF
// boneInverses (which encode the mesh's GLTF-node offset). After centering, the
// boneInverses remain valid — the centering is absorbed by mesh.matrixWorld exactly
// as it was before widening.
function widenCollarbones(model, bones) {
  model.updateMatrixWorld(true);
  [['LeftArm', +1], ['RightArm', -1]].forEach(([name, sign]) => {
    const bone = bones[name];
    if (!bone) return;
    const inv         = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
    const worldOrigin = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
    const worldTarget = new THREE.Vector3(sign * COLLARBONE_EXTEND, 0, 0).applyMatrix4(inv);
    bone.position.add(worldTarget.sub(worldOrigin));
  });
  model.updateMatrixWorld(true);
  model.traverse(node => {
    if (!node.isSkinnedMesh) return;
    node.skeleton.calculateInverses();
  });
  const lPos = new THREE.Vector3(); bones['LeftArm'].getWorldPosition(lPos);
  console.log('LeftArm world X after widen: ' + lPos.x.toFixed(3));
}

const canvas   = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x111122, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffd0a0, 2.0);
key.position.set(3, 4, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0x4466ff, 0.8);
rim.position.set(-4, 2, -3); scene.add(rim);
const back = new THREE.DirectionalLight(0xaabbff, 0.4);
back.position.set(0, 1, -4); scene.add(back);

let model, bones = {}, bindPose = {}, boneViz = null;

function snap() {
  renderer.render(scene, camera);
  const tmp = document.createElement('canvas');
  tmp.width = SIZE; tmp.height = SIZE;
  tmp.getContext('2d').drawImage(canvas, 0, 0);
  return tmp.toDataURL().replace(/^data:[^,]+,/, '');
}

function setCam(x, y, z, fov = 40) {
  camera.fov = fov; camera.updateProjectionMatrix();
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
}

function resetBones() {
  for (const [k, q] of Object.entries(bindPose)) {
    if (bones[k]) bones[k].quaternion.copy(q);
  }
  model.updateMatrixWorld(true);
  rebuildBoneViz();
}

// Rotate LeftArm/RightArm around world Y — pivot is now inside the mechanical shoulder
// (because widenCollarbones moved it outward). Uses world-space formula with LeftShoulder
// as the parent frame, same as rig_reaper.mjs.
function armWorldY(side, worldAngle) {
  const bone = bones[side + 'Arm'];
  if (!bone) return;
  bone.quaternion.copy(bindPose[side + 'Arm']);
  model.updateMatrixWorld(true);
  const parentQ = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentQ);
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldAngle, 0));
  bone.quaternion.copy(
    parentQ.clone().invert().multiply(delta).multiply(parentQ)
  ).multiply(bindPose[side + 'Arm']);
  model.updateMatrixWorld(true);
  rebuildBoneViz();
}

// Straighten forearm + hand (identity local = parallel to parent = no A-pose droop).
function straightenArm(side) {
  const forearm = bones[side + 'ForeArm'];
  const hand    = bones[side + 'Hand'];
  if (forearm) forearm.quaternion.set(0, 0, 0, 1);
  if (hand)    hand.quaternion.set(0, 0, 0, 1);
  model.updateMatrixWorld(true);
  rebuildBoneViz();
}

function rebuildBoneViz() {
  if (boneViz) { scene.remove(boneViz); boneViz.geometry.dispose(); }
  const positions = [], colors = [];
  model.traverse(n => {
    if (!n.isBone || !n.parent || !n.parent.isBone) return;
    // hide leg bones — their geometry is stripped from the mesh
    if (LEG_BONES.has(n.name) || LEG_BONES.has(n.parent.name)) return;
    const p = new THREE.Vector3(), c = new THREE.Vector3();
    n.parent.getWorldPosition(p); n.getWorldPosition(c);
    positions.push(p.x, p.y, p.z, c.x, c.y, c.z);
    const col = n.name.includes('Left')
      ? [0.1, 1.0, 0.4]
      : n.name.includes('Right') ? [0.2, 0.6, 1.0]
      : [1.0, 0.6, 0.1];
    colors.push(...col, ...col);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
  boneViz = new THREE.LineSegments(geo,
    new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, linewidth: 3 }));
  scene.add(boneViz);
}

// Strip foot-pad geometry and redistribute leg bone weights to Hips (mirrors rig_reaper.mjs).
function stripLegGeometry(scene) {
  scene.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const skeleton = node.skeleton;
    const boneIdx  = {};
    skeleton.bones.forEach((b, i) => { boneIdx[b.name] = i; });
    const legSet  = new Set([...LEG_BONES].map(n => boneIdx[n]).filter(i => i !== undefined));
    const hipsIdx = boneIdx['Hips'];
    if (hipsIdx === undefined) return;

    const sI = node.geometry.attributes.skinIndex;
    const sW = node.geometry.attributes.skinWeight;
    const pos = node.geometry.attributes.position;

    const footPadBones = new Set(
      ['RightFoot','LeftFoot','LeftToeBase','RightToeBase']
        .map(n => boneIdx[n]).filter(i => i !== undefined)
    );
    const isPadVert = new Uint8Array(sI.count);
    for (let v = 0; v < sI.count; v++) {
      if (pos.getY(v) > 0.20) continue;
      let padW = 0;
      for (let s = 0; s < 4; s++) {
        if (footPadBones.has(sI.getComponent(v, s))) padW += sW.getComponent(v, s);
      }
      if (padW > 0.5) isPadVert[v] = 1;
    }

    const oldIdx = node.geometry.index ? node.geometry.index.array : null;
    if (oldIdx) {
      const keep = [];
      let dropped = 0;
      for (let i = 0; i < oldIdx.length; i += 3) {
        const a = oldIdx[i], b = oldIdx[i+1], c = oldIdx[i+2];
        if (isPadVert[a] && isPadVert[b] && isPadVert[c]) { dropped++; continue; }
        keep.push(a, b, c);
      }
      node.geometry.setIndex(keep);
      console.log('dropped ' + dropped + ' foot-pad triangles');
    }

    for (let v = 0; v < sI.count; v++) {
      const idx = [sI.getX(v), sI.getY(v), sI.getZ(v), sI.getW(v)];
      const wgt = [sW.getX(v), sW.getY(v), sW.getZ(v), sW.getW(v)];
      let legW = 0;
      for (let s = 0; s < 4; s++) {
        if (legSet.has(idx[s])) { legW += wgt[s]; wgt[s] = 0; }
      }
      if (legW > 0) {
        let slot = idx.indexOf(hipsIdx);
        if (slot === -1) slot = wgt.indexOf(0);
        if (slot !== -1) { idx[slot] = hipsIdx; wgt[slot] += legW; }
      }
      const total = wgt[0] + wgt[1] + wgt[2] + wgt[3];
      if (total > 0) for (let s = 0; s < 4; s++) wgt[s] /= total;
      sI.setXYZW(v, idx[0], idx[1], idx[2], idx[3]);
      sW.setXYZW(v, wgt[0], wgt[1], wgt[2], wgt[3]);
    }
    sI.needsUpdate = true;
    sW.needsUpdate = true;
  });
}

// Re-weight the shoulder-mounted cannon so it never rotates with the arm.
// The cannon is on the character's right side (negative X), at shoulder height,
// with its barrel pointing forward (+Z). We identify cannon vertices by position
// and transfer any RightArm/RightForeArm/RightHand weight to RightShoulder,
// which is not animated and so keeps the cannon world-orientation fixed.
// Arm-cylinder vertices further out in -X (x < -0.32) or far behind (z < -0.15)
// are excluded so the arm still sweeps correctly.
function fixCannonWeights(scene) {
  scene.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const skeleton = node.skeleton;
    const boneIdx = {};
    skeleton.bones.forEach((b, i) => { boneIdx[b.name] = i; });
    const rShoulderIdx = boneIdx['RightShoulder'];
    if (rShoulderIdx === undefined) return;
    const armSet = new Set(
      ['RightArm', 'RightForeArm', 'RightHand']
        .map(n => boneIdx[n]).filter(i => i !== undefined)
    );
    const sI  = node.geometry.attributes.skinIndex;
    const sW  = node.geometry.attributes.skinWeight;
    const pos = node.geometry.attributes.position;
    let fixed = 0;
    for (let v = 0; v < sI.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      // cannon zone: right shoulder area, not the far arm cylinder, not the rearmost body
      if (x >= -0.06 || x <= -0.32 || y < 1.15 || z < -0.15) continue;
      const idx = [sI.getX(v), sI.getY(v), sI.getZ(v), sI.getW(v)];
      const wgt = [sW.getX(v), sW.getY(v), sW.getZ(v), sW.getW(v)];
      let moved = 0;
      for (let s = 0; s < 4; s++) {
        if (armSet.has(idx[s])) { moved += wgt[s]; wgt[s] = 0; }
      }
      if (moved === 0) continue;
      let slot = idx.indexOf(rShoulderIdx);
      if (slot === -1) slot = wgt.indexOf(0);
      if (slot !== -1) { idx[slot] = rShoulderIdx; wgt[slot] += moved; }
      sI.setXYZW(v, idx[0], idx[1], idx[2], idx[3]);
      sW.setXYZW(v, wgt[0], wgt[1], wgt[2], wgt[3]);
      fixed++;
    }
    sI.needsUpdate = true; sW.needsUpdate = true;
    console.log('cannon vertices re-weighted: ' + fixed);
  });
}

window.__run = () => new Promise((res, rej) => {
  const bytes = new Uint8Array(atob(window.__glb).split('').map(c => c.charCodeAt(0)));
  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    model = gltf.scene;
    scene.add(model);

    model.traverse(n => {
      if (!n.isBone) return;
      bones[n.name] = n;
      bindPose[n.name] = n.quaternion.clone();
    });

    // Strip and widen BEFORE centering — calculateInverses() inside widenCollarbones must
    // run in the same (un-shifted) coordinate frame as the original GLTF boneInverses.
    stripLegGeometry(model);
    widenCollarbones(model, bones);
    fixCannonWeights(model);

    // Center AFTER the boneInverses are rebaked so the centering offset is carried by
    // mesh.matrixWorld (exactly as it was before widening with the GLTF's own boneInverses).
    const box = new THREE.Box3().setFromObject(model);
    const sz  = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    model.position.sub(ctr);
    model.updateMatrixWorld(true);
    console.log('bbox: ' + sz.x.toFixed(3) + 'x' + sz.y.toFixed(3) + 'x' + sz.z.toFixed(3));
    rebuildBoneViz();

    const results = {};
    const D = 3.0;
    // diagonal camera: 45° between front (+Z) and character's LEFT (+X, gun arm side),
    // with slight elevation so we see depth in the arm sweep
    const Dd = D * 0.707;

    // 1. T-pose front + skeleton
    resetBones();
    setCam(0, 0, D);
    results.tpose_bones = snap();

    // 2. T-pose side (from -X, character forward = right) + skeleton
    resetBones();
    setCam(-D, 0, 0);
    results.side_bones = snap();

    // Camera at front-right of character (-X side + +Z front): from here, arms going +Z
    // (forward) appear to the RIGHT, arms going -Z (backward) appear to the LEFT.
    // Old position was (Dd, 0.3, Dd) which put the camera in the same +Z direction as
    // forward arms → foreshortening made them look like they diverged.
    const diagCam = [-Dd, 0.3, Dd];

    function logHandPositions(label) {
      ['Left','Right'].forEach(side => {
        const hand = bones[side + 'Hand'];
        if (!hand) return;
        const wp = new THREE.Vector3(); hand.getWorldPosition(wp);
        console.log(label + ' ' + side + 'Hand: (' + wp.x.toFixed(3) + ', ' + wp.y.toFixed(3) + ', ' + wp.z.toFixed(3) + ')');
      });
    }

    // 3. Arms forward (+Z): LeftArm worldY = -π/2, RightArm worldY = +π/2
    resetBones();
    armWorldY('Left',  -Math.PI / 2);
    armWorldY('Right',  Math.PI / 2);
    straightenArm('Left'); straightenArm('Right');
    logHandPositions('fwd');
    setCam(...diagCam);
    results.diag_arms_fwd = snap();

    // 4. Arms backward (−Z): LeftArm worldY = +π/2, RightArm worldY = -π/2
    resetBones();
    armWorldY('Left',   Math.PI / 2);
    armWorldY('Right', -Math.PI / 2);
    straightenArm('Left'); straightenArm('Right');
    logHandPositions('bwd');
    setCam(...diagCam);
    results.diag_arms_bwd = snap();

    console.log('done');
    window.__results = results;
    res();
  }, rej);
});

window.__threeReady = true;
</script></body></html>`);

await page.waitForFunction(() => window.__threeReady === true, { timeout: 30_000 });
await page.evaluate(g => { window.__glb = g; }, glbBase64);
await page.evaluate(() => window.__run());

const results = await page.evaluate(() => window.__results);
await browser.close();

const outDir = resolve('reaper-debug');
mkdirSync(outDir, { recursive: true });
for (const [name, b64] of Object.entries(results)) {
  const p = resolve(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(b64, 'base64'));
  console.log('Saved:', p);
}
