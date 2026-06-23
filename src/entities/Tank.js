import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Tank extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'tank', TILE * 1.8, 3.6);
  }
}
