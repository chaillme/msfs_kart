import GUI from 'lil-gui';
import type { KartParams } from '@shared/kart';
import type { ChaseCamera } from './ChaseCamera';

/** Live tuning panel, enabled with ?debug in the URL. */
export class DebugTools {
  private gui: GUI | null = null;

  constructor(params: KartParams, chase: ChaseCamera) {
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    this.gui = new GUI({ title: 'Réglages conduite' });
    const drive = this.gui.addFolder('Moteur');
    drive.add(params, 'maxSpeed', 8, 30, 0.5);
    drive.add(params, 'accel', 4, 40, 0.5);
    drive.add(params, 'brakeDecel', 8, 60, 1);
    drive.add(params, 'maxReverse', 2, 12, 0.5);
    drive.add(params, 'coastDecel', 0, 15, 0.5);
    const steer = this.gui.addFolder('Direction');
    steer.add(params, 'turnRate', 1, 5, 0.05);
    steer.add(params, 'steerResponse', 2, 20, 0.5);
    steer.add(params, 'grip', 2, 25, 0.5);
    const drift = this.gui.addFolder('Drift / turbo');
    drift.add(params, 'driftGrip', 0.5, 8, 0.1);
    drift.add(params, 'driftTurnRate', 1, 4, 0.05);
    drift.add(params, 'driftMinSpeed', 2, 14, 0.5);
    drift.add(params, 'boostMultiplier', 1, 2, 0.05);
    drift.add(params, 'boostAccel', 5, 60, 1);
    const col = this.gui.addFolder('Collisions');
    col.add(params, 'wallRestitution', 0, 1, 0.05);
    col.add(params, 'kartRestitution', 0, 1, 0.05);
    const cam = this.gui.addFolder('Caméra');
    cam.add(chase, 'distance', 3, 10, 0.1);
    cam.add(chase, 'height', 1, 5, 0.1);
    cam.add(chase, 'baseFov', 45, 90, 1);
    cam.add(chase, 'yawFollow', 1, 15, 0.5);
  }

  setHidden(hidden: boolean): void {
    if (!this.gui) return;
    if (hidden) this.gui.hide();
    else this.gui.show();
  }

  dispose(): void {
    this.gui?.destroy();
    this.gui = null;
  }
}
