import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Marine extends Unit {
  constructor(scene, x, y, faction = FACTION.PLAYER) {
    super(scene, x, y, 'marine', TILE, faction, 3.5, 16, 8);
    this._shadowFeetFrac = 0.22;
  }
}
