import { describe, expect, it } from 'vitest';
import { canonicalise, minAreaRect, rotateOutline } from '../src/core/orient';
import { packOne, sortItems, SORT_ORDERS } from '../src/core/maxrects';
import { nest, PartTooLargeError } from '../src/core/nest';
import { minimumBoardLength, rankStock } from '../src/core/sheets';
import { validate } from '../src/core/validate';
import { detectDxfUnit, detectStepUnit } from '../src/core/units';
import { parseDxfOutlines } from '../src/core/parse/dxf';
import { sheetToDxf } from '../src/core/export/dxf';
import { sheetToSvg } from '../src/core/export/svg';
import { cutListCsv } from '../src/core/export/csv';
import type { NestSettings, Outline, Part, Ring, Sheet } from '../src/core/types';

const rect = (w: number, h: number, x = 0, y = 0): Ring => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const outlineOf = (w: number, h: number): Outline => ({ exterior: rect(w, h), interiors: [] });

const rotate = (ring: Ring, deg: number): Ring => {
  const a = (deg * Math.PI) / 180;
  return ring.map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
};

function part(name: string, w: number, h: number, thickness = 10, quantity = 1): Part {
  const canon = canonicalise(outlineOf(w, h));
  return {
    id: name,
    name,
    source: 'test',
    outline: canon.outline,
    thickness,
    area: w * h,
    boxW: canon.w,
    boxH: canon.h,
    quantity,
    grainOverride: false,
  };
}

const settings: NestSettings = {
  gap: 5,
  margin: 10,
  kerf: 0,
  orientation: 'grain-locked',
  sheetWidth: 1000,
  sheetHeight: 600,
};

describe('minimum-area rectangle', () => {
  it('measures a rectangle rotated in its own plane, where an AABB would not', () => {
    const tilted = rotate(rect(300, 120), 37);
    const r = minAreaRect(tilted);
    expect(r.long).toBeCloseTo(300, 6);
    expect(r.short).toBeCloseTo(120, 6);

    const xs = tilted.map((p) => p.x);
    const ys = tilted.map((p) => p.y);
    // The axis-aligned box of the same ring is far bigger, which is the whole
    // reason SPEC 4 asks for the minimum-area one.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(310);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(230);
  });

  it('puts the long side along X and the lower-left corner at the origin', () => {
    const canon = canonicalise({ exterior: rotate(rect(120, 300, 40, -90), 200), interiors: [] });
    expect(canon.w).toBeCloseTo(300, 3);
    expect(canon.h).toBeCloseTo(120, 3);
    const xs = canon.outline.exterior.map((p) => p.x);
    const ys = canon.outline.exterior.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
  });

  it('swaps the extents on a quarter turn and keeps the origin', () => {
    const turned = rotateOutline(canonicalise(outlineOf(300, 120)).outline, 90);
    const xs = turned.exterior.map((p) => p.x);
    const ys = turned.exterior.map((p) => p.y);
    expect(Math.max(...xs)).toBeCloseTo(120, 6);
    expect(Math.max(...ys)).toBeCloseTo(300, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
  });
});

describe('MaxRects', () => {
  it('drops a small part into the gap beside a tall one, which a shelf packer cannot', () => {
    const { placed, rejected } = packOne(100, 100, [
      { id: 'tall', boxes: [{ w: 60, h: 100, rotation: 0 }] },
      { id: 'a', boxes: [{ w: 40, h: 50, rotation: 0 }] },
      { id: 'b', boxes: [{ w: 40, h: 50, rotation: 0 }] },
    ]);
    expect(rejected).toHaveLength(0);
    expect(placed).toHaveLength(3);
    // Everything fits exactly, so the bin is full.
    expect(placed.reduce((s, p) => s + p.w * p.h, 0)).toBe(100 * 100);
  });

  it('never places two parts on top of each other', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      boxes: [{ w: 40 + (i % 7) * 13, h: 25 + (i % 5) * 19, rotation: 0 }],
    }));
    const { placed } = packOne(400, 400, items);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const overlap =
          a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('offers five sort orders, each a different ordering tool', () => {
    expect(SORT_ORDERS.map((o) => o.name)).toEqual([
      'area',
      'longest side',
      'height',
      'width',
      'perimeter',
    ]);
    const items = [
      { id: 'wide', boxes: [{ w: 300, h: 10, rotation: 0 }] },
      { id: 'tall', boxes: [{ w: 10, h: 200, rotation: 0 }] },
    ];
    expect(sortItems(items, SORT_ORDERS[2].key)[0].id).toBe('tall');
    expect(sortItems(items, SORT_ORDERS[3].key)[0].id).toBe('wide');
  });
});

