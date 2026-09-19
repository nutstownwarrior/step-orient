import type { Outline, Pt, Ring } from './types';

export interface MinAreaRect {
  /** Long side of the rectangle, mm. */
  long: number;
  /** Short side, mm. */
  short: number;
  /** Rotation, in radians, that brings the long side parallel to the X axis. */
  angle: number;
}

function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (src: Pt[]) => {
    const out: Pt[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build(pts.slice().reverse())];
}

/**
 * SPEC 4 — minimum-area rotated bounding rectangle, by rotating calipers.
 *
 * Not the axis-aligned box: parts arrive rotated within their own plane (a
 * panel modelled at 30° in its sketch, or simply an assembly transform), and an
 * axis-aligned box would both overstate the blank and line the grain up wrong.
 * The minimum-area rectangle always has a side flush with a hull edge, so
 * testing each hull edge is exhaustive.
 */
export function minAreaRect(ring: Ring): MinAreaRect {
  const hull = convexHull(ring);
  if (hull.length < 3) {
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return { long: Math.max(w, h), short: Math.min(w, h), angle: 0 };
  }

  let best: MinAreaRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      // Rotating by -atan2 brings the edge direction onto +X. If the box is
      // taller than it is wide along that edge, turn a further quarter turn so
      // `long` really is the X extent.
      const edgeAngle = Math.atan2(uy, ux);
      best =
        w >= h
          ? { long: w, short: h, angle: -edgeAngle }
          : { long: h, short: w, angle: -edgeAngle - Math.PI / 2 };
    }
  }
  return best!;
}

export function rotateRing(ring: Ring, angle: number): Ring {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return ring.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

export function translateRing(ring: Ring, dx: number, dy: number): Ring {
  return ring.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function mapOutline(outline: Outline, f: (r: Ring) => Ring): Outline {
  return { exterior: f(outline.exterior), interiors: outline.interiors.map(f) };
}

export function bounds(outline: Outline) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outline.exterior) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Snap every coordinate to a micron.
 *
 * Outlines come out of Clipper quantised to 0.1 µm and are then rotated into
 * the minimum-area frame, which leaves nominally identical parts differing by
 * a fraction of a micron. That is far below any tolerance a router or laser
 * cares about, but it is enough to stop the packer recognising two parts as
 * the same size — and a packer that cannot prune a redundant free rectangle
 * packs noticeably worse. Snapping makes equal parts exactly equal.
 */
const QUANTUM = 1e-3;

export function snapRing(ring: Ring): Ring {
  const snapped = ring.map((p) => ({
    x: Math.round(p.x / QUANTUM) * QUANTUM,
    y: Math.round(p.y / QUANTUM) * QUANTUM,
  }));
  // Snapping can collapse a pair of points that were already sub-micron apart.
  return snapped.filter((p, i) => {
    const q = snapped[(i + 1) % snapped.length];
    return p.x !== q.x || p.y !== q.y;
  });
}

/**
 * Bring an outline into its canonical orientation: the long side of the
 * minimum-area rectangle along +X, lower-left corner at the origin.
 *
 * Everything downstream — packing, the 0/90/180/270 placement rotations, the
 * grain arrow — is expressed relative to this frame.
 */
export function canonicalise(outline: Outline): { outline: Outline; w: number; h: number } {
  const rect = minAreaRect(outline.exterior);
  const rotated = mapOutline(outline, (r) => rotateRing(r, rect.angle));
  const b = bounds(rotated);
  const placed = mapOutline(rotated, (r) => snapRing(translateRing(r, -b.minX, -b.minY)));
  // Use the measured extents rather than the caliper numbers so the outline and
  // its declared box agree to the last decimal.
  const pb = bounds(placed);
  return { outline: placed, w: pb.w, h: pb.h };
}

/** Rotate an already-canonical outline by a quarter-turn multiple, re-zeroed. */
export function rotateOutline(outline: Outline, degrees: number): Outline {
  const angle = (degrees * Math.PI) / 180;
  const rotated = mapOutline(outline, (r) => rotateRing(r, angle));
  const b = bounds(rotated);
  return mapOutline(rotated, (r) => snapRing(translateRing(r, -b.minX, -b.minY)));
}
