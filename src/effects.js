// Attack visual effects — a transient render-layer helper, not game logic. It lives on the
// Phaser side (like the entity sprites) and is driven by MapScene's onAttack callback: the
// CombatSystem decides *that* an attack lands (docs/adr/0012); this only shows it. A unit type
// may name an explicit `attackFx` (the Zapper's lightning, the Tank's heavy cannon shell, the
// Mech's rapid autocannon burst, the Reaper's close-range shotgun spread); otherwise the effect
// falls back to reach — a short reach reads as a melee strike (a three-stripe claw slash at the
// target), a longer reach as a ranged bolt
// (a laser that travels from attacker to target and flashes on impact). Each effect is a
// self-destroying tween over a throwaway Graphics object, so there is no per-frame bookkeeping
// for MapScene to do — fire and forget.

import Phaser from 'phaser';
import { TILE } from './constants.js';
import { FACTION } from './units.js';

// Above unit sprites (depth = y, so < map height in px) but below labels/bars (1e6+).
const EFFECT_DEPTH = 9e5;

// Tint the effect by the attacker's side so a glance reads who is shooting whom.
const FACTION_COLOR = {
  [FACTION.PLAYER]: 0x7df9ff,   // electric blue, matching the flow-label accent
  [FACTION.ENEMY]: 0xff5a4d,    // hostile red
  [FACTION.CRITTER]: 0xffc24d,  // amber
};

export class AttackEffects {
  constructor(scene) {
    this.scene = scene;
  }

  // Aim at a Runner's body centre rather than its feet ({x,y} is the feet position).
  _bodyY(entity) {
    return entity.y - (entity._displaySize || TILE) * 0.45;
  }

  // Entry point: a unit type may name an explicit `attackFx` (e.g. the Zapper's lightning);
  // otherwise the effect is picked from reach (in Tiles) — melee Units sit at range 1.5, so
  // anything reaching ~2+ Tiles reads as a ranged bolt and the rest as a melee slash.
  show(attacker, target, def) {
    const color = FACTION_COLOR[attacker.faction] ?? 0xffffff;
    const tx = target.x, ty = this._bodyY(target);
    if (def?.attackFx === 'lightning') {
      // Always yellow — a lightning arc reads as electricity regardless of side.
      this._lightning(attacker.x, this._bodyY(attacker), tx, ty, 0xffe24d);
    } else if (def?.attackFx === 'cannon') {
      // Kinetic ordnance reads warm, not electric-blue — tint toward orange regardless of side.
      this._cannon(attacker.x, this._bodyY(attacker), tx, ty, 0xff9a3c);
    } else if (def?.attackFx === 'autocannon') {
      this._autocannon(attacker.x, this._bodyY(attacker), tx, ty, color);
    } else if (def?.attackFx === 'shotgun') {
      this._shotgun(attacker.x, this._bodyY(attacker), tx, ty, color);
    } else if ((def?.range || 0) >= 2) {
      this._laser(attacker.x, this._bodyY(attacker), tx, ty, color);
    } else {
      this._slash(tx, ty, color);
    }
  }

