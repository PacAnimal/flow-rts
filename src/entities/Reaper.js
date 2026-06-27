import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Reaper extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'reaper', TILE * 1.1, FACTION.PLAYER, 6, 16);
    // hover shadow: wider, offset down to sell the levitation gap
    this._shadowW     = 2.5;
    this._shadowH     = 0.55;
    this._shadowAlpha = 0.80;
    this._shadowYOff  = 22;
  }
}
