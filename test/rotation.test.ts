import { describe, expect, it } from 'vitest';
import { footprints, nest, PartTooLargeError } from '../src/core/nest';
import { minimumBoardLength } from '../src/core/sheets';
import { canonicalise } from '../src/core/orient';
import { outlineArea } from '../src/core/outline';
import { uniformGaps, uniformMargins } from '../src/core/types';
import type { NestSettings, Outline, Part, PartRotation, Ring } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const hole = (x0: number, y0: number, x1: number, y1: number): Ring =>
  rect(x0, y0, x1, y1).slice().reverse();

function make(name: string, outline: Outline, rotation: PartRotation = 'auto', quantity = 1): Part {
  const canon = canonicalise(outline);
  return {
    id: name,
    name,
    source: 'test',
    outline: canon.outline,
    thickness: 10,
    area: outlineArea(canon.outline),
    boxW: canon.w,
    boxH: canon.h,
    quantity,
    rotation,
  };
}

const plain = (name: string, w: number, h: number, rotation: PartRotation = 'auto', quantity = 1) =>
  make(name, { exterior: rect(0, 0, w, h), interiors: [] }, rotation, quantity);

/** 400 x 200 with a 60 x 60 cutout near one end, so 0 and 180 are tellable apart. */
const lopsided = (name: string, rotation: PartRotation = 'auto', quantity = 1) =>
  make(
    name,
    { exterior: rect(0, 0, 400, 200), interiors: [hole(20, 70, 80, 130)] },
    rotation,
    quantity
  );

const base: NestSettings = {
  gap: uniformGaps(5),
  margin: uniformMargins(10),
  kerf: 0,
  orientation: 'grain-locked',
  sheetWidth: 1000,
  sheetHeight: 600,
  nestInHoles: false,
};

/** Where the cutout's centre sits inside the placed box, as a fraction of it. */
function cutoutOffset(placement: { x: number; y: number; w: number; h: number; outline: Outline }) {
  const ring = placement.outline.interiors[0];
  const cx = (Math.min(...ring.map((p) => p.x)) + Math.max(...ring.map((p) => p.x))) / 2;
  const cy = (Math.min(...ring.map((p) => p.y)) + Math.max(...ring.map((p) => p.y))) / 2;
  return { x: cx - placement.x, y: cy - placement.y };
}

const only = (parts: Part[], settings = base) => {
  const result = nest(parts, settings);
  expect(result.validation.ok).toBe(true);
  return result.sheets[0].placements;
};

describe('which footprints a part is allowed', () => {
  it('leaves an auto part to the job: upright when grain locked, either way on quarter turns', () => {
    const part = plain('p', 300, 100);
    expect(footprints(part, 'grain-locked').map((f) => f.rotation)).toEqual([0]);
    expect(footprints(part, 'quarter-turns').map((f) => f.rotation)).toEqual([0, 90]);
  });

  it('gives a pinned part exactly one footprint, whatever the job mode says', () => {
    for (const mode of ['grain-locked', 'quarter-turns'] as const) {
      expect(footprints(plain('p', 300, 100, 90), mode)).toEqual([{ w: 100, h: 300, rotation: 90 }]);
      expect(footprints(plain('p', 300, 100, 270), mode)).toEqual([{ w: 100, h: 300, rotation: 270 }]);
      expect(footprints(plain('p', 300, 100, 0), mode)).toEqual([{ w: 300, h: 100, rotation: 0 }]);
      expect(footprints(plain('p', 300, 100, 180), mode)).toEqual([{ w: 300, h: 100, rotation: 180 }]);
    }
  });

  it('still refuses free rotation, pinned parts or not', () => {
    expect(() => footprints(plain('p', 300, 100, 90), 'free')).toThrow(/not implemented/i);
    expect(() => nest([plain('p', 300, 100, 90)], { ...base, orientation: 'free' })).toThrow(
      /not implemented/i
    );
  });
});

