import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Zapper extends Unit {
  constructor(scene, x, y, faction = FACTION.PLAYER) {
    super(scene, x, y, 'zapper', TILE, faction, 3.8, 16, 8);
  }
}
