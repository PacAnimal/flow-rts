import { Building } from './Building.js';

export class Barracks extends Building {
  constructor(scene, tx, ty) {
    super(scene, tx, ty, 3, 3, 'barracks');
  }
}
