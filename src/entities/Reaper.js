import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

// ~75% of one head height at TILE*1.1 display, halved per request (10.5px * 0.75 * 0.5 ≈ 4px)
const BOB_AMP = 4;

function randomBobPeriod() { return (3 + Math.random() * 2) * 1000; } // 3–5 s in ms

export class Reaper extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'reaper', TILE * 1.1, FACTION.PLAYER, 6, 16, 8);
    // hover shadow: wider, offset down to sell the levitation gap
    this._shadowW     = 2.5;
    this._shadowH     = 0.55;
    this._shadowAlpha = 0.80;
    this._shadowYOff  = 22;
    // procedural hover bob — phase offset is random so multiple reapers don't sync up
    this._bobPhase  = Math.random() * Math.PI * 2;
    this._bobPeriod = randomBobPeriod();
  }

  // Returns y offset in pixels (negative = up). Call once per frame with delta in ms.
  // Runs at half speed when stationary. Re-randomises the period each complete cycle.
  tickBob(dt) {
    const moving = this._vel && Math.hypot(this._vel.x, this._vel.y) >= 5;
    this._bobPhase += (Math.PI * 2 / this._bobPeriod) * (moving ? dt : dt * 0.5);
    if (this._bobPhase >= Math.PI * 2) {
      this._bobPhase -= Math.PI * 2;
      this._bobPeriod = randomBobPeriod();
    }
    return -Math.sin(this._bobPhase) * BOB_AMP;
  }
}
