import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Worker extends Unit {
  constructor(scene, x, y, faction = FACTION.PLAYER) {
    super(scene, x, y, 'worker', TILE * 1.5, faction, 1.5);
  }
}
