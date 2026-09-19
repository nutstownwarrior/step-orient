import { grainArrow } from './dxf';
import type { Ring, Sheet } from '../types';

export interface DrawOptions {
  /** Pixels per millimetre. */
  scale: number;
  labels: boolean;
  dark: boolean;
}

/**
 * Draw one sheet. Shared by the on-screen preview and the PNG export so the
 * downloaded image is exactly what was on screen.
 */
export function drawSheet(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  sheet: Sheet,
  opts: DrawOptions
): void {
  const s = opts.scale;
  const pad = 14;
  const colours = opts.dark
    ? { bg: '#14161a', board: '#1e222a', edge: '#3a4050', cut: '#8fd0ff', label: '#9aa4b2', grain: '#5ac8a0' }
    : { bg: '#ffffff', board: '#fbfbfa', edge: '#c8ccd4', cut: '#1b3a5c', label: '#6b7280', grain: '#0f7f62' };

  ctx.save();
  ctx.fillStyle = colours.bg;
  ctx.fillRect(0, 0, sheet.width * s + pad * 2, sheet.height * s + pad * 2);

  // Millimetres, Y up.
  ctx.translate(pad, sheet.height * s + pad);
  ctx.scale(s, -s);
  ctx.lineJoin = 'round';

  ctx.fillStyle = colours.board;
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.strokeStyle = colours.edge;
  ctx.lineWidth = 1 / s;
  ctx.strokeRect(0, 0, sheet.width, sheet.height);

  ctx.strokeStyle = colours.cut;
  ctx.lineWidth = 1.2 / s;
  for (const p of sheet.placements) {
    trace(ctx, p.outline.exterior);
    ctx.stroke();
    for (const hole of p.outline.interiors) {
      trace(ctx, hole);
      ctx.stroke();
    }
  }

  // SPEC 4 — a grain arrow on every sheet preview.
  ctx.strokeStyle = colours.grain;
  ctx.lineWidth = 1.6 / s;
  const arrowLen = Math.min(sheet.width / 8, 110);
  const arrow = grainArrow(8, sheet.height - 8, arrowLen);
  trace(ctx, arrow, false);
  ctx.stroke();

  ctx.restore();

  if (!opts.labels) return;

  // Labels are drawn back in pixel space so the text is not mirrored.
  ctx.save();
  ctx.translate(pad, pad);
  ctx.fillStyle = colours.label;
  ctx.textBaseline = 'top';
  const fontSize = 11;
  ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  for (const p of sheet.placements) {
    const x = p.x * s + 3;
    const y = (sheet.height - p.y - p.h) * s + 3;
    if (p.w * s < 34 || p.h * s < 15) continue;
    clipText(ctx, p.name, x, y, p.w * s - 6);
    if (p.h * s > 28) {
      clipText(ctx, `${p.w.toFixed(1)} x ${p.h.toFixed(1)}`, x, y + fontSize + 2, p.w * s - 6);
    }
  }
  ctx.fillStyle = colours.grain;
  ctx.fillText('grain', pad + 4, 2);
  ctx.restore();
}

function trace(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ring: Ring,
  close = true
): void {
  ctx.beginPath();
  ring.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (close) ctx.closePath();
}

function clipText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number
): void {
  let value = text;
  while (value.length > 1 && ctx.measureText(value).width > maxWidth) value = value.slice(0, -1);
  if (value !== text && value.length > 1) value = `${value.slice(0, -1)}…`;
  ctx.fillText(value, x, y);
}

/** Render a sheet to a PNG blob at the given resolution. */
export async function sheetToPng(sheet: Sheet, pixelsPerMm = 2, dark = false): Promise<Blob> {
  const pad = 14;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(sheet.width * pixelsPerMm) + pad * 2;
  canvas.height = Math.ceil(sheet.height * pixelsPerMm) + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2d canvas context');
  drawSheet(ctx, sheet, { scale: pixelsPerMm, labels: true, dark });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}
