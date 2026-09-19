import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixtureOcct } from './helpers';
import { outlineFromMesh } from '../src/core/outline';
import { canonicalise, minAreaRect } from '../src/core/orient';
import { findPlateFrame, frameToZ } from '../src/core/plate';
import { readStep } from '../src/core/parse/occt';
import type { Mesh } from '../src/core/types';

/**
 * SPEC 3.2 — never take a cross-section at mid-thickness.
 *
 * Two fixture parts exist to prove the difference. The left wall has a rebate
 * 5 mm wide and 6 mm deep cut from its top face, which spans mid-thickness; the
 * right wall has a 2 mm chamfer round its top face. Both still have to come out
 * as their full rectangle.
 */

let leftWall: Mesh;
let rightWall: Mesh;

beforeAll(async () => {
  const occt = await fixtureOcct();
  const read = (file: string) =>
    readStep(occt, new Uint8Array(readFileSync(`fixtures/box/${file}`)), file)[0];
  leftWall = read('03-left-wall.step');
  rightWall = read('04-right-wall.step');
});

/**
 * The mid-thickness section of the mesh, measured the same way the real
 * extraction measures its outline: as a minimum-area rectangle, since the
 * parts sit at arbitrary in-plane rotations.
 */
function midPlaneSection(mesh: Mesh): { long: number; short: number } {
  const frame = findPlateFrame(mesh);
  const m = frameToZ(frame.normal);
  const p = mesh.positions;

  const project = (i: number) => ({
    x: m[0] * p[i] + m[1] * p[i + 1] + m[2] * p[i + 2],
    y: m[3] * p[i] + m[4] * p[i + 1] + m[5] * p[i + 2],
    z: m[6] * p[i] + m[7] * p[i + 1] + m[8] * p[i + 2],
  });

  let zLo = Infinity;
  let zHi = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const z = project(i).z;
    if (z < zLo) zLo = z;
    if (z > zHi) zHi = z;
  }
  const zMid = (zLo + zHi) / 2;

  // Intersect every triangle edge with z = zMid and take the extent of the
  // resulting points: that is what a slicing implementation would measure.
  const idx = mesh.indices;
  const section: { x: number; y: number }[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const v = [project(idx[t] * 3), project(idx[t + 1] * 3), project(idx[t + 2] * 3)];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      if (a.z === b.z) continue;
      const s = (zMid - a.z) / (b.z - a.z);
      if (s < 0 || s > 1) continue;
      section.push({ x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) });
    }
  }
  const rect = minAreaRect(section);
  return { long: rect.long, short: rect.short };
}

/** The extracted blank, measured as long side x short side. */
function blank(mesh: Mesh): { long: number; short: number; verts: number } {
  const { outline } = outlineFromMesh(mesh);
  const canon = canonicalise(outline);
  return { long: canon.w, short: canon.h, verts: canon.outline.exterior.length };
}

describe('projecting versus slicing', () => {
  it('projects the rebated left wall to its full 250 x 210 blank', () => {
    const b = blank(leftWall);
    expect(b.long).toBeCloseTo(250, 2);
    expect(b.short).toBeCloseTo(210, 2);
    expect(b.verts).toBe(4);
  });

  it('would lose 5 mm off the left wall if it sliced at mid-thickness', () => {
    // The rebate is 5 mm wide, so the mid-plane section is 250 x 205. This
    // guards the fixture itself: if the rebate ever stopped spanning
    // mid-thickness, the acceptance test would stop proving anything.
    const section = midPlaneSection(leftWall);
    expect(section.long).toBeCloseTo(250, 2);
    expect(section.short).toBeCloseTo(205, 2);
    // ...which is 5 mm narrower than the blank the projection returns.
    expect(blank(leftWall).short - section.short).toBeCloseTo(5, 2);
  });

  it('keeps the chamfered right wall at its full 250 x 210 silhouette', () => {
    const b = blank(rightWall);
    expect(b.long).toBeCloseTo(250, 2);
    expect(b.short).toBeCloseTo(210, 2);
    expect(b.verts).toBe(4);
  });

  it('finds the plate normal regardless of the assembly rotation', () => {
    for (const mesh of [leftWall, rightWall]) {
      expect(findPlateFrame(mesh).thickness).toBeCloseTo(10, 3);
    }
    // The fixture parts are rotated off-axis, so an axis-aligned bounding box
    // would report something quite different from the real thickness.
    const p = rightWall.positions;
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[i + k]);
        hi[k] = Math.max(hi[k], p[i + k]);
      }
    }
    const aabbMin = Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    expect(aabbMin).toBeGreaterThan(50);
  });
});
