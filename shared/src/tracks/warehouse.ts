import type { TrackDef } from '../track';

/**
 * "Entrepôt MSF Supply" — driving order:
 *  A  long main aisle eastward (start/finish)          z = -32
 *  ↳  hairpin at the east end of the racking
 *  B  aisle westward                                    z = -16
 *  ↳  hairpin at the west end
 *  C  aisle eastward                                    z =   0
 *  ↳  right turn down the east cross-aisle             x =  58
 *  D  open loading-dock zone, westward along the doors  z ≈ 33
 *  ↳  ramp up the west wall to the mezzanine (y = 4 m)
 *  M  mezzanine deck, then ramp down onto aisle A
 * Shortcut: narrow 3.4 m gap through the racking between B and C (x ≈ 8),
 * with pallets sticking out — saves the B/C hairpin if you thread it cleanly.
 */
export const WAREHOUSE_TRACK: TrackDef = {
  name: 'Entrepôt MSF Supply',
  laps: 3,
  gates: 10,
  bounds: { minX: -70, maxX: 70, minZ: -46, maxZ: 46 },
  main: [
    // A — start line at waypoint 0
    { x: -12, z: -32, hw: 4.6 },
    { x: 20, z: -32, hw: 4.6 },
    { x: 48, z: -32, hw: 4.6 },
    // East hairpin
    { x: 59, z: -30.5, hw: 4.6 },
    { x: 64, z: -24, hw: 4.8 },
    { x: 59, z: -17.5, hw: 4.6 },
    { x: 48, z: -16, hw: 4.6 },
    // B
    { x: 20, z: -16, hw: 4.6 },
    { x: -8, z: -16, hw: 4.6 },
    // West hairpin
    { x: -19, z: -14.5, hw: 4.6 },
    { x: -24, z: -8, hw: 4.8 },
    { x: -19, z: -1.5, hw: 4.6 },
    { x: -8, z: 0, hw: 4.6 },
    // C
    { x: 20, z: 0, hw: 4.6 },
    { x: 44, z: 0, hw: 4.6 },
    // Right turn into the east cross-aisle
    { x: 55, z: 2.5, hw: 4.6 },
    { x: 58.5, z: 10, hw: 4.6 },
    { x: 58.5, z: 20, hw: 4.8 },
    // Loading dock zone (open area around it, see zones)
    { x: 54, z: 30, hw: 6 },
    { x: 40, z: 34, hw: 6 },
    { x: 20, z: 32.5, hw: 6 },
    { x: 0, z: 36, hw: 6 },
    { x: -20, z: 32.5, hw: 6 },
    { x: -38, z: 32, hw: 6 },
    // Up to the mezzanine along the west wall
    { x: -51, z: 28.5, hw: 5 },
    { x: -58, z: 20, hw: 4.6 },
    { x: -58, z: 13, hw: 4.6, y: 0 },
    { x: -58, z: 0, hw: 4.4, y: 4 },
    { x: -58, z: -13, hw: 4.4, y: 4 },
    { x: -55.5, z: -24.5, hw: 4.4, y: 4 },
    { x: -48, z: -31, hw: 4.4, y: 4 },
    // Ramp down onto aisle A
    { x: -32, z: -32, hw: 4.6, y: 0 },
  ],
  branches: [
    [
      { x: 13, z: -16, hw: 1.7 },
      { x: 8.5, z: -13, hw: 1.7 },
      { x: 8, z: -8, hw: 1.7 },
      { x: 8.5, z: -3, hw: 1.7 },
      { x: 13, z: 0, hw: 1.7 },
    ],
  ],
  itemRows: [
    { x: 26, z: -32, count: 5 },
    { x: 30, z: -16, count: 5 },
    { x: 30, z: 0, count: 4 },
    { x: 22, z: 33, count: 6 },
    { x: -58, z: -8, count: 4 },
    // Reward for threading the shortcut.
    { x: 8, z: -8, count: 1 },
  ],
  zones: [{ minX: -46, maxX: 63, minZ: 27, maxZ: 42.5 }],
  obstacles: [
    // Pallets poking into the shortcut.
    { kind: 'box', x: 9.55, z: -9.4, hx: 0.5, hz: 0.62, angle: 0 },
    { kind: 'box', x: 6.6, z: -5.8, hx: 0.5, hz: 0.62, angle: 0 },
    // Loading-dock building columns (with yellow guards) and pallet stacks.
    { kind: 'circle', x: 32, z: 28.5, r: 0.55 },
    { kind: 'circle', x: 8, z: 28.5, r: 0.55 },
    { kind: 'circle', x: -16, z: 28.5, r: 0.55 },
    { kind: 'box', x: 26, z: 39.5, hx: 0.62, hz: 0.52, angle: 0.3 },
    { kind: 'box', x: 12, z: 38.8, hx: 0.62, hz: 0.52, angle: -0.2 },
    { kind: 'box', x: -6, z: 40.2, hx: 0.62, hz: 0.52, angle: 0.1 },
    { kind: 'box', x: -30, z: 39.6, hx: 0.62, hz: 0.52, angle: -0.4 },
    { kind: 'box', x: 46, z: 40, hx: 0.62, hz: 0.52, angle: 0.5 },
  ],
};
