import { describe, expect, it } from 'vitest';
import { nest, PartTooLargeError } from '../src/core/nest';
import { minimumBoardLength } from '../src/core/sheets';
import { validate } from '../src/core/validate';
import { canonicalise } from '../src/core/orient';
import { outlineArea } from '../src/core/outline';
import { SIDES, uniformGaps, uniformMargins } from '../src/core/types';
import type { Margins, NestSettings, Outline, Part, Ring, Sheet } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const hole = (x0: number, y0: number, x1: number, y1: number): Ring =>
  rect(x0, y0, x1, y1).slice().reverse();

function part(name: string, outline: Outline, thickness = 10, quantity = 1): Part {
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
    quantity,
    rotation: 'auto',
  };
}

const plain = (name: string, w: number, h: number, quantity = 1) =>
  part(name, { exterior: rect(0, 0, w, h), interiors: [] }, 10, quantity);

const base: NestSettings = {
  gap: uniformGaps(5),
  margin: uniformMargins(10),
  kerf: 0,
  orientation: 'grain-locked',
  sheetWidth: 1000,
  sheetHeight: 600,
  nestInHoles: false,
};

/** Separation between two placed boxes along each axis, zero where they overlap. */
const separation = (a: Sheet['placements'][number], b: Sheet['placements'][number]) => ({
  x: Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))),
  y: Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))),
});

function pairs(sheet: Sheet) {
  const out: { a: Sheet['placements'][number]; b: Sheet['placements'][number] }[] = [];
  for (let i = 0; i < sheet.placements.length; i++) {
    for (let j = i + 1; j < sheet.placements.length; j++) {
      out.push({ a: sheet.placements[i], b: sheet.placements[j] });
    }
  }
  return out;
}

describe('a gap per axis', () => {
  const settings: NestSettings = { ...base, gap: { x: 20, y: 4 } };

  it('holds the horizontal gap between parts side by side and the vertical one between parts stacked', () => {
    const result = nest([plain('p', 200, 100, 12)], settings);
    expect(result.validation.ok).toBe(true);

    let sawHorizontal = false;
    let sawVertical = false;
    for (const sheet of result.sheets) {
      for (const { a, b } of pairs(sheet)) {
        const sep = separation(a, b);
        // Every pair clears one axis by that axis's gap. That is the whole
        // guarantee the inflate-by-gap trick buys.
        expect(sep.x >= 20 - 1e-6 || sep.y >= 4 - 1e-6, `${a.name} vs ${b.name}`).toBe(true);
        if (sep.y === 0 && Math.abs(sep.x - 20) < 1e-6) sawHorizontal = true;
        if (sep.x === 0 && Math.abs(sep.y - 4) < 1e-6) sawVertical = true;
      }
    }
    // ...and both gaps were actually used, rather than everything happening to
    // land far apart.
    expect(sawHorizontal, 'a pair exactly 20 mm apart horizontally').toBe(true);
    expect(sawVertical, 'a pair exactly 4 mm apart vertically').toBe(true);
  });

  it('packs more rows in when the vertical gap is small', () => {
    const job = [plain('p', 400, 100, 5)];
    const tight = nest(job, { ...base, gap: { x: 5, y: 2 } });
    const loose = nest(job, { ...base, gap: { x: 5, y: 300 } });
    expect(tight.sheets.length).toBeLessThan(loose.sheets.length);
    expect(tight.validation.ok).toBe(true);
    expect(loose.validation.ok).toBe(true);
  });

  it('applies the X gap to a part width and the Y gap to its height after a quarter turn', () => {
    const turned = { ...plain('turned', 300, 100, 2), rotation: 90 as const };
    const result = nest([turned], { ...base, gap: { x: 30, y: 3 } });
    const [a, b] = result.sheets[0].placements;
    expect(a.rotation).toBe(90);
    expect(a.w).toBeCloseTo(100, 3);
    expect(a.h).toBeCloseTo(300, 3);
    // Two 100 x 300 footprints on a 1000 mm sheet sit side by side, so the gap
    // between them is the X one even though the parts were turned.
    const sep = separation(a, b);
    expect(sep.x).toBeCloseTo(30, 3);
  });

  it('adds the kerf to both axes', () => {
    const result = nest([plain('p', 200, 100, 8)], { ...base, gap: { x: 10, y: 2 }, kerf: 3 });
    expect(result.validation.ok).toBe(true);
    for (const sheet of result.sheets) {
      for (const { a, b } of pairs(sheet)) {
        const sep = separation(a, b);
        expect(sep.x >= 13 - 1e-6 || sep.y >= 5 - 1e-6).toBe(true);
      }
    }
  });
});

