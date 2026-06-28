#!/usr/bin/env node
/**
 * Single-command reaper sprite pipeline.
 *
 * Usage: node scripts/rig_reaper.mjs
 *
 * Steps (all automatic):
 *   1. Load models/reaper/rigged.glb
 *   2. Apply rig fixes (strip foot pads, widen collarbones, lock cannon weights)
 *   3. Bake a "Hover" AnimationClip and export models/reaper/animated.glb
 *   4. Run test_rig.mjs → diagnostic renders in reaper-debug/
 *   5. Run render_sprites.mjs → sprites/reaper_sheet.png
 *
 * ── Animation approach ───────────────────────────────────────────────────────
 *
 * Both arms sweep BACKWARD (toward −Z, which is the world backward direction)
 * so the thruster arms drive the reaper forward.
 *
 * Key fix over naive local-Y rotation: shoulder bones have complex bind-pose
 * quaternions, so rotating "local Y" doesn't produce a clean world-space sweep.
 * Instead we convert the desired world-space Y delta to the parent bone's local
 * frame:
 *
 *   localQ = (parentWorldQ_inv · deltaWorld · parentWorldQ) · bindPoseQ
 *
 * At angle=0 this reduces to bindPoseQ exactly, so the arm starts and ends at the
 * natural bind pose and sweeps in the correct direction at the peak.
 *
 * Backward sweep (−Z direction, thrusters push reaper forward):
 *   LeftArm  world Y = +a  (arm at +X sweeps toward −Z)
 *   RightArm world Y = −a  (arm at −X sweeps toward −Z)
 *
 * See test_rig.mjs for full documentation of the rig fixes (foot pad removal,
 * collarbone widening, and cannon weight locking).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const inPath  = resolve('models/reaper/rigged.glb');
const outPath = resolve('models/reaper/animated.glb');
const glbBase64 = readFileSync(inPath).toString('base64');

// Arms sweep between MIN_SWEEP and MAX_SWEEP — never through the bind pose (T-pose).
// MIN_SWEEP is the floor: extrapolating the forearm to the ground at this angle gives
// an aim point behind the spine (Z < 0). The zero crossing is ~17° (computed from
// diagnostic hand positions at ±90°); 30° gives comfortable clearance.
const MIN_SWEEP        = Math.PI / 6;   // 30° — resting backward tilt, aim always behind spine
const MAX_SWEEP        = Math.PI / 4;   // 45° — peak thrust
const DURATION         = 1.0;           // animation length in seconds
const N_FRAMES         = 8;             // internal keyframe count (N+1 for seamless loop)
const COLLARBONE_EXTEND = 0.10;         // units to shift LeftArm/RightArm outward in world X
const HIP_BOB          = 0;             // no baked bob — hover float is applied in JS per-instance

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
page.setDefaultTimeout(120_000);
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

const MIN_SWEEP         = ${MIN_SWEEP};
const MAX_SWEEP         = ${MAX_SWEEP};
const DURATION          = ${DURATION};
const N_FRAMES          = ${N_FRAMES};
const COLLARBONE_EXTEND = ${COLLARBONE_EXTEND};
const HIP_BOB           = ${HIP_BOB};

const LEG_BONES = new Set([
  'LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase',
  'RightUpLeg','RightLeg','RightFoot','RightToeBase'
]);

// Remove triangles whose vertices are predominantly leg-bone influenced (the
// toe-pad geometry Meshy bakes into humanoid rigs), then redistribute any
// remaining partial leg-bone weights to Hips.
function stripLegGeometry(scene) {
  scene.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const skeleton = node.skeleton;
    const boneIdx  = {};
    skeleton.bones.forEach((b, i) => { boneIdx[b.name] = i; });
    const legSet  = new Set([...LEG_BONES].map(n => boneIdx[n]).filter(i => i !== undefined));
    const hipsIdx = boneIdx['Hips'];
    if (hipsIdx === undefined) { console.log('WARN: Hips not found'); return; }

    const sI = node.geometry.attributes.skinIndex;
    const sW = node.geometry.attributes.skinWeight;

    // Pass 1: mark the foot-pad vertices.
    // Diagnostic showed the floating block geometry is 24 verts in model-space Y < 0.15,
    // all 100% weighted to RightFoot. Use Y < 0.20 as the cutoff so we catch both pads
    // without hitting the tentacle mesh (which starts at Y ≈ 0.50+).
    const footPadBones = new Set(
      ['RightFoot','LeftFoot','LeftToeBase','RightToeBase']
        .map(n => boneIdx[n]).filter(i => i !== undefined)
    );
    const pos = node.geometry.attributes.position;
    const isPadVert = new Uint8Array(sI.count);
    for (let v = 0; v < sI.count; v++) {
      if (pos.getY(v) > 0.20) continue;
      let padW = 0;
      for (let s = 0; s < 4; s++) {
        if (footPadBones.has(sI.getComponent(v, s))) padW += sW.getComponent(v, s);
      }
      if (padW > 0.5) isPadVert[v] = 1;
    }

    // Pass 2: rebuild index buffer, dropping triangles where all 3 verts are pad-marked.
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
      console.log('dropped ' + dropped + ' foot-pad triangles from ' + (node.name || 'mesh'));
    }

    // Pass 3: redistribute remaining partial leg weights to Hips.
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

// Push LeftArm/RightArm COLLARBONE_EXTEND units further out in world X.
// Rebinds via calculateInverses() so the rest pose is visually unchanged but the
// shoulder-rotation pivot is now inside the mechanical shoulder mass.
function widenCollarbones(scene, bones) {
  scene.updateMatrixWorld(true);
  [['LeftArm', +1], ['RightArm', -1]].forEach(([name, sign]) => {
    const bone = bones[name];
    if (!bone) return;
    const inv         = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
    const worldOrigin = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
    const worldTarget = new THREE.Vector3(sign * COLLARBONE_EXTEND, 0, 0).applyMatrix4(inv);
    bone.position.add(worldTarget.sub(worldOrigin));
  });
  scene.updateMatrixWorld(true);
  // calculateInverses() is THREE.js's built-in rebind — sets boneInverses[i] = inv(bones[i].matrixWorld).
  scene.traverse(node => {
    if (!node.isSkinnedMesh) return;
    node.skeleton.calculateInverses();
  });
  const lPos = new THREE.Vector3(); bones['LeftArm'].getWorldPosition(lPos);
  console.log('LeftArm world X after widen: ' + lPos.x.toFixed(3));
}

// Re-weight the shoulder-mounted cannon so it never rotates with the arm.
// Identifies cannon vertices by position (character's right side, shoulder height,
// not too far outward, not behind the body) and transfers RightArm/RightForeArm/RightHand
// weight to RightShoulder, which is not animated.
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

window.__run = () => new Promise((resolve, reject) => {
  const bytes = new Uint8Array(atob(window.__glb).split('').map(c => c.charCodeAt(0)));

  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    const scene = gltf.scene;

    // collect bones
    const bones = {};
    scene.traverse(n => { if (n.isBone) bones[n.name] = n; });
    console.log('bones found:', Object.keys(bones).length);

    // strip mis-wired leg bones before building the animation
    stripLegGeometry(scene);

    // widen collarbones so shoulder pivot is inside the mechanical arm assembly
    widenCollarbones(scene, bones);

    // lock cannon to RightShoulder so it doesn't rotate with the arm sweep
    fixCannonWeights(scene);

    const lArm = bones['LeftArm'];
    const rArm = bones['RightArm'];
    if (!lArm) { reject(new Error('LeftArm not found')); return; }
    if (!rArm) { reject(new Error('RightArm not found')); return; }

    // Store bind-pose quaternions AFTER widenCollarbones (positions changed, quaternions unchanged).
    // Pivot is now at LeftArm (now at ~X=0.41, inside the mechanical shoulder mass).
    // LeftShoulder stays at bind pose; only LeftArm+ForeArm+Hand sweep backward.
    const lArmBindQ     = lArm.quaternion.clone();
    const rArmBindQ     = rArm.quaternion.clone();
    const lForeArmBindQ = bones['LeftForeArm']  ? bones['LeftForeArm'].quaternion.clone()  : new THREE.Quaternion();
    const lHandBindQ    = bones['LeftHand']     ? bones['LeftHand'].quaternion.clone()     : new THREE.Quaternion();
    const rForeArmBindQ = bones['RightForeArm'] ? bones['RightForeArm'].quaternion.clone() : new THREE.Quaternion();
    const rHandBindQ    = bones['RightHand']    ? bones['RightHand'].quaternion.clone()    : new THREE.Quaternion();
    const IDENTITY      = new THREE.Quaternion();

    // Parent world quaternion for LeftArm = LeftShoulder world Q.
    scene.updateMatrixWorld(true);
    const lParentWorldQ    = new THREE.Quaternion();
    const rParentWorldQ    = new THREE.Quaternion();
    lArm.parent.getWorldQuaternion(lParentWorldQ);
    rArm.parent.getWorldQuaternion(rParentWorldQ);
    const lParentWorldQInv = lParentWorldQ.clone().invert();
    const rParentWorldQInv = rParentWorldQ.clone().invert();

    // N_FRAMES+1 keyframes so t=0 and t=1 both map to the same angle (seamless loop).
    const times = Array.from({ length: N_FRAMES + 1 }, (_, i) => i / N_FRAMES * DURATION);

    // Arms sweep from MIN_SWEEP (resting backward tilt) to MAX_SWEEP (peak thrust) and back.
    // Never passes through bind pose — aim always stays behind the spine.
    const angles = times.map(t => MIN_SWEEP + (MAX_SWEEP - MIN_SWEEP) * Math.sin(t / DURATION * Math.PI));

    // LeftArm/RightArm: world-space Y rotation applied in parent (LeftShoulder) local frame.
    //   localQ = parentWorldQInv · delta · parentWorldQ · bindQ
    // LeftArm at +X world → worldYSign=+1 sweeps toward −Z.
    // RightArm at −X world → worldYSign=−1 sweeps toward −Z.
    function localQuatForAngle(angle, parentQInv, parentQ, bindQ, worldYSign) {
      const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldYSign * angle, 0));
      return parentQInv.clone().multiply(delta).multiply(parentQ).multiply(bindQ);
    }

    const lArmFlat = angles.flatMap(a => {
      const q = localQuatForAngle(a, lParentWorldQInv, lParentWorldQ, lArmBindQ, +1);
      return [q.x, q.y, q.z, q.w];
    });
    const rArmFlat = angles.flatMap(a => {
      const q = localQuatForAngle(a, rParentWorldQInv, rParentWorldQ, rArmBindQ, -1);
      return [q.x, q.y, q.z, q.w];
    });

    // Verify t=0 matches bind pose exactly.
    const lQ0 = new THREE.Quaternion(lArmFlat[0], lArmFlat[1], lArmFlat[2], lArmFlat[3]);
    console.log('t=0 vs bind dot (should be ≈1.0): ' + lQ0.dot(lArmBindQ).toFixed(6));

    // Forearm/hand: lerp toward identity (straight arm) as shoulder sweeps.
    // Identity local = forearm parallel to arm = no A-pose droop = clean parallel-to-Z sweep.
    const lForeArmFlat = angles.flatMap(a => {
      const q = lForeArmBindQ.clone().slerp(IDENTITY, a / MAX_SWEEP);
      return [q.x, q.y, q.z, q.w];
    });
    const rForeArmFlat = angles.flatMap(a => {
      const q = rForeArmBindQ.clone().slerp(IDENTITY, a / MAX_SWEEP);
      return [q.x, q.y, q.z, q.w];
    });
    const lHandFlat = angles.flatMap(a => {
      const q = lHandBindQ.clone().slerp(IDENTITY, a / MAX_SWEEP);
      return [q.x, q.y, q.z, q.w];
    });
    const rHandFlat = angles.flatMap(a => {
      const q = rHandBindQ.clone().slerp(IDENTITY, a / MAX_SWEEP);
      return [q.x, q.y, q.z, q.w];
    });

    // Hips: whole-body bob — character rises with the thrust peak, giving a natural hover feel.
    // Amplitude = HIP_BOB ≈ one head height so the movement reads clearly at sprite scale.
    const hipsPos = bones['Hips'] ? bones['Hips'].position.clone() : new THREE.Vector3();
    const hipFlat = times.flatMap(t => {
      const rise = Math.sin(t / DURATION * Math.PI) * HIP_BOB;
      return [hipsPos.x, hipsPos.y + rise, hipsPos.z];
    });

    const tracks = [
      new THREE.QuaternionKeyframeTrack('LeftArm.quaternion',      times, lArmFlat),
      new THREE.QuaternionKeyframeTrack('RightArm.quaternion',     times, rArmFlat),
      new THREE.QuaternionKeyframeTrack('LeftForeArm.quaternion',  times, lForeArmFlat),
      new THREE.QuaternionKeyframeTrack('RightForeArm.quaternion', times, rForeArmFlat),
      new THREE.QuaternionKeyframeTrack('LeftHand.quaternion',     times, lHandFlat),
      new THREE.QuaternionKeyframeTrack('RightHand.quaternion',    times, rHandFlat),
      new THREE.VectorKeyframeTrack('Hips.position',               times, hipFlat),
    ];
    const clip = new THREE.AnimationClip('Hover', DURATION, tracks);
    console.log('clip: tracks=' + tracks.length + ' keyframes=' + times.length);

    new GLTFExporter().parse(scene, result => {
      const arr = new Uint8Array(result);
      let str = '';
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
      window.__result = btoa(str);
      console.log('export bytes: ' + arr.length);
      resolve();
    }, reject, { binary: true, animations: [clip] });

  }, reject);
});

window.__threeReady = true;
</script></body></html>`);

await page.waitForFunction(() => window.__threeReady === true, { timeout: 30_000 });
await page.evaluate(g => { window.__glb = g; }, glbBase64);
await page.evaluate(() => window.__run());

const b64 = await page.evaluate(() => window.__result);
await browser.close();

writeFileSync(outPath, Buffer.from(b64, 'base64'));
console.log('\nBaked → ' + outPath);

console.log('\n── debug renders ──');
execFileSync('node', ['scripts/test_rig.mjs'], { stdio: 'inherit' });

console.log('\n── sprite sheet ──');
execFileSync('node', [
  'scripts/render_sprites.mjs',
  'models/reaper/animated.glb', '256', 'sprites/reaper_sheet.png', '8',
], { stdio: 'inherit' });

console.log('\nDone.');
