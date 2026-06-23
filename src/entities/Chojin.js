import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Chojin extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'chojin', TILE, 3.5);
  }
}
