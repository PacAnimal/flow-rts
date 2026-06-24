import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Chojin extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'chojin', TILE, FACTION.PLAYER, 3.5);
  }
}
