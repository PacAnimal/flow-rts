import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Worker extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'worker', TILE);
  }
}