describe('pinning a part to a rotation', () => {
  it('turns it a quarter turn in a grain-locked job, as the old across-grain toggle did', () => {
    const placed = only([plain('along', 300, 100), plain('across', 300, 100, 90)]);
    const byName = Object.fromEntries(placed.map((p) => [p.name, p]));
    expect(byName['along'].rotation).toBe(0);
    expect(byName['along'].w).toBeCloseTo(300, 3);
    expect(byName['across'].rotation).toBe(90);
    expect(byName['across'].w).toBeCloseTo(100, 3);
    expect(byName['across'].h).toBeCloseTo(300, 3);
  });

  it('holds a part upright in a 90-degree job even where turning would pack better', () => {
    // A 540 mm part cannot sit upright on a 300 mm wide sheet.
    const board = { ...base, orientation: 'quarter-turns' as const, sheetWidth: 300, sheetHeight: 600 };
    expect(only([plain('free to turn', 540, 90)], board)[0].rotation).toBe(90);
    expect(() => nest([plain('pinned flat', 540, 90, 0)], board)).toThrow(PartTooLargeError);
  });

  it('says which way round a pinned part had to sit when it will not fit', () => {
    // 350 x 210 fits a 380 x 230 usable area upright, but not turned.
    const board = { ...base, sheetWidth: 400, sheetHeight: 250 };
    expect(() => nest([plain('panel', 350, 210, 0)], board)).not.toThrow();
    try {
      nest([plain('panel', 350, 210, 90)], board);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('panel is 350.0 x 210.0 mm');
      expect(message).toContain('pinned to 90°, needs 210.0 x 350.0 mm');
      expect(message).toContain('380.0 x 230.0 mm');
    }
  });

  it('applies to every instance of the part, not just the first', () => {
    const placed = only([plain('p', 300, 100, 90, 4)]);
    expect(placed).toHaveLength(4);
    expect(placed.every((p) => p.rotation === 90)).toBe(true);
    expect(placed.every((p) => Math.abs(p.w - 100) < 1e-3)).toBe(true);
  });

  it('leaves the other parts alone', () => {
    // Grain locked, so an automatic part can only be upright: whatever the
    // pinned part does, the rest of the job is unaffected by it.
    const placed = only([
      plain('pinned', 300, 100, 90),
      plain('auto a', 300, 100),
      plain('auto b', 250, 120),
    ]);
    const byName = Object.fromEntries(placed.map((p) => [p.name, p]));
    expect(byName['pinned'].rotation).toBe(90);
    expect(byName['auto a'].rotation).toBe(0);
    expect(byName['auto b'].rotation).toBe(0);
  });
});

describe('0 against 180, and 90 against 270', () => {
  it('keeps the footprint but flips the part end for end', () => {
    const at0 = cutoutOffset(only([lopsided('p', 0)])[0]);
    const at180 = cutoutOffset(only([lopsided('p', 180)])[0]);
    const box = only([lopsided('p', 0)])[0];

    // Same box either way round...
    expect(only([lopsided('p', 180)])[0].w).toBeCloseTo(box.w, 3);
    expect(only([lopsided('p', 180)])[0].h).toBeCloseTo(box.h, 3);
    // ...but the cutout has moved to the far end, and across to the far side.
    expect(at180.x).toBeCloseTo(box.w - at0.x, 3);
    expect(at180.y).toBeCloseTo(box.h - at0.y, 3);
  });

  it('does the same for the turned pair', () => {
    const at90 = cutoutOffset(only([lopsided('p', 90)])[0]);
    const box = only([lopsided('p', 90)])[0];
    const at270 = cutoutOffset(only([lopsided('p', 270)])[0]);
    expect(only([lopsided('p', 270)])[0].w).toBeCloseTo(box.w, 3);
    expect(at270.x).toBeCloseTo(box.w - at90.x, 3);
    expect(at270.y).toBeCloseTo(box.h - at90.y, 3);
  });

  it('carries the rotation through to the placed geometry, not just the label', () => {
    const at0 = only([lopsided('p', 0)])[0];
    const at180 = only([lopsided('p', 180)])[0];
    expect(at0.rotation).toBe(0);
    expect(at180.rotation).toBe(180);
    // The two outlines cover the same box but are not the same polygon.
    const ring0 = at0.outline.interiors[0].map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).sort();
    const ring180 = at180.outline.interiors[0].map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).sort();
    expect(ring0).not.toEqual(ring180);
  });
});

describe('pinned rotations elsewhere in the pipeline', () => {
  it('measures the board width against the way the part is pinned', () => {
    const upright = minimumBoardLength([plain('p', 300, 100, 0)], base, 200, []);
    expect(upright.error).toBeUndefined();

    const turned = minimumBoardLength([plain('p', 300, 100, 90)], base, 200, []);
    expect(turned.minLength).toBeNull();
    expect(turned.error).toMatch(/300\.0 mm across, wider than/);
  });

  it('validates a pinned layout like any other', () => {
    const result = nest([plain('a', 300, 100, 90, 3), plain('b', 200, 150, 180, 2)], base);
    expect(result.validation.ok).toBe(true);
    expect(result.validation.minGap.toFixed(3)).toBe('5.000');
    const rotations = result.sheets.flatMap((s) => s.placements).map((p) => p.rotation);
    expect(rotations.filter((r) => r === 90)).toHaveLength(3);
    expect(rotations.filter((r) => r === 180)).toHaveLength(2);
  });

  it('nests a pinned part into a cutout the same as any other', () => {
    const host = make('host', {
      exterior: rect(0, 0, 900, 400),
      interiors: [hole(200, 50, 700, 350)],
    });
    const result = nest([host, plain('insert', 400, 200, 180)], { ...base, nestInHoles: true });
    const insert = result.sheets[0].placements.find((p) => p.name === 'insert')!;
    expect(insert.nestedIn).toBe('host');
    expect(insert.rotation).toBe(180);
    expect(result.validation.ok).toBe(true);
  });
});
