import { inflatePaths, EndType, JoinType, type Path64 } from 'clipper2-ts';
import { pruneContained, type Rect } from './maxrects';
import { ringArea, SCALE } from './outline';
import type { Placement, Ring } from './types';

/**
 * Nesting into the cutouts of other parts.
 *
 * The packer works on rectangles, so a cutout is turned into the set of
 * maximal axis-aligned rectangles that fit inside it, shrunk by the gap first
 * so anything placed there keeps its clearance from the host part. Those
 * rectangles are then handed to MaxRects exactly like any other free area.
 *
 * Every rectangle produced here is guaranteed to lie wholly inside the cutout:
 * a grid cell counts as usable only if no edge of the cutout passes through it,
 * so a curved or angled cutout gives up the cells its edges cross rather than
 * quietly letting a part overhang into solid material.
 */

const EPS = 1e-9;

/** Grid budget per cutout. A polygonised circle is the expensive case. */
const MAX_CELLS = 4096;
/** Cap on the rectangles one cutout contributes, largest first. */
const MAX_RECTS = 48;

const toPath = (ring: Ring): Path64 =>
  ring.map((p) => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));

/** Shrink a cutout inwards so a part placed in it keeps `gap` from the edge. */
export function insetRing(ring: Ring, gap: number): Ring[] {
  const ccw = ringArea(ring) >= 0 ? ring : ring.slice().reverse();
  if (gap <= 0) return [ccw];
  const shrunk = inflatePaths([toPath(ccw)], -gap * SCALE, JoinType.Miter, EndType.Polygon, 2);
  return shrunk
    .map((path) => path.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE })))
    .filter((r) => r.length >= 3 && ringArea(r) > 0);
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > EPS);
}

/** Thin a list of grid lines down to `max`, always keeping the two extremes. */
function limitLines(values: number[], max: number): number[] {
  if (values.length <= max || max < 2) return values;
  const out = [values[0]];
  const step = (values.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(values[Math.round(i * step)]);
  out.push(values[values.length - 1]);
  return uniqueSorted(out);
}

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Does the segment pass through the open interior of the rectangle?
 *
 * Liang-Barsky clip, then a midpoint test: a segment lying exactly along an
 * edge of the rectangle clips to a positive length but never has an interior
 * midpoint, which is what keeps a rectilinear cutout lossless.
 */
function crossesRect(
  ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < EPS) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, ax - x0) || !clip(dx, x1 - ax) || !clip(-dy, ay - y0) || !clip(dy, y1 - ay)) {
    return false;
  }
  if (t1 - t0 <= EPS) return false;
  const tm = (t0 + t1) / 2;
  const mx = ax + tm * dx;
  const my = ay + tm * dy;
  return mx > x0 + EPS && mx < x1 - EPS && my > y0 + EPS && my < y1 - EPS;
}

/**
 * The maximal axis-aligned rectangles that fit inside a simple polygon.
 *
 * Exact for a rectilinear polygon — the overwhelmingly common case, since CAD
 * cutouts are rectangles and slots — and conservative for anything else.
 */
export function maximalRectangles(ring: Ring, maxCells = MAX_CELLS, maxRects = MAX_RECTS): Rect[] {
  const perAxis = Math.max(2, Math.floor(Math.sqrt(maxCells)) + 1);
  const xs = limitLines(uniqueSorted(ring.map((p) => p.x)), perAxis);
  const ys = limitLines(uniqueSorted(ring.map((p) => p.y)), perAxis);
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols < 1 || rows < 1) return [];

  const inside: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const x0 = xs[c];
      const x1 = xs[c + 1];
      const y0 = ys[r];
      const y1 = ys[r + 1];
      let usable = pointInRing((x0 + x1) / 2, (y0 + y1) / 2, ring);
      if (usable) {
        for (let i = 0; i < ring.length && usable; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          if (crossesRect(a.x, a.y, b.x, b.y, x0, y0, x1, y1)) usable = false;
        }
      }
      row.push(usable);
    }
    inside.push(row);
  }

  const rects: Rect[] = [];
  for (let r1 = 0; r1 < rows; r1++) {
    const open = new Array<boolean>(cols).fill(true);
    for (let r2 = r1; r2 < rows; r2++) {
      for (let c = 0; c < cols; c++) if (!inside[r2][c]) open[c] = false;
      let c = 0;
      while (c < cols) {
        if (!open[c]) {
          c++;
          continue;
        }
        let end = c;
        while (end + 1 < cols && open[end + 1]) end++;
        // Runs are maximal horizontally by construction; keep only the ones
        // that cannot grow vertically either, so the list stays short.
        const canGrowUp = r1 > 0 && spanInside(inside[r1 - 1], c, end);
        const canGrowDown = r2 + 1 < rows && spanInside(inside[r2 + 1], c, end);
        if (!canGrowUp && !canGrowDown) {
          rects.push({
            x: xs[c],
            y: ys[r1],
            w: xs[end + 1] - xs[c],
            h: ys[r2 + 1] - ys[r1],
          });
        }
        c = end + 1;
      }
    }
  }

  return pruneContained(rects)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, maxRects);
}

const spanInside = (row: boolean[], from: number, to: number): boolean => {
  for (let c = from; c <= to; c++) if (!row[c]) return false;
  return true;
};

/**
 * Free rectangles inside the cutouts of parts already placed on a sheet,
 * expressed in the packer's coordinates: origin shifted by `margin`, and each
 * rectangle grown by `gap` to match the inflated boxes the packer places.
 */
export function holeBins(placements: Placement[], gap: number, margin: number): Rect[] {
  const rects: Rect[] = [];
  for (const placement of placements) {
    for (const hole of placement.outline.interiors) {
      for (const region of insetRing(hole, gap)) {
        for (const r of maximalRectangles(region)) {
          rects.push({ x: r.x - margin, y: r.y - margin, w: r.w + gap, h: r.h + gap });
        }
      }
    }
  }
  return rects;
}