  // A jagged lightning arc from attacker to target that crackles (re-jittered each frame) and
  // fades over ~180ms, then sparks on impact. Same soft-glow + white-core look as the laser.
  _lightning(x1, y1, x2, y2, color) {
    const scene = this.scene;
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;                    // perpendicular, to kink the bolt off-axis
    const segs = Math.max(4, Math.round(len / 16));
    const stroke = (pts) => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.strokePath();
    };
    const s = { p: 0 };
    scene.tweens.add({
      targets: s,
      p: 1,
      duration: 180,
      ease: 'Linear',
      onUpdate: () => {
        const alpha = Math.max(0.15, 1 - s.p);
        const amp = 8 * (1 - s.p * 0.5);        // settles as it fades
        const pts = [];
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const j = (i === 0 || i === segs) ? 0 : (Math.random() * 2 - 1) * amp;
          pts.push({ x: x1 + ux * len * t + px * j, y: y1 + uy * len * t + py * j });
        }
        g.clear();
        g.lineStyle(6, color, alpha * 0.25); stroke(pts);   // soft glow
        g.lineStyle(2, 0xffffff, alpha);      stroke(pts);   // bright core
      },
      onComplete: () => { g.destroy(); this._impact(x2, y2, color); },
    });
  }

  // A bright bolt that travels source→target, trailing a soft glow, then flashes on arrival.
  // Travel time scales with distance (clamped) so near and far shots both read clearly.
  _laser(x1, y1, x2, y2, color) {
    const scene = this.scene;
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const boltLen = Math.min(30, len * 0.5);
    const state = { p: 0 };
    scene.tweens.add({
      targets: state,
      p: 1,
      duration: Phaser.Math.Clamp(len / 1.6, 70, 200),
      ease: 'Linear',
      onUpdate: () => {
        const head = state.p * len;
        const tail = Math.max(0, head - boltLen);
        const hx = x1 + ux * head, hy = y1 + uy * head;
        const tx = x1 + ux * tail, ty = y1 + uy * tail;
        g.clear();
        g.lineStyle(7, color, 0.22); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
        g.lineStyle(2.5, 0xffffff, 0.95); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
      },
      onComplete: () => { g.destroy(); this._impact(x2, y2, color); },
    });
  }

  // A small expanding ring where the bolt lands. `scale` (>1) widens it into a concussive blast
  // and throws a handful of debris streaks outward — used by the Tank's heavy shell.
  _impact(x, y, color, scale = 1) {
    const g = this.scene.add.graphics().setDepth(EFFECT_DEPTH);
    const s = { r: 2, a: 0.9 };
    // Pre-roll debris directions/lengths so they're fixed for the life of the streak.
    const debris = [];
    if (scale > 1) {
      const n = 6;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
        debris.push({ c: Math.cos(ang), s: Math.sin(ang), len: 10 + Math.random() * 10 });
      }
    }
    this.scene.tweens.add({
      targets: s,
      r: 13 * scale, a: 0,
      duration: 170 * scale,
      ease: 'Quad.Out',
      onUpdate: () => {
        g.clear();
        g.fillStyle(color, s.a * 0.5); g.fillCircle(x, y, s.r);
        g.lineStyle(2, 0xffffff, s.a); g.strokeCircle(x, y, s.r);
        // Debris streaks fly outward as the ring expands.
        if (debris.length) {
          const reach = s.r * 1.4;
          g.lineStyle(2, color, s.a * 0.8);
          for (const d of debris) {
            g.beginPath();
            g.moveTo(x + d.c * reach * 0.4, y + d.s * reach * 0.4);
            g.lineTo(x + d.c * (reach + d.len), y + d.s * (reach + d.len));
            g.strokePath();
          }
        }
      },
      onComplete: () => g.destroy(),
    });
  }

  // A brief bright burst at a gun's muzzle — a filled core that pops and fades in ~90ms.
  _muzzleFlash(x, y, color, size = 9) {
    const g = this.scene.add.graphics().setDepth(EFFECT_DEPTH);
    const s = { r: size, a: 1 };
    this.scene.tweens.add({
      targets: s,
      r: size * 0.4, a: 0,
      duration: 90,
      ease: 'Quad.Out',
      onUpdate: () => {
        g.clear();
        g.fillStyle(color, s.a * 0.4); g.fillCircle(x, y, s.r * 1.6);
        g.fillStyle(0xffffff, s.a);    g.fillCircle(x, y, s.r * 0.6);
      },
      onComplete: () => g.destroy(),
    });
  }

  // Tank: one heavy, slow shell. A thick warm bolt leaves the barrel behind a muzzle flash,
  // travels noticeably slower than a laser, and lands as a concussive blast (scaled _impact).
  _cannon(x1, y1, x2, y2, color) {
    const scene = this.scene;
    this._muzzleFlash(x1, y1, color, 13);
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const boltLen = Math.min(26, len * 0.4);
    const state = { p: 0 };
    scene.tweens.add({
      targets: state,
      p: 1,
      duration: Phaser.Math.Clamp(len / 1.0, 110, 320),   // heavier = slower than the laser
      ease: 'Linear',
      onUpdate: () => {
        const head = state.p * len;
        const tail = Math.max(0, head - boltLen);
        const hx = x1 + ux * head, hy = y1 + uy * head;
        const tx = x1 + ux * tail, ty = y1 + uy * tail;
        g.clear();
        g.lineStyle(11, color, 0.25); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
        g.lineStyle(5, 0xffd9a0, 0.98); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
      },
      onComplete: () => { g.destroy(); this._impact(x2, y2, color, 2.1); },
    });
  }

  // Mech: a rapid burst of three thin tracers, fired ~70ms apart with a little spread, each with
  // its own muzzle flash and small impact — reads as a quick-firing autocannon.
  _autocannon(x1, y1, x2, y2, color) {
    const scene = this.scene;
    for (let i = 0; i < 3; i++) {
      scene.time.delayedCall(i * 70, () => {
        // Slight perpendicular spread so the three rounds don't stack into one line.
        const spread = (Math.random() - 0.5) * 10;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        this._tracer(x1, y1, x2 + px * spread, y2 + py * spread, color);
      });
    }
  }

  // A thin, fast tracer round (a lean cousin of _laser) with a muzzle flash and small impact.
  _tracer(x1, y1, x2, y2, color) {
    const scene = this.scene;
    this._muzzleFlash(x1, y1, color, 6);
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const boltLen = Math.min(22, len * 0.4);
    const state = { p: 0 };
    scene.tweens.add({
      targets: state,
      p: 1,
      duration: Phaser.Math.Clamp(len / 2.2, 50, 130),    // snappier than the laser
      ease: 'Linear',
      onUpdate: () => {
        const head = state.p * len;
        const tail = Math.max(0, head - boltLen);
        const hx = x1 + ux * head, hy = y1 + uy * head;
        const tx = x1 + ux * tail, ty = y1 + uy * tail;
        g.clear();
        g.lineStyle(4, color, 0.2);  g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
        g.lineStyle(1.5, 0xffffff, 0.95); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
      },
      onComplete: () => { g.destroy(); this._impact(x2, y2, color, 0.7); },
    });
  }

  // Reaper: a close-range shotgun blast. One big muzzle flash, then a cone of short pellet
  // streaks fired simultaneously with angular spread — they fan out and spatter small impacts
  // around the target. Short by design (the Reaper's reach is only ~2 Tiles), so it reads as a
  // wide point-blank spray rather than an aimed bolt.
  _shotgun(x1, y1, x2, y2, color) {
    const scene = this.scene;
    this._muzzleFlash(x1, y1, color, 14);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const baseAng = Math.atan2(dy, dx);
    const N = 7;
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    // Pre-roll each pellet's angle (within a ±0.3rad cone), reach, and length so they're stable.
    const pellets = [];
    for (let i = 0; i < N; i++) {
      const ang = baseAng + (Math.random() - 0.5) * 0.6;
      const reach = len * (0.8 + Math.random() * 0.45);   // some fall short, some overshoot
      pellets.push({
        ux: Math.cos(ang), uy: Math.sin(ang),
        reach, plen: 9 + Math.random() * 7,
        ex: x1 + Math.cos(ang) * reach, ey: y1 + Math.sin(ang) * reach,
      });
    }
    const state = { p: 0 };
    scene.tweens.add({
      targets: state,
      p: 1,
      duration: 110,            // fast spray
      ease: 'Quad.Out',
      onUpdate: () => {
        const alpha = Math.max(0, 1 - state.p);
        g.clear();
        for (const pe of pellets) {
          const head = state.p * pe.reach;
          const tail = Math.max(0, head - pe.plen);
          const hx = x1 + pe.ux * head, hy = y1 + pe.uy * head;
          const tx = x1 + pe.ux * tail, ty = y1 + pe.uy * tail;
          g.lineStyle(3, color, alpha * 0.25); g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
          g.lineStyle(1.5, 0xffffff, alpha);   g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.strokePath();
        }
      },
      onComplete: () => {
        g.destroy();
        // Spatter a few small impacts where the spread lands, clustered around the target.
        for (let i = 0; i < 3; i++) {
          const pe = pellets[i * 2];
          this._impact(pe.ex, pe.ey, color, 0.5);
        }
      },
    });
  }

  // Three parallel claw stripes raking diagonally across the target, then fading — drawn with a
  // soft coloured underglow and a bright white core, like the laser, so the two share a look.
  _slash(cx, cy, color) {
    const scene = this.scene;
    const g = scene.add.graphics().setDepth(EFFECT_DEPTH);
    const ang = -Math.PI / 4 + 0.25;          // raking down-left → up-right
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const px = -dy, py = dx;                   // perpendicular, to space the three stripes
    const base = 46;
    const offsets = [-12, 0, 12];
    const lens = [0.78, 1, 0.84];              // uneven lengths read as claws, not a comb
    const s = { p: 0 };
    scene.tweens.add({
      targets: s,
      p: 1,
      duration: 240,
      ease: 'Cubic.Out',
      onUpdate: () => {
        const reveal = Math.min(1, s.p * 1.8);                       // rake outward, then hold
        const alpha = s.p < 0.45 ? 1 : Math.max(0, 1 - (s.p - 0.45) / 0.55);
        g.clear();
        for (let i = 0; i < 3; i++) {
          const L = base * lens[i];
          const ox = px * offsets[i], oy = py * offsets[i];
          const sx = cx - dx * L / 2 + ox, sy = cy - dy * L / 2 + oy;
          const ex = sx + dx * L * reveal, ey = sy + dy * L * reveal;
          g.lineStyle(5, color, alpha * 0.3); g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.strokePath();
          g.lineStyle(2, 0xffffff, alpha); g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.strokePath();
        }
      },
      onComplete: () => g.destroy(),
    });
  }
}
