#!/usr/bin/env node
/**
 * Strips arm/hand/shoulder animation tracks from models/worker/animated.glb.
 *
 * The Meshy walking rig drives the arms in a human bipedal swing (opposite
 * legs). A heavy industrial mech with massive claw arms should keep them rigid.
 * This script removes the relevant QuaternionKeyframeTrack entries and re-exports
 * the GLB in-place so the subsequent sprite render gets locked arms.
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const glbPath = resolve('models/worker/animated.glb');
const b64     = readFileSync(glbPath).toString('base64');

// bone names whose animation tracks to remove — all arm/shoulder/hand bones
const STRIP_BONES = [
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
];

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
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const STRIP = new Set(${JSON.stringify(STRIP_BONES)});

window.__run = async (b64) => {
  const bytes = new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().parse(bytes.buffer, '', res, rej));

  const scene = gltf.scene;
  const clips = gltf.animations;
  console.log('clips: ' + clips.length + ' total tracks: ' + clips.reduce((n, c) => n + c.tracks.length, 0));

  const stripped = clips.map(clip => {
    const before = clip.tracks.length;
    // track names are like "LeftArm.quaternion" or "Armature|LeftArm.quaternion"
    clip.tracks = clip.tracks.filter(t => {
      const boneName = t.name.split('|').pop().split('.')[0];
      return !STRIP.has(boneName);
    });
    const after = clip.tracks.length;
    if (before !== after) console.log('clip "' + clip.name + '": removed ' + (before - after) + ' tracks (' + after + ' remain)');
    return clip;
  });

  const result = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, data => {
      const arr = new Uint8Array(data);
      let str = '';
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
      res(btoa(str));
    }, rej, { binary: true, animations: stripped }));

  return result;
};

window.__ready = true;
</script></body></html>`);

await page.waitForFunction(() => window.__ready, { timeout: 30_000 });
const out = await page.evaluate(b => window.__run(b), b64);
await browser.close();

writeFileSync(glbPath, Buffer.from(out, 'base64'));
console.log('Arm tracks stripped → ' + glbPath);
