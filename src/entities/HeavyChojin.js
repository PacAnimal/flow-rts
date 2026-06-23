import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class HeavyChojin extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'heavy-chojin', TILE * 1.2, 2.5);
  }
}
