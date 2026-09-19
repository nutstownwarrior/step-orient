import type { Mesh } from './types';

export interface PlateFrame {
  /** Unit plate normal in the mesh's own frame. */
  normal: [number, number, number];
  /** Extent along the normal, i.e. the material thickness. */
  thickness: number;
}

interface NormalBin {
  n: [number, number, number];
  area: number;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalise(v: [number, number, number]): [number, number, number] | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 0)) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Area-weighted triangle normals, binned by direction.
 *
 * Opposite normals are folded together (a plate's two faces point opposite ways
 * but describe the same axis), and near-parallel normals are merged so a
 * tessellated planar face counts once.
 */
function normalBins(mesh: Mesh, tolDeg = 1): NormalBin[] {
  const p = mesh.positions;
  const idx = mesh.indices;
  const bins: NormalBin[] = [];
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (!(len > 0)) continue;
    const area = len / 2;
    let n: [number, number, number] = [cx / len, cy / len, cz / len];
    // Fold antipodal directions onto one hemisphere.
    if (n[0] < -1e-12 || (Math.abs(n[0]) <= 1e-12 && (n[1] < -1e-12 || (Math.abs(n[1]) <= 1e-12 && n[2] < 0)))) {
      n = [-n[0], -n[1], -n[2]];
    }

    let merged = false;
    for (const bin of bins) {
      if (dot(bin.n, n) >= cosTol) {
        // Weighted running average, then renormalise.
        const w = bin.area + area;
        const avg = normalise([
          (bin.n[0] * bin.area + n[0] * area) / w,
          (bin.n[1] * bin.area + n[1] * area) / w,
          (bin.n[2] * bin.area + n[2] * area) / w,
        ]);
        if (avg) bin.n = avg;
        bin.area = w;
        merged = true;
        break;
      }
    }
    if (!merged) bins.push({ n, area });

    // Heavily tessellated curved surfaces can produce a bin per triangle, which
    // would make the linear merge scan quadratic. Periodically drop the
    // smallest bins: a plate's faces are by far the largest and always survive.
    if (bins.length > 4096) {
      bins.sort((x, y) => y.area - x.area);
      bins.length = 512;
    }
  }
  bins.sort((a, b) => b.area - a.area);
  return bins;
}

function extentAlong(mesh: Mesh, n: readonly number[]): number {
  const p = mesh.positions;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * n[0] + p[i + 1] * n[1] + p[i + 2] * n[2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return hi - lo;
}

/**
 * SPEC 3.1 — find the plate normal.
 *
 * Take the largest-area distinct normal directions as candidate axes and keep
 * the one the solid is thinnest along; that extent is the material thickness.
 *
 * Deliberately not PCA and not the axis-aligned bounding box: parts arrive in
 * assembly coordinates at arbitrary orientations, and an AABB gives the wrong
 * answer for anything rotated off-axis.
 */
export function findPlateFrame(mesh: Mesh, candidates = 20): PlateFrame {
  const bins = normalBins(mesh);
  if (bins.length === 0) throw new Error('mesh has no triangles with area');

  let best: PlateFrame | null = null;
  for (const bin of bins.slice(0, candidates)) {
    const thickness = extentAlong(mesh, bin.n);
    if (!best || thickness < best.thickness) best = { normal: bin.n, thickness };
  }
  return best!;
}

/**
 * Rotation matrix (row-major 3x3) taking `normal` to +Z.
 *
 * Any rotation with that property works — the in-plane orientation is fixed
 * later by the minimum-area rectangle, so no particular choice of reference
 * direction matters here.
 */
export function frameToZ(normal: readonly [number, number, number]): number[] {
  const n = normal;
  // Pick a seed axis that is not parallel to n.
  const seed: [number, number, number] =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ux = seed[1] * n[2] - seed[2] * n[1];
  const uy = seed[2] * n[0] - seed[0] * n[2];
  const uz = seed[0] * n[1] - seed[1] * n[0];
  const ul = Math.hypot(ux, uy, uz);
  const u: [number, number, number] = [ux / ul, uy / ul, uz / ul];
  const v: [number, number, number] = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];
  // Rows are the new basis vectors, so m * p = (p.u, p.v, p.n).
  return [u[0], u[1], u[2], v[0], v[1], v[2], n[0], n[1], n[2]];
}
