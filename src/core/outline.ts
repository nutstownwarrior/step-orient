import {
  area as pathArea,
  union,
  inflatePaths,
  simplifyPaths,
  pointInPolygon,
  FillRule,
  JoinType,
  EndType,
  PointInPolygonResult,
  type Path64,
  type Paths64,
} from 'clipper2-ts';
import type { Mesh, Outline, Ring } from './types';
import { findPlateFrame, frameToZ } from './plate';

/**
 * Clipper2 works on scaled integers. 1e4 gives 0.1 µm resolution, which keeps
 * a 2.5 m sheet four orders of magnitude clear of the 2^53 safe-integer limit.
 */
export const SCALE = 1e4;

/** Close tessellation cracks: offset out then back in by this much (mm). */
const CRACK = 0.01;
/** Collinear-vertex tolerance (mm). Straight edges must survive untouched. */
const SIMPLIFY = 0.005;

export interface ExtractedOutline {
  outline: Outline;
  thickness: number;
}

const fromPath = (path: Path64): Ring => path.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE }));

export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * SPEC 3.2/3.3 — project every triangle and union them.
 *
 * NOT a cross-section. Parts routinely have chamfers, rebates and
 * countersinks, so a mid-plane slice comes out smaller than the blank you
 * actually have to cut. The union of all projected triangles is the maximum
 * silhouette: the envelope that covers the part at every depth. Through-holes
 * survive the union and become interior rings; blind pockets vanish, which is
 * correct — you do not cut those on the profile.
 */
export function outlineFromMesh(mesh: Mesh, scaleToMm = 1): ExtractedOutline {
  const frame = findPlateFrame(mesh);
  const m = frameToZ(frame.normal);

  const p = mesh.positions;
  const idx = mesh.indices;

  // Rotate into the plate frame and drop Z.
  const n = p.length / 3;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0, v = 0; i < p.length; i += 3, v++) {
    const x = p[i] * scaleToMm;
    const y = p[i + 1] * scaleToMm;
    const z = p[i + 2] * scaleToMm;
    px[v] = m[0] * x + m[1] * y + m[2] * z;
    py[v] = m[3] * x + m[4] * y + m[5] * z;
  }

  const subject: Paths64 = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    const ax = Math.round(px[a] * SCALE);
    const ay = Math.round(py[a] * SCALE);
    const bx = Math.round(px[b] * SCALE);
    const by = Math.round(py[b] * SCALE);
    const cx = Math.round(px[c] * SCALE);
    const cy = Math.round(py[c] * SCALE);
    // Triangles seen edge-on project to a degenerate sliver; skip them.
    const twice = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (twice === 0) continue;
    // NonZero filling needs consistent winding: the solid's two faces wind
    // opposite ways once projected, so force every triangle the same way.
    subject.push(
      twice > 0
        ? [{ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }]
        : [{ x: ax, y: ay }, { x: cx, y: cy }, { x: bx, y: by }]
    );
  }
  if (subject.length === 0) throw new Error('part projects to nothing');

  let paths = union(subject, FillRule.NonZero);

  // Close the hairline cracks a tessellator can leave between adjacent
  // triangles, then come straight back. Miter joins keep corners sharp.
  paths = inflatePaths(paths, CRACK * SCALE, JoinType.Miter, EndType.Polygon, 100);
  paths = inflatePaths(paths, -CRACK * SCALE, JoinType.Miter, EndType.Polygon, 100);

  // Drop the vertices tessellation left along straight runs. A rectangular
  // part must come back out with exactly four vertices.
  paths = simplifyPaths(paths, SIMPLIFY * SCALE, true);

  return { outline: largestOutline(paths), thickness: frame.thickness * scaleToMm };
}

/**
 * SPEC 3.3 — keep only the largest outer ring, retaining its interior rings.
 *
 * A solid occasionally projects to several disjoint islands (a part modelled
 * with a detached tab, say); cutting the largest is the useful answer.
 * Clipper hands back outer rings and holes with opposite winding, which is
 * enough to classify them without walking a PolyTree.
 */
function largestOutline(paths: Paths64): Outline {
  let best: Path64 | null = null;
  let bestArea = 0;
  for (const path of paths) {
    if (path.length < 3) continue;
    const a = pathArea(path);
    if (Math.abs(a) > Math.abs(bestArea)) {
      bestArea = a;
      best = path;
    }
  }
  if (!best) throw new Error('outline union produced no rings');

  const interiors: Ring[] = [];
  for (const path of paths) {
    if (path === best || path.length < 3) continue;
    const a = pathArea(path);
    // Same winding as the exterior means a separate island, not a hole.
    if (a === 0 || Math.sign(a) === Math.sign(bestArea)) continue;
    if (pointInPolygon(path[0], best) === PointInPolygonResult.IsOutside) continue;
    interiors.push(fromPath(path));
  }

  const exterior = fromPath(best);
  // Exterior counter-clockwise, interiors clockwise — the convention the
  // exporters and the validator both assume.
  return {
    exterior: ringArea(exterior) >= 0 ? exterior : exterior.slice().reverse(),
    interiors: interiors.map((r) => (ringArea(r) <= 0 ? r : r.slice().reverse())),
  };
}

/** Signed-area sum: exterior minus holes, mm^2. */
export function outlineArea(outline: Outline): number {
  let a = Math.abs(ringArea(outline.exterior));
  for (const hole of outline.interiors) a -= Math.abs(ringArea(hole));
  return a;
}
