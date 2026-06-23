import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Biter extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'biter', TILE * 1.3, 4);
  }
}
