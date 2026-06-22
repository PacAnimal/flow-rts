import { Building } from './Building.js';

export class CommandCenter extends Building {
  constructor(scene, tx, ty) {
    super(scene, tx, ty, 3, 3, 'command_center');
  }
}
