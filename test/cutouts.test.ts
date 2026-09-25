import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureParts } from './helpers';
import { insetRing, maximalRectangles } from '../src/core/holes';
import { nest } from '../src/core/nest';
import { minimumBoardLength } from '../src/core/sheets';
import { canonicalise } from '../src/core/orient';
import { outlineArea } from '../src/core/outline';
import { validate } from '../src/core/validate';
import { uniformGaps, uniformMargins } from '../src/core/types';
import type { NestSettings, Outline, Part, Ring, Sheet } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** A ring wound the way an interior ring is stored: clockwise. */
const hole = (x0: number, y0: number, x1: number, y1: number): Ring =>
  rect(x0, y0, x1, y1).slice().reverse();

const settings: NestSettings = {
  gap: uniformGaps(5),
  margin: uniformMargins(10),
  kerf: 0,
  orientation: 'grain-locked',
  sheetWidth: 1000,
  sheetHeight: 600,
  nestInHoles: true,
};

function part(name: string, outline: Outline, thickness = 10): Part {
  const canon = canonicalise(outline);
  return {
    id: name,
    name,
    source: 'test',
    outline: canon.outline,
    thickness,
    area: outlineArea(canon.outline),
    boxW: canon.w,
    boxH: canon.h,
    quantity: 1,
    grainOverride: false,
  };
}

const plain = (name: string, w: number, h: number) =>
  part(name, { exterior: rect(0, 0, w, h), interiors: [] });

/** A 900 x 400 plate with a 500 x 300 cutout in the middle. */
const hostPlate = () =>
  part('host plate', { exterior: rect(0, 0, 900, 400), interiors: [hole(200, 50, 700, 350)] });

const bounds = (r: Ring) => ({
  minX: Math.min(...r.map((p) => p.x)),
  minY: Math.min(...r.map((p) => p.y)),
  maxX: Math.max(...r.map((p) => p.x)),
  maxY: Math.max(...r.map((p) => p.y)),
});

describe('rectangles inside a cutout', () => {
  it('uses the whole of a rectangular cutout', () => {
    const rects = maximalRectangles(rect(10, 20, 110, 80));
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('finds both arms of an L-shaped cutout, and nothing outside it', () => {
    // An L: 100 wide at the bottom, 40 wide up the left.
    const l: Ring = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 90 },
      { x: 0, y: 90 },
    ];
    const rects = maximalRectangles(l);
    expect(rects.length).toBe(2);
    expect(rects).toContainEqual({ x: 0, y: 0, w: 100, h: 30 });
    expect(rects).toContainEqual({ x: 0, y: 0, w: 40, h: 90 });
  });

  it('stays strictly inside a curved cutout rather than overhanging it', () => {
    const radius = 50;
    const circle: Ring = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * 2 * Math.PI;
      return { x: radius * Math.cos(a), y: radius * Math.sin(a) };
    });
    const rects = maximalRectangles(circle);
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      for (const [x, y] of [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h],
      ]) {
        expect(Math.hypot(x, y), `corner ${x},${y} outside the circle`).toBeLessThanOrEqual(radius + 1e-9);
      }
    }
    // Still worth having: the best rectangle covers a useful share of the disc.
    const best = rects[0];
    expect(best.w * best.h).toBeGreaterThan(0.5 * 2 * radius * radius);
  });

  it('shrinks a cutout by the gap before anything is placed in it', () => {
    const [inset] = insetRing(hole(0, 0, 100, 60), 5);
    const b = bounds(inset);
    expect(b.minX).toBeCloseTo(5, 3);
    expect(b.minY).toBeCloseTo(5, 3);
    expect(b.maxX).toBeCloseTo(95, 3);
    expect(b.maxY).toBeCloseTo(55, 3);
  });

  it('gives back nothing when the gap swallows the cutout', () => {
    expect(insetRing(hole(0, 0, 8, 8), 5)).toHaveLength(0);
  });
});

describe('nesting into cutouts', () => {
  const parts = () => [hostPlate(), plain('insert', 400, 200)];

  it('saves a sheet by putting the small part in the cutout', () => {
    const off = nest(parts(), { ...settings, nestInHoles: false });
    const on = nest(parts(), settings);
    expect(off.sheets).toHaveLength(2);
    expect(on.sheets).toHaveLength(1);
  });

  it('records which part the insert was cut from', () => {
    const on = nest(parts(), settings);
    const insert = on.sheets[0].placements.find((p) => p.name === 'insert')!;
    expect(insert.nestedIn).toBe('host plate');
    expect(on.sheets[0].placements.find((p) => p.name === 'host plate')!.nestedIn).toBeUndefined();
  });

  it('keeps the full gap between the insert and the cutout edge', () => {
    const on = nest(parts(), settings);
    expect(on.validation.ok).toBe(true);
    expect(on.validation.minGap.toFixed(3)).toBe('5.000');
  });

  it('honours the kerf inside a cutout too', () => {
    const on = nest(parts(), { ...settings, gap: uniformGaps(4), kerf: 3 });
    expect(on.sheets).toHaveLength(1);
    expect(on.validation.ok).toBe(true);
    expect(on.validation.minGap).toBeGreaterThanOrEqual(7 - 1e-6);
  });

  it('will not put a part of a different thickness in the cutout', () => {
    const on = nest([hostPlate(), part('insert', { exterior: rect(0, 0, 400, 200), interiors: [] }, 18)], settings);
    expect(on.sheets).toHaveLength(2);
    for (const sheet of on.sheets) {
      expect(new Set(sheet.placements.map((p) => p.name)).size).toBe(1);
    }
  });

  it('leaves a part that does not fit the cutout for the next sheet', () => {
    const on = nest([hostPlate(), plain('too big', 600, 200)], settings);
    expect(on.sheets).toHaveLength(2);
    expect(on.sheets[0].placements.every((p) => p.nestedIn === undefined)).toBe(true);
  });
});

