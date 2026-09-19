import type { Ring, Sheet } from '../types';

/**
 * ASCII DXF R2010 with four layers and two entity types.
 *
 * SPEC 8 — deliberately hand-written. A DXF library is a large dependency for
 * something this small, and everything a cutting file needs is LWPOLYLINE plus
 * TEXT.
 */

const LAYERS: { name: string; colour: number }[] = [
  { name: 'CUT', colour: 7 },
  { name: 'SHEET', colour: 8 },
  { name: 'LABEL', colour: 3 },
  { name: 'GRAIN', colour: 5 },
];

class DxfWriter {
  private out: string[] = [];
  private handle = 0x100;

  nextHandle(): string {
    return (++this.handle).toString(16).toUpperCase();
  }

  pair(code: number, value: string | number): void {
    this.out.push(String(code), String(value));
  }

  text(): string {
    return `${this.out.join('\n')}\n`;
  }
}

const num = (n: number) => (Math.round(n * 1e6) / 1e6).toFixed(6);

function polyline(w: DxfWriter, layer: string, points: Ring, closed = true): void {
  w.pair(0, 'LWPOLYLINE');
  w.pair(5, w.nextHandle());
  w.pair(100, 'AcDbEntity');
  w.pair(8, layer);
  w.pair(100, 'AcDbPolyline');
  w.pair(90, points.length);
  w.pair(70, closed ? 1 : 0);
  w.pair(43, '0.0');
  for (const p of points) {
    w.pair(10, num(p.x));
    w.pair(20, num(p.y));
  }
}

function label(w: DxfWriter, layer: string, x: number, y: number, height: number, value: string): void {
  w.pair(0, 'TEXT');
  w.pair(5, w.nextHandle());
  w.pair(100, 'AcDbEntity');
  w.pair(8, layer);
  w.pair(100, 'AcDbText');
  w.pair(10, num(x));
  w.pair(20, num(y));
  w.pair(30, '0.0');
  w.pair(40, num(height));
  // DXF strings cannot carry newlines or the control characters used for
  // formatting; keep labels to plain text.
  w.pair(1, value.replace(/[\r\n^]/g, ' '));
  w.pair(100, 'AcDbText');
}

/** An arrow along +X: shaft plus two barbs, as a single open polyline. */
export function grainArrow(x: number, y: number, length: number): Ring {
  const head = length * 0.25;
  return [
    { x, y },
    { x: x + length, y },
    { x: x + length - head, y: y + head * 0.5 },
    { x: x + length, y },
    { x: x + length - head, y: y - head * 0.5 },
  ];
}

export function sheetToDxf(sheet: Sheet, jobName = 'nest'): string {
  const w = new DxfWriter();

  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1024');
  // SPEC 8 — 4 is millimetres.
  w.pair(9, '$INSUNITS');
  w.pair(70, 4);
  w.pair(9, '$EXTMIN');
  w.pair(10, '0.0');
  w.pair(20, '0.0');
  w.pair(30, '0.0');
  w.pair(9, '$EXTMAX');
  w.pair(10, num(sheet.width));
  w.pair(20, num(sheet.height));
  w.pair(30, '0.0');
  w.pair(0, 'ENDSEC');

  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  w.pair(0, 'TABLE');
  w.pair(2, 'LAYER');
  w.pair(5, w.nextHandle());
  w.pair(100, 'AcDbSymbolTable');
  w.pair(70, LAYERS.length);
  for (const layer of LAYERS) {
    w.pair(0, 'LAYER');
    w.pair(5, w.nextHandle());
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbLayerTableRecord');
    w.pair(2, layer.name);
    w.pair(70, 0);
    w.pair(62, layer.colour);
    w.pair(6, 'CONTINUOUS');
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'ENDSEC');

  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');

  polyline(w, 'SHEET', [
    { x: 0, y: 0 },
    { x: sheet.width, y: 0 },
    { x: sheet.width, y: sheet.height },
    { x: 0, y: sheet.height },
  ]);

  const textHeight = Math.max(4, Math.min(sheet.width, sheet.height) / 60);
  for (const p of sheet.placements) {
    polyline(w, 'CUT', p.outline.exterior);
    for (const hole of p.outline.interiors) polyline(w, 'CUT', hole);
    label(w, 'LABEL', p.x + textHeight * 0.4, p.y + textHeight * 0.4, textHeight, p.name);
  }

  // SPEC 4 — the grain direction has to travel with the file.
  const arrowLength = Math.min(sheet.width / 6, 150);
  polyline(w, 'GRAIN', grainArrow(0, -textHeight * 3, arrowLength), false);
  label(w, 'GRAIN', 0, -textHeight * 4.6, textHeight, `GRAIN - ${jobName} sheet ${sheet.index + 1}`);

  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  return w.text();
}
