import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Reaper extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'reaper', TILE * 1.1, 6);
  }
}
