import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class HeavyChojin extends Unit {
  constructor(scene, x, y, faction = FACTION.PLAYER) {
    super(scene, x, y, 'heavy-chojin', TILE * 1.2, faction, 2.5);
  }
}
