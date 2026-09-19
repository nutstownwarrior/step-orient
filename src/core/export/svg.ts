import { grainArrow } from './dxf';
import type { Ring, Sheet } from '../types';

const path = (ring: Ring) =>
  `${ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ')} Z`;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * SPEC 8 — SVG per sheet, for anyone cutting on a laser that takes SVG.
 *
 * SVG's Y axis points down, so the whole drawing is flipped once at the top
 * rather than negating every coordinate.
 */
export function sheetToSvg(sheet: Sheet, jobName = 'nest'): string {
  const parts = sheet.placements
    .map((p) => {
      const rings = [p.outline.exterior, ...p.outline.interiors].map(path).join(' ');
      return (
        `    <path d="${rings}" fill="none" stroke="#111" stroke-width="0.5" ` +
        `fill-rule="evenodd" data-part="${escapeAttr(p.name)}"/>`
      );
    })
    .join('\n');

  const textHeight = Math.max(4, Math.min(sheet.width, sheet.height) / 60);
  const labels = sheet.placements
    .map(
      (p) =>
        `    <text x="${round(p.x + textHeight * 0.4)}" y="${round(
          p.y + textHeight * 1.4
        )}" font-size="${round(textHeight)}" font-family="sans-serif" fill="#888" ` +
        `transform="scale(1,-1) translate(0,${round(-2 * (p.y + textHeight * 1.4))})">` +
        `${escapeText(p.name)}</text>`
    )
    .join('\n');

  const arrow = grainArrow(0, -textHeight * 3, Math.min(sheet.width / 6, 150));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm"
     viewBox="0 0 ${sheet.width} ${sheet.height}">
  <title>${escapeText(jobName)} sheet ${sheet.index + 1}</title>
  <g transform="translate(0,${sheet.height}) scale(1,-1)">
    <rect x="0" y="0" width="${sheet.width}" height="${sheet.height}" fill="#fff" stroke="#bbb" stroke-width="0.5"/>
${parts}
    <path d="${arrow.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y + textHeight * 3.5)}`).join(' ')}"
          fill="none" stroke="#06c" stroke-width="0.8"/>
${labels}
  </g>
</svg>
`;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');
