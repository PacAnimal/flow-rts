#!/usr/bin/env node
/**
 * Biter sprite pipeline.
 *
 * Usage: node scripts/rig_biter.mjs
 *
 * Builds a custom bear-like quadruped skeleton on models/biter/retextured.glb
 * (bypasses Meshy's humanoid auto-rig entirely), computes proximity-based skinning
 * weights, bakes a diagonal trot AnimationClip, and renders sprites/biter_sheet.png.
 *
 * ── Skeleton layout (15 bones) ───────────────────────────────────────────────
 *
 *   SpineMid (root, body centre) — model faces +Z, head at z≈+1
 *   ├── SpineFront (chest, z=+0.55) — carries Y-twist animation track
 *   │   ├── Head
 *   │   ├── FrontLeftUpper  → FrontLeftLower  → FrontLeftFoot  (leaf)
 *   │   └── FrontRightUpper → FrontRightLower → FrontRightFoot (leaf)
 *   ├── RearLeftUpper  → RearLeftLower  → RearLeftFoot  (leaf)
 *   └── RearRightUpper → RearRightLower → RearRightFoot (leaf)
 *
 * Upper legs: 45° outward + downward from spine endpoint.
 * Lower legs: straight down from knee to foot-level.
 * Foot bones: non-animated leaf nodes that extend the lower-leg segment to
 *             ground level so proximity skinning reaches foot vertices correctly.
 *
 * ── Animation ────────────────────────────────────────────────────────────────
 *
 * Diagonal trot: FL+BR in phase 0, FR+BL in phase π.
 * Upper legs sweep fore/aft around a per-leg sagittal axis
 * (cross of bone direction and forward vector → no lateral spin).
 * Lower legs add a complementary knee bend using the animated parent world Q.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

// source: retextured mesh — Meshy's humanoid rig is discarded entirely
const retexPath   = resolve('models/biter/retextured.glb');
const outPath     = resolve('models/biter/animated.glb');
const retexBase64 = readFileSync(retexPath).toString('base64');

// ── Animation constants ───────────────────────────────────────────────────────
const BONE_FL_UPPER = 'FrontLeftUpper';
const BONE_FL_LOWER = 'FrontLeftLower';
const BONE_FR_UPPER = 'FrontRightUpper';
const BONE_FR_LOWER = 'FrontRightLower';
const BONE_BL_UPPER = 'RearLeftUpper';
const BONE_BL_LOWER = 'RearLeftLower';
const BONE_BR_UPPER = 'RearRightUpper';
const BONE_BR_LOWER = 'RearRightLower';
const BONE_HIPS       = 'SpineMid';
const BONE_SPINE_FRONT = 'SpineFront';

const MAX_SWING  = Math.PI / 9;   // 20° upper leg fore/aft sweep
const KNEE_BEND  = Math.PI / 12;  // 15° lower leg knee complement
const HIP_BOB    = 0.06;          // body bob amplitude (units)
const SPINE_TWIST = Math.PI / 20; // 9° front-body twist with each stride
const DURATION   = 0.8;           // stride duration (seconds)
const N_FRAMES   = 8;             // keyframe count (N+1 for seamless loop)
const BONE_DISCOVERY_ONLY = false;

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
page.setDefaultTimeout(180_000);
page.on('console', msg => console.log('[browser]', msg.text()));

await page.setContent(`<!DOCTYPE html><html><body>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const MAX_SWING   = ${MAX_SWING};
const KNEE_BEND   = ${KNEE_BEND};
const HIP_BOB     = ${HIP_BOB};
const SPINE_TWIST = ${SPINE_TWIST};
const DURATION    = ${DURATION};
const N_FRAMES    = ${N_FRAMES};

const BONE_FL_UPPER    = '${BONE_FL_UPPER}';
const BONE_FL_LOWER    = '${BONE_FL_LOWER}';
const BONE_FR_UPPER    = '${BONE_FR_UPPER}';
const BONE_FR_LOWER    = '${BONE_FR_LOWER}';
const BONE_BL_UPPER    = '${BONE_BL_UPPER}';
const BONE_BL_LOWER    = '${BONE_BL_LOWER}';
const BONE_BR_UPPER    = '${BONE_BR_UPPER}';
const BONE_BR_LOWER    = '${BONE_BR_LOWER}';
const BONE_HIPS        = '${BONE_HIPS}';
const BONE_SPINE_FRONT = '${BONE_SPINE_FRONT}';

// FL+BR are one diagonal (phase 0), FR+BL are the other (phase π).
const LEG_PHASE = { FL: 0, FR: Math.PI, BL: Math.PI, BR: 0 };

// localQ = (parentQInv · delta · parentQ) · bindQ  — same formula as rig_reaper.mjs
function applyWorldRot(axis, angle, parentQInv, parentQ, bindQ) {
  const delta = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  return parentQInv.clone().multiply(delta).multiply(parentQ).multiply(bindQ);
}

function loadGLB(b64) {
  return new Promise((res, rej) => {
    const bytes = new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
    new GLTFLoader().parse(bytes.buffer, '', res, rej);
  });
}

// ── Skeleton definition ───────────────────────────────────────────────────────
// World-space positions calibrated to actual model geometry (bottom-15% vertex scan):
//   Model bounds:    y=-0.950→+0.950, z=-1.000→+1.000, x=-0.584→+0.584
//   Actual feet:     FL(0.357,-0.830,-0.531) FR(-0.352,-0.830,-0.530)
//                    RL(0.403,-0.815, 0.348) RR(-0.399,-0.815, 0.348)
//   Front shoulder:  (0, 0.174, -0.864)   Rear haunch: (0, 0.209, 0.783)
//   Spine top:       (0, 0.760, 0.030)
//
// Spine: SpineMid (root, body centre) → SpineFront (front section).
// SpineFront carries a Y-twist track so the front body counter-rotates
// with each stride. Upper leg bones originate at their spine joint;
// 45° outward+down to knee. Lower legs mostly straight down to claw.
// Model faces +Z: head at z≈+1.0, haunches at z≈-1.0.
// Foot centroids from bottom-15% vertex scan:
//   z>0 (head side): L=(0.403,-0.815,+0.348)  R=(-0.399,-0.815,+0.348)
//   z<0 (haunch side): L=(0.357,-0.830,-0.531)  R=(-0.352,-0.830,-0.530)
const BONE_WORLD_POS = {
  SpineMid:        [ 0.000,  0.300,  0.000],  // body centre root; rear legs branch here
  SpineFront:      [ 0.000,  0.300,  0.550],  // toward head (+Z); carries stride twist
  // head droops steeply — maw hangs far below the neck joint
  Head:            [ 0.000, -0.300,  0.900],
  FrontLeftUpper:  [ 0.000,  0.300,  0.550],
  // upper front leg arches backward (z: 0.55→0.20) — heavy-quadruped elbow
  FrontLeftLower:  [ 0.350, -0.300,  0.200],
  FrontLeftFoot:   [ 0.400, -0.820,  0.350],  // head-side foot (z>0 scan)
  FrontRightUpper: [ 0.000,  0.300,  0.550],
  FrontRightLower: [-0.350, -0.300,  0.200],
  FrontRightFoot:  [-0.400, -0.820,  0.350],
  RearLeftUpper:   [ 0.000,  0.100, -0.700],  // haunches side (-Z); moved back and down
  RearLeftLower:   [ 0.400, -0.300, -0.600],
  RearLeftFoot:    [ 0.360, -0.830, -0.530],  // haunch-side foot (z<0 scan)
  RearRightUpper:  [ 0.000,  0.100, -0.700],
  RearRightLower:  [-0.400, -0.300, -0.600],
  RearRightFoot:   [-0.360, -0.830, -0.530],
};

// parent → [children]
const BONE_HIERARCHY = {
  SpineMid:        ['SpineFront', 'RearLeftUpper', 'RearRightUpper'],
  SpineFront:      ['Head', 'FrontLeftUpper', 'FrontRightUpper'],
  FrontLeftUpper:  ['FrontLeftLower'],
  FrontLeftLower:  ['FrontLeftFoot'],
  FrontRightUpper: ['FrontRightLower'],
  FrontRightLower: ['FrontRightFoot'],
  RearLeftUpper:   ['RearLeftLower'],
  RearLeftLower:   ['RearLeftFoot'],
  RearRightUpper:  ['RearRightLower'],
  RearRightLower:  ['RearRightFoot'],
};

// Build the custom skeleton, replace plain Mesh nodes with SkinnedMesh, bind.
function buildSkeleton(scene) {
  // strip any pre-existing bones from the loaded scene (e.g. Meshy's rig)
  const oldBones = [];
  scene.traverse(n => { if (n.isBone) oldBones.push(n); });
  oldBones.forEach(b => { if (b.parent) b.parent.remove(b); });
  if (oldBones.length) console.log('stripped ' + oldBones.length + ' existing bones');

  // create bones
  const bones = {};
  for (const name of Object.keys(BONE_WORLD_POS)) {
    const b = new THREE.Bone(); b.name = name; bones[name] = b;
  }
  // wire parent-child
  for (const [parent, children] of Object.entries(BONE_HIERARCHY)) {
    for (const child of children) bones[parent].add(bones[child]);
  }
  // set local positions top-down (all quaternions stay identity)
  // local = world - parentWorld (since no rotation anywhere in the chain)
  function setPositions(bone) {
    const wp = BONE_WORLD_POS[bone.name];
    if (wp) {
      const pw = (bone.parent && bone.parent.isBone) ? (BONE_WORLD_POS[bone.parent.name] || [0,0,0]) : [0,0,0];
      bone.position.set(wp[0]-pw[0], wp[1]-pw[1], wp[2]-pw[2]);
    }
    bone.children.filter(c => c.isBone).forEach(setPositions);
  }
  setPositions(bones['SpineMid']);
  scene.add(bones['SpineMid']);
  scene.updateMatrixWorld(true);

  // flat pre-order bone array — index = boneIndex used in skinIndex attributes
  const boneArray = [];
  function collectBones(bone) { boneArray.push(bone); bone.children.filter(c => c.isBone).forEach(collectBones); }
  collectBones(bones['SpineMid']);

  // replace every Mesh/SkinnedMesh with a fresh SkinnedMesh bound to our skeleton
  const meshNodes = [];
  scene.traverse(n => { if (n.isMesh) meshNodes.push(n); });

  for (const mesh of meshNodes) {
    const count = mesh.geometry.attributes.position.count;
    // placeholder skinning: all to root bone; recomputeSkinning will replace this
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) sw[v * 4] = 1.0;
    mesh.geometry.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(si, 4));
    mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));

    const sm = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
    sm.name = mesh.name || 'biter';
    sm.position.copy(mesh.position);
    sm.quaternion.copy(mesh.quaternion);
    sm.scale.copy(mesh.scale);
    if (mesh.parent) { mesh.parent.add(sm); mesh.parent.remove(mesh); }

    const skeleton = new THREE.Skeleton(boneArray);
    sm.bind(skeleton);
    console.log('SkinnedMesh bound: ' + sm.name + ' (' + count + ' verts)');
  }

  return { bones, boneArray };
}

// Recompute skinning weights using Gaussian distance-to-bone-segment falloff.
// Each vertex gets up to 4 influences from the nearest bone segments.
function recomputeSkinning(scene, boneArray) {
  const boneWP = boneArray.map(b => { const p = new THREE.Vector3(); b.getWorldPosition(p); return p; });

  // precompute segments per bone (bone head → each child bone head)
  const segsPerBone = boneArray.map(() => []);
  boneArray.forEach((bone, bi) => {
    bone.children.filter(c => c.isBone).forEach(child => {
      const cp = new THREE.Vector3(); child.getWorldPosition(cp);
      segsPerBone[bi].push({ p1: boneWP[bi].clone(), p2: cp.clone() });
    });
  });

  function distToBone(bi, p) {
    const segs = segsPerBone[bi];
    if (!segs.length) return p.distanceTo(boneWP[bi]);
    let minD = Infinity;
    for (const { p1, p2 } of segs) {
      const abx = p2.x-p1.x, aby = p2.y-p1.y, abz = p2.z-p1.z;
      const len2 = abx*abx + aby*aby + abz*abz;
      const t = len2 < 1e-10 ? 0 : Math.max(0, Math.min(1, ((p.x-p1.x)*abx+(p.y-p1.y)*aby+(p.z-p1.z)*abz)/len2));
      const dx = p.x-(p1.x+abx*t), dy = p.y-(p1.y+aby*t), dz = p.z-(p1.z+abz*t);
      const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (d < minD) minD = d;
    }
    return minD;
  }

  const SIGMA = 0.32; // Gaussian half-radius; model spans ~2m so 32cm gives clean joint boundaries
  const SIGMA2_2 = 2 * SIGMA * SIGMA;
  const B = boneArray.length;
  const tmpV = new THREE.Vector3();

  scene.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const skeleton = node.skeleton;
    const skBoneIdx = {};
    skeleton.bones.forEach((b, i) => { skBoneIdx[b.name] = i; });

    const posAttr = node.geometry.attributes.position;
    const N = posAttr.count;
    const siArr = new Uint16Array(N * 4);
    const swArr = new Float32Array(N * 4);

    // pre-allocate distance scratch
    const dists = new Float32Array(B);

    for (let v = 0; v < N; v++) {
      tmpV.set(posAttr.getX(v), posAttr.getY(v), posAttr.getZ(v)).applyMatrix4(node.matrixWorld);

      for (let bi = 0; bi < B; bi++) dists[bi] = distToBone(bi, tmpV);

      // find 4 nearest via simple sort of indices
      const idx4 = [0,1,2,3];
      for (let bi = 4; bi < B; bi++) {
        let maxIdx = 0;
        for (let s = 1; s < 4; s++) if (dists[idx4[s]] > dists[idx4[maxIdx]]) maxIdx = s;
        if (dists[bi] < dists[idx4[maxIdx]]) idx4[maxIdx] = bi;
      }

      let total = 0;
      const ws = idx4.map(bi => { const w = Math.exp(-(dists[bi]*dists[bi])/SIGMA2_2); total += w; return w; });
      const base = v * 4;
      for (let s = 0; s < 4; s++) {
        siArr[base+s] = skBoneIdx[boneArray[idx4[s]].name] ?? 0;
        swArr[base+s] = total > 0 ? ws[s] / total : 0;
      }
    }

    node.geometry.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(siArr, 4));
    node.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(swArr, 4));
    node.skeleton.calculateInverses();
    console.log('skinning recomputed: ' + N + ' verts, sigma=' + SIGMA + ', bones=' + B);
  });
}

window.__boneLog = null;

window.__run = async () => {
  const retex = await loadGLB(window.__retexGlb);
  const scene  = retex.scene;
  scene.updateMatrixWorld(true);
  console.log('loaded retextured.glb');

  const { bones, boneArray } = buildSkeleton(scene);
  scene.updateMatrixWorld(true);

  console.log('computing skinning weights (' + boneArray.length + ' bones)...');
  recomputeSkinning(scene, boneArray);
  scene.updateMatrixWorld(true);

  // ── Bone discovery log ────────────────────────────────────────────────────
  const boneReport = [];
  for (const [name, bone] of Object.entries(bones)) {
    const wp = new THREE.Vector3(); bone.getWorldPosition(wp);
    const childBoneCount = bone.children.filter(c => c.isBone).length;
    boneReport.push({ name, x: wp.x.toFixed(3), y: wp.y.toFixed(3), z: wp.z.toFixed(3), childBoneCount });
  }
  boneReport.sort((a, b) => parseFloat(b.y) - parseFloat(a.y));
  console.log('=== BONE DISCOVERY (' + boneReport.length + ' bones) ===');
  for (const b of boneReport) {
    console.log('  ' + b.name.padEnd(24) + 'x=' + b.x + ' y=' + b.y + ' z=' + b.z + ' children=' + b.childBoneCount);
  }
  window.__boneLog = boneReport.map(b =>
    b.name.padEnd(24) + 'x=' + b.x + ' y=' + b.y + ' z=' + b.z + ' childBones=' + b.childBoneCount
  ).join('\\n');

  if (${BONE_DISCOVERY_ONLY}) {
    console.log('BONE_DISCOVERY_ONLY=true — exiting without baking animation');
    window.__result = null;
    return;
  }

  // ── Validate required bones ───────────────────────────────────────────────
  const required = {
    FL_UPPER: BONE_FL_UPPER, FL_LOWER: BONE_FL_LOWER,
    FR_UPPER: BONE_FR_UPPER, FR_LOWER: BONE_FR_LOWER,
    BL_UPPER: BONE_BL_UPPER, BL_LOWER: BONE_BL_LOWER,
    BR_UPPER: BONE_BR_UPPER, BR_LOWER: BONE_BR_LOWER,
    HIPS:        BONE_HIPS,
    SPINE_FRONT: BONE_SPINE_FRONT,
  };
  const missing = Object.entries(required).filter(([, n]) => !bones[n]).map(([k, n]) => k + '=' + n);
  if (missing.length) {
    console.log('ERROR: missing bones: ' + missing.join(', '));
    window.__result = null;
    return;
  }

  // ── Store bind-pose quaternions (all identity — skeleton was built at rest) ─
  const bindQ = {};
  for (const [k, name] of Object.entries(required)) bindQ[k] = bones[name].quaternion.clone();

  // ── Parent world quaternions for upper and lower legs ─────────────────────
  const parentInfo = {};
  for (const [k, name] of [
    ['FL_UPPER', BONE_FL_UPPER], ['FR_UPPER', BONE_FR_UPPER],
    ['BL_UPPER', BONE_BL_UPPER], ['BR_UPPER', BONE_BR_UPPER],
    ['FL_LOWER', BONE_FL_LOWER], ['FR_LOWER', BONE_FR_LOWER],
    ['BL_LOWER', BONE_BL_LOWER], ['BR_LOWER', BONE_BR_LOWER],
  ]) {
    const pWorldQ = new THREE.Quaternion(); bones[name].parent.getWorldQuaternion(pWorldQ);
    parentInfo[k] = { pWorldQ, pWorldQInv: pWorldQ.clone().invert() };
  }

  // ── Per-leg sagittal swing axes ───────────────────────────────────────────
  // axis = normalize(cross(bone_dir, forward)) guarantees the rotation sweeps
  // purely fore/aft with no lateral spin component, regardless of the bone angle.
  const BITER_FORWARD = new THREE.Vector3(0, 0, 1);  // model faces +Z (head at z≈+1)

  function sagittalAxis(boneName, childName) {
    const wp1 = new THREE.Vector3(); const wp2 = new THREE.Vector3();
    bones[boneName].getWorldPosition(wp1);
    bones[childName].getWorldPosition(wp2);
    const boneDir = new THREE.Vector3().subVectors(wp2, wp1).normalize();
    if (boneDir.lengthSq() < 0.001) return new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(boneDir, BITER_FORWARD).normalize();
  }

  const swingAxis = {
    FL_UPPER: sagittalAxis(BONE_FL_UPPER, BONE_FL_LOWER),
    FL_LOWER: sagittalAxis(BONE_FL_LOWER, 'FrontLeftFoot'),
    FR_UPPER: sagittalAxis(BONE_FR_UPPER, BONE_FR_LOWER),
    FR_LOWER: sagittalAxis(BONE_FR_LOWER, 'FrontRightFoot'),
    BL_UPPER: sagittalAxis(BONE_BL_UPPER, BONE_BL_LOWER),
    BL_LOWER: sagittalAxis(BONE_BL_LOWER, 'RearLeftFoot'),
    BR_UPPER: sagittalAxis(BONE_BR_UPPER, BONE_BR_LOWER),
    BR_LOWER: sagittalAxis(BONE_BR_LOWER, 'RearRightFoot'),
  };
  console.log('swingAxis FL_UPPER:', JSON.stringify({x:swingAxis.FL_UPPER.x.toFixed(3),y:swingAxis.FL_UPPER.y.toFixed(3),z:swingAxis.FL_UPPER.z.toFixed(3)}));
  console.log('swingAxis BL_UPPER:', JSON.stringify({x:swingAxis.BL_UPPER.x.toFixed(3),y:swingAxis.BL_UPPER.y.toFixed(3),z:swingAxis.BL_UPPER.z.toFixed(3)}));

  // ── Hips position (body bob) ──────────────────────────────────────────────
  const hipsBindPos = bones[BONE_HIPS].position.clone();

  // ── Bake keyframes ────────────────────────────────────────────────────────
  const times = Array.from({ length: N_FRAMES + 1 }, (_, i) => i / N_FRAMES * DURATION);
  const tracks_data = {
    FL_UPPER: [], FL_LOWER: [], FR_UPPER: [], FR_LOWER: [],
    BL_UPPER: [], BL_LOWER: [], BR_UPPER: [], BR_LOWER: [],
    SPINE_FRONT: [],
  };
  const hipsPos_flat = [];
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= N_FRAMES; i++) {
    const globalPhase = (i / N_FRAMES) * 2 * Math.PI;

    // upper legs — main swing
    const upperLocalQ = {};
    for (const [legId, phaseOffset] of Object.entries(LEG_PHASE)) {
      const key = legId + '_UPPER';
      const { pWorldQ, pWorldQInv } = parentInfo[key];
      const angle = MAX_SWING * Math.sin(globalPhase + phaseOffset);
      const q = applyWorldRot(swingAxis[key], angle, pWorldQInv, pWorldQ, bindQ[key]);
      tracks_data[key].push(q.x, q.y, q.z, q.w);
      upperLocalQ[legId] = q;
    }

    // lower legs — knee bend, using animated upper leg as dynamic parent
    for (const [legId, phaseOffset] of Object.entries(LEG_PHASE)) {
      const key = legId + '_LOWER';
      const bendAngle = -KNEE_BEND * Math.max(0, Math.sin(globalPhase + phaseOffset));
      const { pWorldQ: upperParentWorldQ } = parentInfo[legId + '_UPPER'];
      const animParentWorldQ    = upperParentWorldQ.clone().multiply(upperLocalQ[legId]);
      const animParentWorldQInv = animParentWorldQ.clone().invert();
      const q = applyWorldRot(swingAxis[key], bendAngle, animParentWorldQInv, animParentWorldQ, bindQ[key]);
      tracks_data[key].push(q.x, q.y, q.z, q.w);
    }

    // body bob: rises at mid-swing
    const bobY = HIP_BOB * Math.abs(Math.sin(globalPhase));
    hipsPos_flat.push(hipsBindPos.x, hipsBindPos.y + bobY, hipsBindPos.z);

    // spine twist: sin so it peaks at max leg extension (π/2), not at zero crossing
    // FL forward (phase=0, peak at π/2) → +Y twist (front turns left); FR forward → −Y
    const spineQ = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, SPINE_TWIST * Math.sin(globalPhase));
    tracks_data['SPINE_FRONT'].push(spineQ.x, spineQ.y, spineQ.z, spineQ.w);
  }

  const q0_dot = new THREE.Quaternion(
    tracks_data['FL_UPPER'][0], tracks_data['FL_UPPER'][1],
    tracks_data['FL_UPPER'][2], tracks_data['FL_UPPER'][3]
  ).dot(bindQ['FL_UPPER']);
  console.log('t=0 vs bind dot FL_UPPER (should be ≈1.0): ' + q0_dot.toFixed(6));

  // ── Build AnimationClip ───────────────────────────────────────────────────
  const tracks = [
    new THREE.QuaternionKeyframeTrack(BONE_FL_UPPER + '.quaternion', times, tracks_data['FL_UPPER']),
    new THREE.QuaternionKeyframeTrack(BONE_FL_LOWER + '.quaternion', times, tracks_data['FL_LOWER']),
    new THREE.QuaternionKeyframeTrack(BONE_FR_UPPER + '.quaternion', times, tracks_data['FR_UPPER']),
    new THREE.QuaternionKeyframeTrack(BONE_FR_LOWER + '.quaternion', times, tracks_data['FR_LOWER']),
    new THREE.QuaternionKeyframeTrack(BONE_BL_UPPER + '.quaternion', times, tracks_data['BL_UPPER']),
    new THREE.QuaternionKeyframeTrack(BONE_BL_LOWER + '.quaternion', times, tracks_data['BL_LOWER']),
    new THREE.QuaternionKeyframeTrack(BONE_BR_UPPER + '.quaternion', times, tracks_data['BR_UPPER']),
    new THREE.QuaternionKeyframeTrack(BONE_BR_LOWER + '.quaternion', times, tracks_data['BR_LOWER']),
    new THREE.VectorKeyframeTrack(BONE_HIPS + '.position',           times, hipsPos_flat),
    new THREE.QuaternionKeyframeTrack(BONE_SPINE_FRONT + '.quaternion', times, tracks_data['SPINE_FRONT']),
  ];
  const clip = new THREE.AnimationClip('Walk', DURATION, tracks);
  console.log('clip: tracks=' + tracks.length + ' keyframes=' + times.length + ' duration=' + DURATION + 's');

  await new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, result => {
      const arr = new Uint8Array(result);
      let str = '';
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
      window.__result = btoa(str);
      console.log('export bytes: ' + arr.length);
      resolve();
    }, reject, { binary: true, animations: [clip] });
  });
};

window.__threeReady = true;
</script></body></html>`);

await page.waitForFunction(() => window.__threeReady === true, { timeout: 30_000 });
await page.evaluate(g => { window.__retexGlb = g; }, retexBase64);
await page.evaluate(() => window.__run());

const boneLog = await page.evaluate(() => window.__boneLog);
const b64     = await page.evaluate(() => window.__result);
await browser.close();

mkdirSync('biter-debug', { recursive: true });
if (boneLog) writeFileSync('biter-debug/bones.txt', boneLog);
console.log('\nBone log → biter-debug/bones.txt');

if (!b64) {
  console.log('\nNo animated.glb exported — check errors above.');
  process.exit(1);
}

writeFileSync(outPath, Buffer.from(b64, 'base64'));
console.log('Baked → ' + outPath);

console.log('\n── debug renders ──');
execFileSync('node', ['scripts/test_biter_rig.mjs'], { stdio: 'inherit' });

console.log('\n── sprite sheet ──');
// cycleRange=1.0: our baked Walk clip is exactly one stride
execFileSync('node', [
  'scripts/render_sprites.mjs',
  'models/biter/animated.glb', '256', 'sprites/biter_sheet.png', '8', '1.0', '3.0', '2.0',
], { stdio: 'inherit' });

console.log('\nDone.');