describe('nesting', () => {
  it('keeps the requested gap and margin by construction', () => {
    const parts = Array.from({ length: 12 }, (_, i) => part(`p${i}`, 180 + i * 7, 90 + (i % 4) * 11));
    const result = nest(parts, settings);
    expect(result.validation.ok).toBe(true);
    expect(result.validation.minGap).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(result.validation.minMargin).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it('adds the kerf to the gap', () => {
    const parts = Array.from({ length: 6 }, (_, i) => part(`p${i}`, 200, 150));
    const result = nest(parts, { ...settings, gap: 4, kerf: 3 });
    expect(result.validation.minGap).toBeGreaterThanOrEqual(7 - 1e-6);
    expect(result.validation.ok).toBe(true);
  });

  it('never puts parts of different thickness on the same sheet', () => {
    const parts = [part('thin', 200, 100, 6), part('thick', 200, 100, 18), part('thin b', 200, 100, 6)];
    const result = nest(parts, settings);
    expect(result.thicknesses).toEqual([6, 18]);
    expect(result.sheets).toHaveLength(2);
    for (const sheet of result.sheets) {
      const names = sheet.placements.map((p) => p.name);
      expect(names.every((n) => n.startsWith('thin')) || names.every((n) => n === 'thick')).toBe(true);
    }
  });

  it('names the part and its size when it cannot fit the sheet', () => {
    const parts = [part('oversize panel', 1200, 400)];
    expect(() => nest(parts, settings)).toThrow(PartTooLargeError);
    try {
      nest(parts, settings);
    } catch (err) {
      expect((err as Error).message).toContain('oversize panel');
      expect((err as Error).message).toContain('1200.0');
      expect((err as Error).message).toContain('1000 x 600');
    }
  });

  it('carries rejects onto the next sheet', () => {
    const parts = Array.from({ length: 9 }, (_, i) => part(`p${i}`, 480, 280));
    const result = nest(parts, settings);
    expect(result.sheets.length).toBeGreaterThan(1);
    expect(result.sheets.reduce((s, sh) => s + sh.placements.length, 0)).toBe(9);
  });

  it('expands quantity into separate placements', () => {
    const result = nest([part('repeat', 200, 150, 10, 4)], settings);
    expect(result.sheets[0].placements).toHaveLength(4);
  });

  it('throws a clear error for free rotation', () => {
    expect(() => nest([part('p', 200, 100)], { ...settings, orientation: 'free' })).toThrow(
      /not implemented/i
    );
  });

  it('turns a part a quarter turn when the grain override is set', () => {
    const across = { ...part('across', 300, 100), grainOverride: true };
    const along = part('along', 300, 100);
    const result = nest([across, along], settings);
    const placed = Object.fromEntries(result.sheets[0].placements.map((p) => [p.name, p]));
    expect(placed['along'].rotation).toBe(0);
    expect(placed['along'].w).toBeCloseTo(300, 3);
    expect(placed['across'].rotation).toBe(90);
    expect(placed['across'].w).toBeCloseTo(100, 3);
  });

  it('may turn any part a quarter turn in 90-degree mode', () => {
    // A 540 mm part is longer than a 300 mm wide sheet, so with the grain
    // locked it simply does not fit; turned a quarter turn it does.
    const board = { ...settings, sheetWidth: 300, sheetHeight: 600 };
    const parts = [part('a', 540, 90), part('b', 540, 90)];
    expect(() => nest(parts, board)).toThrow(PartTooLargeError);

    const turned = nest(parts, { ...board, orientation: 'quarter-turns' });
    expect(turned.sheets).toHaveLength(1);
    expect(turned.sheets[0].placements.every((p) => p.rotation === 90)).toBe(true);
    expect(turned.validation.ok).toBe(true);
  });
});

describe('validation', () => {
  const sheetWith = (placements: Sheet['placements']): Sheet => ({
    index: 0,
    width: 1000,
    height: 600,
    thickness: 10,
    placements,
    utilisation: 0,
  });

  const placement = (name: string, x: number, y: number, w: number, h: number) => ({
    partId: name,
    name,
    x,
    y,
    w,
    h,
    rotation: 0,
    outline: { exterior: rect(w, h, x, y), interiors: [] },
  });

  it('passes a layout that respects the gap and margin', () => {
    const report = validate([sheetWith([placement('a', 10, 10, 100, 100), placement('b', 115, 10, 100, 100)])], 5, 10);
    expect(report.ok).toBe(true);
    expect(report.minGap).toBeCloseTo(5, 9);
    expect(report.minMargin).toBeCloseTo(10, 9);
  });

  it('catches a gap that is 2 mm short', () => {
    const report = validate([sheetWith([placement('a', 10, 10, 100, 100), placement('b', 113, 10, 100, 100)])], 5, 10);
    expect(report.ok).toBe(false);
    expect(report.minGap).toBeCloseTo(3, 9);
    expect(report.issues[0].kind).toBe('gap');
    expect(report.issues[0].message).toMatch(/3\.000 mm apart/);
  });

  it('catches an overlap', () => {
    const report = validate([sheetWith([placement('a', 10, 10, 100, 100), placement('b', 60, 10, 100, 100)])], 5, 10);
    expect(report.issues.some((i) => i.kind === 'overlap')).toBe(true);
  });

  it('catches a part hanging off the sheet, and one inside the margin', () => {
    const off = validate([sheetWith([placement('a', 950, 10, 100, 100)])], 5, 10);
    expect(off.issues[0].kind).toBe('outside-sheet');

    const tight = validate([sheetWith([placement('a', 4, 10, 100, 100)])], 5, 10);
    expect(tight.issues[0].kind).toBe('margin');
    expect(tight.minMargin).toBeCloseTo(4, 9);
  });

  it('measures the diagonal distance between parts, not just the axis gap', () => {
    const report = validate(
      [sheetWith([placement('a', 10, 10, 100, 100), placement('b', 113, 113, 100, 100)])],
      5,
      10
    );
    expect(report.minGap).toBeCloseTo(Math.hypot(3, 3), 6);
  });
});

describe('unit detection', () => {
  it('reads metres from a STEP header', () => {
    expect(detectStepUnit('#1=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );')).toEqual({
      unit: 'm',
      source: 'step-header',
    });
  });

  it('reads millimetres from a STEP header', () => {
    expect(detectStepUnit('#194=(\nLENGTH_UNIT()\nNAMED_UNIT(*)\nSI_UNIT(.MILLI.,.METRE.)\n);').unit).toBe('mm');
  });

  it('reads inches from a conversion-based unit', () => {
    expect(detectStepUnit("#190=( CONVERSION_BASED_UNIT('INCH',#192) NAMED_UNIT(#191) LENGTH_UNIT() );").unit).toBe('in');
  });

  it('falls back to millimetres when a file says nothing', () => {
    expect(detectStepUnit('ISO-10303-21;').source).toBe('assumed');
  });

  it('reads $INSUNITS from a DXF, and treats unitless as unknown', () => {
    expect(detectDxfUnit('9\n$INSUNITS\n70\n4\n').unit).toBe('mm');
    expect(detectDxfUnit('9\n$INSUNITS\n70\n1\n').unit).toBe('in');
    expect(detectDxfUnit('9\n$INSUNITS\n70\n0\n').source).toBe('assumed');
  });
});

describe('DXF input', () => {
  const lwpolyline = (layer: string, points: [number, number][]) =>
    ['0', 'LWPOLYLINE', '8', layer, '90', String(points.length), '70', '1', '43', '0.0']
      .concat(points.flatMap(([x, y]) => ['10', String(x), '20', String(y)]))
      .join('\n');

  const doc = (...entities: string[]) =>
    ['0', 'SECTION', '2', 'ENTITIES', ...entities.join('\n').split('\n'), '0', 'ENDSEC', '0', 'EOF'].join('\n');

  it('reads a closed polyline as a part outline', () => {
    const outlines = parseDxfOutlines(
      doc(lwpolyline('0', [[0, 0], [200, 0], [200, 100], [0, 100]]))
    );
    expect(outlines).toHaveLength(1);
    expect(outlines[0].exterior).toHaveLength(4);
    expect(outlines[0].interiors).toHaveLength(0);
  });

  it('folds a ring inside another into a hole rather than a second part', () => {
    const outlines = parseDxfOutlines(
      doc(
        lwpolyline('0', [[0, 0], [200, 0], [200, 100], [0, 100]]),
        lwpolyline('0', [[20, 20], [60, 20], [60, 60], [20, 60]])
      )
    );
    expect(outlines).toHaveLength(1);
    expect(outlines[0].interiors).toHaveLength(1);
  });

  it('keeps two side-by-side rings as two parts', () => {
    const outlines = parseDxfOutlines(
      doc(
        lwpolyline('0', [[0, 0], [200, 0], [200, 100], [0, 100]]),
        lwpolyline('0', [[300, 0], [500, 0], [500, 100], [300, 100]])
      )
    );
    expect(outlines).toHaveLength(2);
  });

  it('ignores open polylines', () => {
    const open = doc(
      ['0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '0', '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10'].join('\n')
    );
    expect(parseDxfOutlines(open)).toHaveLength(0);
  });
});

describe('exports', () => {
  const sheet: Sheet = {
    index: 0,
    width: 1000,
    height: 600,
    thickness: 10,
    utilisation: 0.5,
    placements: [
      {
        partId: 'a',
        name: 'panel, front',
        x: 10,
        y: 10,
        w: 200,
        h: 100,
        rotation: 0,
        outline: { exterior: rect(200, 100, 10, 10), interiors: [rect(20, 20, 30, 30)] },
      },
    ],
  };

  it('writes DXF with millimetre units and the four required layers', () => {
    const dxf = sheetToDxf(sheet);
    expect(dxf).toContain('$INSUNITS');
    expect(dxf).toMatch(/\$INSUNITS\n70\n4\n/);
    for (const layer of ['CUT', 'SHEET', 'LABEL', 'GRAIN']) expect(dxf).toContain(`\n${layer}\n`);
    expect(dxf.startsWith('0\nSECTION\n')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    // Sheet outline, the part exterior and its one hole.
    expect(dxf.match(/\nLWPOLYLINE\n/g)).toHaveLength(4);
    expect(dxf).toContain('panel, front');
  });

  it('writes SVG in millimetres with a path per part', () => {
    const svg = sheetToSvg(sheet);
    expect(svg).toContain('width="1000mm"');
    expect(svg).toContain('viewBox="0 0 1000 600"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('data-part="panel, front"');
  });

  it('writes a cut list with the columns SPEC 8 asks for', () => {
    const csv = cutListCsv([sheet, { ...sheet, index: 1 }]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('part,quantity,width_mm,height_mm,thickness_mm,sheet');
    expect(lines[1]).toBe('"panel, front",1,200.00,100.00,10.00,1');
    expect(lines[2].endsWith(',2')).toBe(true);
  });
});

describe('sheet sizing', () => {
  const parts = Array.from({ length: 8 }, (_, i) => part(`p${i}`, 300, 200, 10, 1 + (i % 2)));

  it('ranks candidate stock sizes by the material actually bought', () => {
    const ranked = rankStock(parts, settings, [
      [1000, 600],
      [2500, 1250],
      [250, 200],
    ]);
    expect(ranked[0].materialArea).toBeLessThanOrEqual(ranked[1].materialArea);
    // A 250 x 200 board cannot take a 300 x 200 part either way round.
    const tiny = ranked.find((o) => o.width === 250)!;
    expect(tiny.error).toMatch(/does not fit/);
    expect(tiny.sheets).toBe(Infinity);
  });

  it('tries a candidate board both ways round', () => {
    // 900 long and 200 across only works with the long side as the grain axis.
    const job = [part('a', 800, 150), part('b', 800, 150)];
    const ranked = rankStock(job, settings, [[200, 900]]);
    expect(ranked[0].error).toBeUndefined();
    expect(ranked[0].usedWidth).toBe(900);
    expect(ranked[0].usedHeight).toBe(200);
    expect(ranked[0].width).toBe(200);
  });

  it('reports a board too narrow for the job instead of searching forever', () => {
    const board = minimumBoardLength([part('wide', 400, 260)], settings, 200, [2000]);
    expect(board.minLength).toBeNull();
    expect(board.error).toMatch(/wider than/);
  });

  it('finds a minimum length that genuinely fits, and one millimetre less that does not', () => {
    const job = [part('a', 300, 100), part('b', 300, 100), part('c', 300, 100)];
    const board = minimumBoardLength(job, settings, 150, []);
    expect(board.minLength).not.toBeNull();
    const length = board.minLength!;
    expect(nest(job, { ...settings, sheetWidth: length, sheetHeight: 150 }).sheets).toHaveLength(1);
    expect(
      nest(job, { ...settings, sheetWidth: length - 1, sheetHeight: 150 }).sheets.length
    ).toBeGreaterThan(1);
  });
});
