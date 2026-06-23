import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Mech extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'mech', TILE * 1.5);
  }
}