describe('validation with parts inside cutouts', () => {
  const sheetWith = (placements: Sheet['placements']): Sheet => ({
    index: 0,
    width: 1000,
    height: 600,
    thickness: 10,
    placements,
    utilisation: 0,
  });

  const place = (name: string, outline: Outline) => ({
    partId: name,
    name,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    outline,
  });

  const host = place('host', { exterior: rect(100, 100, 500, 400), interiors: [hole(150, 150, 450, 350)] });

  it('does not call a part inside a cutout an overlap', () => {
    const inner = place('inner', { exterior: rect(155, 155, 445, 345), interiors: [] });
    const report = validate([sheetWith([host, inner])], uniformGaps(5), uniformMargins(10));
    expect(report.ok).toBe(true);
    expect(report.minGap).toBeCloseTo(5, 6);
  });

  it('still catches a part that is too close to the cutout edge', () => {
    const inner = place('inner', { exterior: rect(152, 152, 445, 345), interiors: [] });
    const report = validate([sheetWith([host, inner])], uniformGaps(5), uniformMargins(10));
    expect(report.ok).toBe(false);
    expect(report.issues[0].kind).toBe('gap');
    expect(report.minGap).toBeCloseTo(2, 6);
  });

  it('still catches a part that spills out of the cutout into solid material', () => {
    const inner = place('inner', { exterior: rect(155, 155, 470, 345), interiors: [] });
    const report = validate([sheetWith([host, inner])], uniformGaps(5), uniformMargins(10));
    expect(report.issues.some((i) => i.kind === 'overlap')).toBe(true);
  });

  it('measures two side-by-side parts from their exteriors, ignoring their cutouts', () => {
    const a = place('a', { exterior: rect(0, 0, 100, 100), interiors: [hole(20, 20, 80, 80)] });
    const b = place('b', { exterior: rect(107, 0, 207, 100), interiors: [hole(127, 20, 187, 80)] });
    const report = validate([sheetWith([a, b])], uniformGaps(5), uniformMargins(0));
    expect(report.minGap).toBeCloseTo(7, 6);
  });
});

describe('the acceptance fixture with cutouts in play', () => {
  let parts: Part[];
  beforeAll(async () => {
    parts = await loadFixtureParts();
  });

  it('never needs more sheets than plain bounding-box nesting', () => {
    for (const [w, h] of [
      [1000, 600],
      [1000, 500],
      [800, 600],
      [1200, 250],
      [600, 400],
    ] as [number, number][]) {
      const off = nest(parts, { ...settings, nestInHoles: false, sheetWidth: w, sheetHeight: h });
      const on = nest(parts, { ...settings, sheetWidth: w, sheetHeight: h });
      expect(on.sheets.length, `${w}x${h}`).toBeLessThanOrEqual(off.sheets.length);
      expect(on.validation.ok, `${w}x${h} validation`).toBe(true);
      expect(on.validation.minGap.toFixed(3), `${w}x${h} min gap`).toBe('5.000');
    }
  });

  it('uses the front wall openings to shorten the 250 mm board', () => {
    const off = minimumBoardLength(parts, { ...settings, nestInHoles: false }, 250, [1200]);
    const on = minimumBoardLength(parts, settings, 250, [1200]);
    expect(off.minLength).toBeCloseTo(2149, 0);
    expect(on.minLength!).toBeLessThan(off.minLength!);

    // Whatever length it lands on has to actually hold the job, with the gap intact.
    const check = nest(parts, { ...settings, sheetWidth: on.minLength!, sheetHeight: 250 });
    expect(check.sheets).toHaveLength(1);
    expect(check.validation.ok).toBe(true);
    expect(check.validation.minGap.toFixed(3)).toBe('5.000');
    expect(check.sheets[0].placements.some((p) => p.nestedIn === 'front wall')).toBe(true);
  });
});

describe('host attribution', () => {
  it('names the right host when two cutouts of different parts sit side by side', () => {
    const a = part('left host', {
      exterior: rect(0, 0, 400, 300),
      interiors: [hole(50, 50, 350, 250)],
    });
    const b = part('right host', {
      exterior: rect(0, 0, 400, 300),
      interiors: [hole(50, 50, 350, 250)],
    });
    const inserts = Array.from({ length: 2 }, (_, i) => plain(`insert ${i}`, 280, 180));
    const result = nest([a, b, ...inserts], { ...settings, sheetWidth: 440, sheetHeight: 620 });
    const nested = result.sheets.flatMap((s) => s.placements).filter((p) => p.nestedIn);
    expect(nested.length).toBeGreaterThan(0);
    for (const p of nested) {
      // Whatever it says, the part's centre really is inside that host's cutout.
      const host = result.sheets
        .flatMap((s) => s.placements)
        .find((h) => h.name === p.nestedIn)!;
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const b2 = bounds(host.outline.interiors[0]);
      expect(cx).toBeGreaterThan(b2.minX);
      expect(cx).toBeLessThan(b2.maxX);
      expect(cy).toBeGreaterThan(b2.minY);
      expect(cy).toBeLessThan(b2.maxY);
    }
    expect(result.validation.ok).toBe(true);
  });
});
