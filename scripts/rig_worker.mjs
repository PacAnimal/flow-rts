#!/usr/bin/env node
/**
 * Worker debug-render runner.
 *
 * Usage: node scripts/rig_worker.mjs
 *
 * Loads models/worker/animated.glb (produced by gen_worker_model.py's Meshy
 * rigging step), renders diagnostic frames to worker-debug/, then re-renders
 * the sprite sheet.
 *
 * To rebuild the full pipeline (mesh + retexture + rig + render):
 *   .venv/bin/python concepts/gen_worker_model.py
 */

import { execFileSync } from 'child_process';
import { existsSync }   from 'fs';

const animPath = 'models/worker/animated.glb';
if (!existsSync(animPath)) {
  console.error(`Missing ${animPath} — run gen_worker_model.py first.`);
  process.exit(1);
}

console.log('── strip arm tracks ──');
execFileSync('node', ['scripts/strip_worker_arms.mjs'], { stdio: 'inherit' });

console.log('\n── debug renders ──');
execFileSync('node', ['scripts/test_worker_rig.mjs'], { stdio: 'inherit' });

console.log('\n── sprite sheet ──');
execFileSync('node', [
  'scripts/render_sprites.mjs',
  // lower edgeStrength (0.20) and higher hlCompress (0.80) for yellow metal —
  // default 0.55 highlight floor squashes bright yellows to dark orange
  animPath, '256', 'sprites/worker_sheet.png', '8', '1.0', '1.8', '0.9', '0.20', '0.70',
], { stdio: 'inherit' });

console.log('\nDone.');