describe('a margin per side', () => {
  const margin: Margins = { top: 50, right: 10, bottom: 5, left: 100 };
  const settings: NestSettings = { ...base, margin };

  it('keeps every part inside the asymmetric usable area', () => {
    const result = nest([plain('p', 200, 100, 10)], settings);
    expect(result.validation.ok).toBe(true);
    for (const sheet of result.sheets) {
      for (const p of sheet.placements) {
        const xs = p.outline.exterior.map((q) => q.x);
        const ys = p.outline.exterior.map((q) => q.y);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(margin.left - 1e-6);
        expect(Math.max(...xs)).toBeLessThanOrEqual(sheet.width - margin.right + 1e-6);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(margin.bottom - 1e-6);
        expect(Math.max(...ys)).toBeLessThanOrEqual(sheet.height - margin.top + 1e-6);
      }
    }
  });

  it('starts the layout at the bottom-left of the usable area, not the sheet corner', () => {
    const result = nest([plain('p', 200, 100, 4)], settings);
    const all = result.sheets[0].placements;
    expect(Math.min(...all.map((p) => p.x))).toBeCloseTo(margin.left, 3);
    expect(Math.min(...all.map((p) => p.y))).toBeCloseTo(margin.bottom, 3);
  });

  it('reports the closest approach to each edge separately', () => {
    const result = nest([plain('p', 200, 100, 4)], settings);
    const m = result.validation.minMargin;
    expect(m.left).toBeCloseTo(margin.left, 3);
    expect(m.bottom).toBeCloseTo(margin.bottom, 3);
    for (const side of SIDES) expect(m[side], side).toBeGreaterThanOrEqual(margin[side] - 1e-6);
  });

  it('loses capacity to a fat margin on one side only', () => {
    const wide = [plain('wide panel', 850, 200)];
    expect(nest(wide, { ...base, margin: uniformMargins(10) }).sheets).toHaveLength(1);
    expect(() => nest(wide, { ...base, margin: { ...uniformMargins(10), left: 200 } })).toThrow(
      PartTooLargeError
    );
  });

  it('names the usable area, not just the sheet, when a part will not fit', () => {
    try {
      nest([plain('wide panel', 850, 200)], { ...base, margin: { ...uniformMargins(10), left: 200 } });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('wide panel');
      expect((err as Error).message).toContain('1000 x 600');
      expect((err as Error).message).toContain('790.0 x 580.0');
    }
  });

  it('charges the board length to the left and right margins and its width to top and bottom', () => {
    const job = [plain('a', 300, 100), plain('b', 300, 100)];
    const even = minimumBoardLength(job, { ...base, margin: uniformMargins(10) }, 200, []);
    const longEnds = minimumBoardLength(
      job,
      { ...base, margin: { top: 10, bottom: 10, left: 60, right: 60 } },
      200,
      []
    );
    // 50 mm more margin at each end is 100 mm more board.
    expect(longEnds.minLength! - even.minLength!).toBeCloseTo(100, 1);
  });
});

describe('validating anisotropic spacing', () => {
  const sheetWith = (placements: Sheet['placements']): Sheet => ({
    index: 0,
    width: 1000,
    height: 600,
    thickness: 10,
    placements,
    utilisation: 0,
  });

  const place = (name: string, x: number, y: number, w: number, h: number) => ({
    partId: name,
    name,
    x,
    y,
    w,
    h,
    rotation: 0,
    outline: { exterior: rect(x, y, x + w, y + h), interiors: [] },
  });

  const gap = { x: 20, y: 2 };

  it('accepts parts stacked at the vertical gap even though it is under the horizontal one', () => {
    const report = validate(
      [sheetWith([place('a', 100, 100, 200, 100), place('b', 100, 202, 200, 100)])],
      gap,
      uniformMargins(10)
    );
    expect(report.ok).toBe(true);
    expect(report.minGap).toBeCloseTo(2, 6);
  });

  it('rejects parts side by side at the vertical gap, because that axis needs the horizontal one', () => {
    const report = validate(
      [sheetWith([place('a', 100, 100, 200, 100), place('b', 303, 100, 200, 100)])],
      gap,
      uniformMargins(10)
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].kind).toBe('gap');
    expect(report.issues[0].message).toMatch(/3\.000 mm apart horizontally/);
    expect(report.issues[0].message).toMatch(/20 mm horizontal and 2 mm vertical gap/);
  });

  it('names the side a margin was measured against', () => {
    const margin: Margins = { top: 50, right: 10, bottom: 5, left: 100 };
    const report = validate([sheetWith([place('a', 100, 5, 200, 520)])], gap, margin);
    // Top clearance is 600 - 525 = 75, fine; left and bottom sit exactly on
    // their margins; nothing should be flagged.
    expect(report.ok).toBe(true);

    const overTop = validate([sheetWith([place('a', 100, 5, 200, 560)])], gap, margin);
    expect(overTop.ok).toBe(false);
    expect(overTop.issues[0].side).toBe('top');
    expect(overTop.issues[0].message).toMatch(/from the top edge/);
  });
});

describe('cutouts under anisotropic spacing', () => {
  const hostPlate = () =>
    part('host plate', { exterior: rect(0, 0, 900, 400), interiors: [hole(200, 50, 700, 350)] });

  it('shrinks a cutout by the larger gap, since a cutout edge can run any way', () => {
    const settings: NestSettings = { ...base, gap: { x: 20, y: 2 }, nestInHoles: true };
    const result = nest([hostPlate(), plain('insert', 400, 200)], settings);
    const insert = result.sheets[0].placements.find((p) => p.name === 'insert');
    expect(insert?.nestedIn).toBe('host plate');
    expect(result.validation.ok).toBe(true);

    // Measured against the cutout where it actually sits on the sheet, which
    // is the host's own placement offset by the margins.
    const host = result.sheets[0].placements.find((p) => p.name === 'host plate')!;
    const cutout = host.outline.interiors[0];
    expect(insert!.x - Math.min(...cutout.map((p) => p.x))).toBeCloseTo(20, 3);
    expect(insert!.y - Math.min(...cutout.map((p) => p.y))).toBeCloseTo(20, 3);
    expect(result.validation.minGap).toBeCloseTo(20, 3);
  });

  it('will not squeeze a part in on the smaller gap', () => {
    // 470 mm wide needs the cutout inset by 15 or less; the larger gap is 20.
    const settings: NestSettings = { ...base, gap: { x: 20, y: 2 }, nestInHoles: true };
    const result = nest([hostPlate(), plain('insert', 470, 200)], settings);
    expect(result.sheets[0].placements.every((p) => p.nestedIn === undefined)).toBe(true);
    expect(result.validation.ok).toBe(true);
  });
});
