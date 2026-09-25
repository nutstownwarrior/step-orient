import { intersect, area as pathArea, FillRule, type Path64, type Paths64 } from 'clipper2-ts';
import { SCALE } from './outline';
import { SIDES } from './types';
import type {
  Gaps,
  Margins,
  Outline,
  Pt,
  Ring,
  Sheet,
  ValidationIssue,
  ValidationReport,
} from './types';

/**
 * SPEC 6 — independent post-pack check on the actual placed polygons.
 *
 * This deliberately re-derives everything from the placed outlines rather than
 * trusting the packer's bookkeeping. The whole value of the tool is that the
 * numbers are trustworthy; a plausible-looking layout that is 2 mm out is worse
 * than no tool at all.
 */
/**
 * Integer rounding at 0.1 um can leave a sliver where two outlines touch
 * exactly. A real overlap is orders of magnitude larger than this.
 */
const OVERLAP_TOLERANCE = 1e-3; // mm^2

export function validate(
  sheets: Sheet[],
  gap: Gaps,
  margin: Margins,
  tolerance = 1e-6
): ValidationReport {
  const issues: ValidationIssue[] = [];
  let minGap = Infinity;
  const minMargin: Margins = { top: Infinity, right: Infinity, bottom: Infinity, left: Infinity };
  // A pair far enough apart in every direction satisfies whichever axis gap
  // applies to it, so this is the threshold the diagonal case has to clear.
  const maxGap = Math.max(gap.x, gap.y);

  for (const sheet of sheets) {
    const items = sheet.placements;

    for (const p of items) {
      const b = ringBounds(p.outline.exterior);
      const clearance: Margins = {
        left: b.minX,
        right: sheet.width - b.maxX,
        bottom: b.minY,
        top: sheet.height - b.maxY,
      };
      for (const side of SIDES) {
        if (clearance[side] < minMargin[side]) minMargin[side] = clearance[side];
      }

      if (SIDES.some((side) => clearance[side] < -tolerance)) {
        issues.push({
          kind: 'outside-sheet',
          sheet: sheet.index,
          parts: [p.name],
          measured: Math.min(...SIDES.map((side) => clearance[side])),
          required: 0,
          message: `${p.name} extends past the edge of sheet ${sheet.index + 1}`,
        });
      } else {
        for (const side of SIDES) {
          if (clearance[side] >= margin[side] - tolerance) continue;
          issues.push({
            kind: 'margin',
            sheet: sheet.index,
            parts: [p.name],
            side,
            measured: clearance[side],
            required: margin[side],
            message: `${p.name} is ${clearance[side].toFixed(3)} mm from the ${side} edge of sheet ${
              sheet.index + 1
            }, less than the ${margin[side]} mm ${side} margin`,
          });
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const sep = axisSeparation(a.outline, b.outline);
        const boxDist = Math.hypot(sep.x, sep.y);
        // Polygon distance is never less than bounding-box distance, so a pair
        // already further apart than both the worst seen and the larger gap
        // can neither lower the reported minimum nor fail the check.
        if (boxDist > minGap && boxDist >= maxGap - tolerance) continue;

        if (boxDist <= tolerance && overlapArea(a.outline, b.outline) > OVERLAP_TOLERANCE) {
          minGap = 0;
          issues.push({
            kind: 'overlap',
            sheet: sheet.index,
            parts: [a.name, b.name],
            measured: 0,
            required: maxGap,
            message: `${a.name} overlaps ${b.name} on sheet ${sheet.index + 1}`,
          });
          continue;
        }

        const d = outlineDistance(a.outline, b.outline);
        if (d < minGap) minGap = d;

        // Two parts satisfy the gap if they are clear along one axis by that
        // axis's gap, or — the case of a part nested in a cutout, where
        // neither projection separates — clear in every direction by the
        // larger of the two.
        const clear =
          sep.x >= gap.x - tolerance || sep.y >= gap.y - tolerance || d >= maxGap - tolerance;
        if (!clear) {
          issues.push({
            kind: 'gap',
            sheet: sheet.index,
            parts: [a.name, b.name],
            measured: d,
            required: maxGap,
            message:
              `${a.name} and ${b.name} on sheet ${sheet.index + 1} are ${sep.x.toFixed(3)} mm ` +
              `apart horizontally and ${sep.y.toFixed(3)} mm vertically ` +
              `(${d.toFixed(3)} mm at the closest point), against a ${gap.x} mm horizontal ` +
              `and ${gap.y} mm vertical gap`,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    minGap,
    minMargin,
    issues,
  };
}

function ringBounds(ring: Ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * How far apart the two outlines are along each axis, zero where their
 * projections onto that axis overlap.
 */
function axisSeparation(a: Outline, b: Outline): { x: number; y: number } {
  const ba = ringBounds(a.exterior);
  const bb = ringBounds(b.exterior);
  return {
    x: Math.max(0, Math.max(ba.minX - bb.maxX, bb.minX - ba.maxX)),
    y: Math.max(0, Math.max(ba.minY - bb.maxY, bb.minY - ba.maxY)),
  };
}

const toPath = (ring: Ring): Path64 =>
  ring.map((p) => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));

/**
 * The material a part actually occupies: its exterior with its cutouts taken
 * out. Exteriors are wound counter-clockwise and cutouts clockwise, so the
 * non-zero fill rule leaves the cutouts empty.
 *
 * Using the filled region rather than the exterior alone is what lets a part
 * sit inside another part's cutout without reading as an overlap.
 */
const filledRegion = (outline: Outline): Paths64 => [
  toPath(outline.exterior),
  ...outline.interiors.map(toPath),
];

function overlapArea(a: Outline, b: Outline): number {
  const result = intersect(filledRegion(a), filledRegion(b), FillRule.NonZero);
  let total = 0;
  for (const path of result) total += Math.abs(pathArea(path));
  return total / (SCALE * SCALE);
}

const allRings = (outline: Outline): Ring[] => [outline.exterior, ...outline.interiors];

/**
 * Minimum distance between two non-overlapping parts, over every pair of
 * rings.
 *
 * For two parts side by side this is the exterior-to-exterior distance, since
 * any path from a cutout of one to the other must cross that part's own
 * exterior first. For a part sitting inside another's cutout it is the
 * distance to the cutout edge, which is the clearance that actually matters.
 */
export function outlineDistance(a: Outline, b: Outline): number {
  let best = Infinity;
  for (const ra of allRings(a)) {
    for (const rb of allRings(b)) {
      for (let i = 0; i < ra.length; i++) {
        const p1 = ra[i];
        const p2 = ra[(i + 1) % ra.length];
        for (let j = 0; j < rb.length; j++) {
          const q1 = rb[j];
          const q2 = rb[(j + 1) % rb.length];
          const d = segmentDistance(p1, p2, q1, q2);
          if (d < best) best = d;
          if (best === 0) return 0;
        }
      }
    }
  }
  return best;
}

function segmentDistance(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegmentDistance(p1, q1, q2),
    pointSegmentDistance(p2, q1, q2),
    pointSegmentDistance(q1, p1, p2),
    pointSegmentDistance(q2, p1, p2)
  );
}

function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
