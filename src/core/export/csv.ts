import type { Sheet } from '../types';

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** SPEC 8 — cut list: part name, quantity, width, height, thickness, sheet number. */
export function cutListCsv(sheets: Sheet[]): string {
  const rows: (string | number)[][] = [
    ['part', 'quantity', 'width_mm', 'height_mm', 'thickness_mm', 'sheet'],
  ];
  for (const sheet of sheets) {
    // One row per distinct part per sheet, with the count on that sheet.
    const counts = new Map<string, { name: string; w: number; h: number; n: number }>();
    for (const p of sheet.placements) {
      const key = `${p.name}|${p.w.toFixed(3)}|${p.h.toFixed(3)}`;
      const entry = counts.get(key);
      if (entry) entry.n++;
      else counts.set(key, { name: p.name, w: p.w, h: p.h, n: 1 });
    }
    for (const e of counts.values()) {
      rows.push([e.name, e.n, e.w.toFixed(2), e.h.toFixed(2), sheet.thickness.toFixed(2), sheet.index + 1]);
    }
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
