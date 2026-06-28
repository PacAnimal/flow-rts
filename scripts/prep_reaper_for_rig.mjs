#!/usr/bin/env node
/**
 * Adds two tiny invisible leg-stub meshes below the reaper's body so Meshy's
 * humanoid pose estimator can detect the foot landmarks and accept the model.
 * The stubs are 0.03-unit boxes — invisible at game scale.
 *
 * Output: models/reaper/with_legs.glb
 * Usage:  node scripts/prep_reaper_for_rig.mjs
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const inPath  = resolve('models/reaper/retextured.glb');
const outPath = resolve('models/reaper/with_legs.glb');

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
page.setDefaultTimeout(60_000);
page.on('console', msg => console.log('[browser]', msg.text()));

const glbBase64 = readFileSync(inPath).toString('base64');

await page.setContent(`<!DOCTYPE html><html><body>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

window.__run = () => new Promise((resolve, reject) => {
  const bytes = new Uint8Array(atob(window.__glb).split('').map(c=>c.charCodeAt(0)));
  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    const scene = gltf.scene;

    // bounding box of the loaded scene
    const bbox = new THREE.Box3().setFromObject(scene);
    const bottom = bbox.min.y;  // bottom of the model (where mechanical spine ends)
    const cx = (bbox.min.x + bbox.max.x) / 2;

    // tiny box stubs — just large enough for the pose estimator to treat as feet,
    // small enough to be invisible at 64px game scale
    const stubGeo  = new THREE.BoxGeometry(0.04, 0.18, 0.04);
    const stubMat  = new THREE.MeshStandardMaterial({ color: 0x111111 });

    const leftStub  = new THREE.Mesh(stubGeo, stubMat);
    const rightStub = new THREE.Mesh(stubGeo, stubMat);

    // place stubs below the model, hip-width apart
    leftStub.position.set(cx - 0.13, bottom - 0.09, 0);
    rightStub.position.set(cx + 0.13, bottom - 0.09, 0);
    leftStub.name  = 'leg_stub_L';
    rightStub.name = 'leg_stub_R';

    scene.add(leftStub);
    scene.add(rightStub);

    console.log('Model bottom Y:', bottom.toFixed(3),
                '  stubs at Y:', (bottom - 0.09).toFixed(3));

    new GLTFExporter().parse(scene, result => {
      const arr = new Uint8Array(result);
      let str = '';
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
      window.__result = btoa(str);
      console.log('Export OK:', arr.length, 'bytes');
      resolve();
    }, reject, { binary: true });

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
console.log(`Done → ${outPath}`);
