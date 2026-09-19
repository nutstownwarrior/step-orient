/**
 * MaxRects bin packing, best-short-side-fit.
 *
 * SPEC 5 — deliberately not shelf/guillotine packing, which wastes noticeably
 * more material on mixed part sizes. MaxRects keeps the free area as a list of
 * maximal free rectangles, so a small part can drop into the gap beside a tall
 * one instead of being stuck on the next shelf.
 */

const EPS = 1e-9;

export interface Box {
  w: number;
  h: number;
  rotation: number;
}

export interface PackItem {
  id: string;
  /** Candidate footprints, one per permitted rotation. */
  boxes: Box[];
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackResult {
  placed: Placed[];
  rejected: PackItem[];
}

export class MaxRects {
  private free: Rect[];

  constructor(width: number, height: number) {
    this.free = width > 0 && height > 0 ? [{ x: 0, y: 0, w: width, h: height }] : [];
  }

  /** Place one item, or return null if nothing fits. */
  insert(item: PackItem): Placed | null {
    let best: Placed | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;

    for (const box of item.boxes) {
      for (const f of this.free) {
        const dw = f.w - box.w;
        const dh = f.h - box.h;
        if (dw < -EPS || dh < -EPS) continue;
        const short = Math.min(dw, dh);
        const long = Math.max(dw, dh);
        if (short < bestShort - EPS || (short < bestShort + EPS && long < bestLong - EPS)) {
          bestShort = short;
          bestLong = long;
          best = { id: item.id, x: f.x, y: f.y, w: box.w, h: box.h, rotation: box.rotation };
        }
      }
    }
    if (best) this.place(best);
    return best;
  }

  private place(node: Placed): void {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (!this.split(f, node, next)) next.push(f);
    }
    this.free = prune(next);
  }

  /** Returns true if `f` intersected `node` and was replaced by its remnants. */
  private split(f: Rect, node: Placed, out: Rect[]): boolean {
    if (
      node.x >= f.x + f.w - EPS ||
      node.x + node.w <= f.x + EPS ||
      node.y >= f.y + f.h - EPS ||
      node.y + node.h <= f.y + EPS
    ) {
      return false;
    }
    // Up to four maximal remnants: below, above, left, right of the placement.
    if (node.x > f.x + EPS) out.push({ x: f.x, y: f.y, w: node.x - f.x, h: f.h });
    if (node.x + node.w < f.x + f.w - EPS) {
      const x = node.x + node.w;
      out.push({ x, y: f.y, w: f.x + f.w - x, h: f.h });
    }
    if (node.y > f.y + EPS) out.push({ x: f.x, y: f.y, w: f.w, h: node.y - f.y });
    if (node.y + node.h < f.y + f.h - EPS) {
      const y = node.y + node.h;
      out.push({ x: f.x, y, w: f.w, h: f.y + f.h - y });
    }
    return true;
  }
}

/** Drop free rectangles wholly contained in another. */
function prune(rects: Rect[]): Rect[] {
  const keep: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      if (contains(rects[j], rects[i]) && !(contains(rects[i], rects[j]) && j > i)) {
        contained = true;
        break;
      }
    }
    if (!contained && rects[i].w > EPS && rects[i].h > EPS) keep.push(rects[i]);
  }
  return keep;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.w <= outer.x + outer.w + EPS &&
  inner.y + inner.h <= outer.y + outer.h + EPS;

/** Pack as many items as fit into one region, in the order given. */
export function packOne(width: number, height: number, items: PackItem[]): PackResult {
  const bin = new MaxRects(width, height);
  const placed: Placed[] = [];
  const rejected: PackItem[] = [];
  for (const item of items) {
    const p = bin.insert(item);
    if (p) placed.push(p);
    else rejected.push(item);
  }
  return { placed, rejected };
}

/** The sort orders SPEC 5 asks to be tried. */
export const SORT_ORDERS: { name: string; key: (b: Box) => number }[] = [
  { name: 'area', key: (b) => b.w * b.h },
  { name: 'longest side', key: (b) => Math.max(b.w, b.h) },
  { name: 'height', key: (b) => b.h },
  { name: 'width', key: (b) => b.w },
  { name: 'perimeter', key: (b) => 2 * (b.w + b.h) },
];

export function sortItems(items: PackItem[], key: (b: Box) => number): PackItem[] {
  return items
    .map((item) => ({ item, score: Math.max(...item.boxes.map(key)) }))
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
    .map((e) => e.item);
}
