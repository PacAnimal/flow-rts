import { Building } from './Building.js';

export class CommandCenter extends Building {
  constructor(scene, tx, ty) {
    super(scene, tx, ty, 6, 6, 'command_center');
  }
}
