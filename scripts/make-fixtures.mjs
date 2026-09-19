// Regenerates fixtures/box/*.step — the acceptance fixture from SPEC.md §10.
//
// A wooden box: 11 parts, all 10 mm thick, written as individual STEP files in
// METRES (the unit Onshape exports), each sitting at an arbitrary assembly
// orientation so the plate-normal search has real work to do.
//
//   node scripts/make-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStep } from './step-writer.mjs';
import {
  plate,
  plateWithOpenings,
  rebatedPlate,
  chamferedPlate,
  rotation,
  transformFaces,
} from './solids.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures', 'box');

const T = 10; // material thickness, mm

// Arbitrary but deterministic assembly placements: axis, angle (deg), offset.
const poses = [
  [[1, 0, 0], 0, [0, 0, 0]],
  [[0.3, 0.9, 0.31], 37, [120, -45, 60]],
  [[1, 1, 0], 90, [-200, 15, -30]],
  [[0.2, -0.7, 0.68], 118, [40, 300, -90]],
  [[0, 0, 1], 23, [-15, -15, 200]],
  [[0.5, 0.5, 0.71], 205, [310, 80, 12]],
  [[-0.4, 0.8, 0.45], 64, [-90, 240, 33]],
  [[0.9, 0.1, 0.42], 151, [70, -180, -140]],
  [[0, 1, 0], 90, [255, 60, 0]],
  [[0.6, -0.2, 0.77], 19, [-310, -20, 95]],
  [[0.1, 0.35, 0.93], 274, [8, 130, -55]],
];

const parts = [
  { file: '01-back-wall', name: 'back wall', faces: () => plate(350, 210, T) },
  {
    file: '02-front-wall',
    name: 'front wall',
    // Two drawer openings, 320 x 50.6 each.
    faces: () =>
      plateWithOpenings(350, 210, T, [
        { x: 15, y: 25, w: 320, h: 50.6 },
        { x: 15, y: 110, w: 320, h: 50.6 },
      ]),
  },
  // Rebate along one long edge: 5 mm wide, 6 mm deep. Cut from the top face and
  // spanning mid-thickness, so a mid-plane section would report 250 x 205.
  { file: '03-left-wall', name: 'left wall', faces: () => rebatedPlate(250, 210, T, 5, 6) },
  // 2 mm chamfer around the top face: the silhouette is still the full
  // rectangle, but only if every triangle is projected rather than one face used.
  { file: '04-right-wall', name: 'right wall', faces: () => chamferedPlate(250, 210, T, 2) },
  { file: '05-lid-top', name: 'lid top', faces: () => plate(330, 230, T) },
  { file: '06-lid-front-wall', name: 'lid front wall', faces: () => plate(350, 39.8, T) },
  { file: '07-lid-back-wall', name: 'lid back wall', faces: () => plate(350, 39.8, T) },
  { file: '08-lid-left-wall', name: 'lid left wall', faces: () => plate(250, 39.8, T) },
  { file: '09-lid-right-wall', name: 'lid right wall', faces: () => plate(250, 39.8, T) },
  {
    file: '10-upper-drawer-front',
    name: 'upper drawer front',
    faces: () => plate(319.4, 50, T),
  },
  {
    file: '11-lower-drawer-front',
    name: 'lower drawer front',
    faces: () => plate(319.4, 50, T),
  },
];

mkdirSync(outDir, { recursive: true });

for (let i = 0; i < parts.length; i++) {
  const part = parts[i];
  const [axis, deg, offset] = poses[i];
  const faces = transformFaces(
    part.faces(),
    rotation(axis, (deg * Math.PI) / 180),
    offset,
    0.001 // mm -> m
  );
  const text = writeStep({ name: part.name, unit: 'METRE', faces });
  writeFileSync(join(outDir, `${part.file}.step`), text);
  console.log(`wrote ${part.file}.step`);
}
