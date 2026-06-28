import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Biter extends Unit {
  constructor(scene, x, y) {
    // 16-direction animated sprite sheet (256px frames), 8 walk frames
    super(scene, x, y, 'biter', TILE * 1.3, FACTION.CRITTER, 4, 16, 8);
  }
}
