import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class HeavyChojin extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'heavy-chojin', TILE * 1.2, FACTION.PLAYER, 2.5);
  }
}
