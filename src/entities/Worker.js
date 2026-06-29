import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Worker extends Unit {
  constructor(scene, x, y, faction = FACTION.PLAYER) {
    super(scene, x, y, 'worker', TILE * 1.5, faction, 2.2, 16, 8);
    // worker sprite has 35/256 ≈ 14% bottom margin; larger, softer shadow for its stocky build
    this._shadowFeetFrac = 0.14;
    this._shadowW        = 1.3;
    this._shadowH        = 0.50;
    this._shadowAlpha    = 0.65;
  }
}
