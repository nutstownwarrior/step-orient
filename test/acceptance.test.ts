import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureParts } from './helpers';
import { nest } from '../src/core/nest';
import { minimumBoardLength } from '../src/core/sheets';
import type { NestSettings, Part } from '../src/core/types';

/**
 * SPEC 10 — the acceptance test.
 *
 * A wooden box, 11 parts, all 10 mm thick, written as individual STEP files in
 * metres by scripts/make-fixtures.mjs, each placed at an arbitrary assembly
 * orientation. If the extraction returns anything other than clean rectangles
 * here, the projection step is wrong — most likely it is slicing rather than
 * projecting.
 */

/** part name -> [long side, short side] in mm, from the table in SPEC 10. */
const EXPECTED: Record<string, [number, number]> = {
  'back wall': [350, 210],
  'front wall': [350, 210],
  'left wall': [250, 210],
  'right wall': [250, 210],
  'lid top': [330, 230],
  'lid front wall': [350, 39.8],
  'lid back wall': [350, 39.8],
  'lid left wall': [250, 39.8],
  'lid right wall': [250, 39.8],
  'upper drawer front': [319.4, 50],
  'lower drawer front': [319.4, 50],
};

const TOTAL_OUTLINE_AREA = 375_216;

const settings: NestSettings = {
  gap: 5,
  margin: 10,
  kerf: 0,
  orientation: 'grain-locked',
  sheetWidth: 1000,
  sheetHeight: 600,
  // SPEC 10's numbers are the plain bounding-box baseline. Nesting into
  // cutouts is asserted separately, in test/cutouts.test.ts.
  nestInHoles: false,
};

let parts: Part[];
const byName = (name: string) => parts.find((p) => p.name === name)!;

beforeAll(async () => {
  parts = await loadFixtureParts();
});

describe('outline extraction', () => {
  it('finds all eleven parts, one per file', () => {
    expect(parts.map((p) => p.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  // This is the assertion that catches the projection bug. A mid-thickness
  // slice of the rebated left wall returns 250 x 205, and a chamfered part
  // sliced anywhere but its widest plane loses 4 mm across; only the union of
  // every projected triangle gives the blank you actually have to cut.
  it('extracts every part as a clean 4-vertex rectangle', () => {
    for (const part of parts) {
      expect(part.outline.exterior, `${part.name} exterior ring`).toHaveLength(4);
    }
  });

  it('gives the front wall exactly two interior rings, and the rest none', () => {
    for (const part of parts) {
      expect(part.outline.interiors.length, `${part.name} interior rings`).toBe(
        part.name === 'front wall' ? 2 : 0
      );
    }
    // The openings are 320 x 50.6 each.
    for (const hole of byName('front wall').outline.interiors) {
      const xs = hole.map((p) => p.x);
      const ys = hole.map((p) => p.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      expect([Math.max(w, h), Math.min(w, h)][0]).toBeCloseTo(320, 2);
      expect([Math.max(w, h), Math.min(w, h)][1]).toBeCloseTo(50.6, 2);
    }
  });

  it('matches the sizes in the table', () => {
    for (const [name, [long, short]] of Object.entries(EXPECTED)) {
      const part = byName(name);
      expect(part.boxW, `${name} long side`).toBeCloseTo(long, 2);
      expect(part.boxH, `${name} short side`).toBeCloseTo(short, 2);
    }
  });

  it('reads 10 mm thickness for every part despite the assembly rotations', () => {
    for (const part of parts) expect(part.thickness, part.name).toBeCloseTo(10, 3);
  });

  it('totals 375,216 mm2 of outline area', () => {
    const total = parts.reduce((sum, p) => sum + p.area, 0);
    expect(total).toBeCloseTo(TOTAL_OUTLINE_AREA, 0);
  });
});

describe('nesting, 5 mm gap, 10 mm margin, grain locked', () => {
  const run = (w: number, h: number) =>
    nest(parts, { ...settings, sheetWidth: w, sheetHeight: h });

  it('fits a 1000 x 600 sheet once, at 62.5% used', () => {
    const result = run(1000, 600);
    expect(result.sheets).toHaveLength(1);
    expect((result.utilisation * 100).toFixed(1)).toBe('62.5');
  });

  it('fits a 1000 x 500 sheet once, at 75.0% used', () => {
    const result = run(1000, 500);
    expect(result.sheets).toHaveLength(1);
    expect((result.utilisation * 100).toFixed(1)).toBe('75.0');
  });

  it('needs two 800 x 600 sheets', () => {
    expect(run(800, 600).sheets).toHaveLength(2);
  });

  it('measures a minimum part-to-part gap of exactly 5.000 mm in every case', () => {
    for (const [w, h] of [
      [1000, 600],
      [1000, 500],
      [800, 600],
    ] as [number, number][]) {
      const result = run(w, h);
      expect(result.validation.ok, `${w}x${h} validation`).toBe(true);
      expect(result.validation.minGap.toFixed(3), `${w}x${h} min gap`).toBe('5.000');
      expect(result.validation.minMargin, `${w}x${h} min margin`).toBeGreaterThanOrEqual(10 - 1e-6);
    }
  });
});

describe('250 mm wide board', () => {
  it('needs a 2149 mm single board, or two 1200 mm boards', () => {
    const board = minimumBoardLength(parts, settings, 250, [2000, 1200, 800]);
    expect(board.error).toBeUndefined();
    // SPEC 10 quotes 2149 mm. The tightest packing this geometry admits is
    // 2149.4 mm — 1550 mm of big parts end to end, a 5 mm gap, then a 574.4 mm
    // block of small parts, plus the two 10 mm margins — so anything under
    // 2149.4 genuinely does not fit and the extra 0.4 mm is not slack.
    expect(board.minLength).toBeCloseTo(2149, 0);
    expect(board.standard.find((s) => s.length === 1200)?.boards).toBe(2);
  });

  it('places everything on two 1200 mm boards with the gap intact', () => {
    const result = nest(parts, { ...settings, sheetWidth: 1200, sheetHeight: 250 });
    expect(result.sheets).toHaveLength(2);
    expect(result.validation.ok).toBe(true);
    expect(result.validation.minGap.toFixed(3)).toBe('5.000');
  });
});
