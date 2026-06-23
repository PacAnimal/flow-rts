import { Unit } from './Unit.js';
import { TILE } from '../constants.js';

export class Marine extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'marine', TILE);
  }
}
