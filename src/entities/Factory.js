import { Building } from './Building.js';

export class Factory extends Building {
  constructor(scene, tx, ty) {
    super(scene, tx, ty, 3, 3, 'factory');
  }
}
