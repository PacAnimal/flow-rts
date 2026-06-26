import { Unit } from './Unit.js';
import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

export class Mech extends Unit {
  constructor(scene, x, y) {
    super(scene, x, y, 'mech', TILE * 1.5, FACTION.PLAYER, 4.6);
  }
}
