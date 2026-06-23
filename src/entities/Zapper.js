import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Zapper extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'zapper', TILE);
  }
}
