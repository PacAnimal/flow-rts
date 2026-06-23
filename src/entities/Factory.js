import { Building } from './Building.js';

export class Factory extends Building {
  constructor(scene, tx, ty) {
    super(scene, tx, ty, 6, 6, 'factory');
  }
}
