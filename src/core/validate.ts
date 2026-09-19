import { intersect, area as pathArea, FillRule, type Path64, type Paths64 } from 'clipper2-ts';
import { SCALE } from './outline';
import type { Outline, Pt, Ring, Sheet, ValidationIssue, ValidationReport } from './types';

/**
 * SPEC 6 — independent post-pack check on the actual placed polygons.
 *
 * This deliberately re-derives everything from the placed outlines rather than
 * trusting the packer's bookkeeping. The whole value of the tool is that the
 * numbers are trustworthy; a plausible-looking layout that is 2 mm out is worse
 * than no tool at all.
 */
export function validate(
  sheets: Sheet[],
  gap: number,
  margin: number,
  tolerance = 1e-6
): ValidationReport {
  const issues: ValidationIssue[] = [];
  let minGap = Infinity;
  let minMargin = Infinity;

  for (const sheet of sheets) {
    const items = sheet.placements;

    for (const p of items) {
      const b = ringBounds(p.outline.exterior);
      const clearance = Math.min(b.minX, b.minY, sheet.width - b.maxX, sheet.height - b.maxY);
      if (clearance < minMargin) minMargin = clearance;
      if (b.minX < -tolerance || b.minY < -tolerance || b.maxX > sheet.width + tolerance || b.maxY > sheet.height + tolerance) {
        issues.push({
          kind: 'outside-sheet',
          sheet: sheet.index,
          parts: [p.name],
          measured: clearance,
          required: margin,
          message: `${p.name} extends past the edge of sheet ${sheet.index + 1}`,
        });
      } else if (clearance < margin - tolerance) {
        issues.push({
          kind: 'margin',
          sheet: sheet.index,
          parts: [p.name],
          measured: clearance,
          required: margin,
          message: `${p.name} is ${clearance.toFixed(3)} mm from the edge of sheet ${
            sheet.index + 1
          }, less than the ${margin} mm margin`,
        });
      }
    }

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const boxDist = boxDistance(a.outline, b.outline);
        // Polygon distance is never less than bounding-box distance, so a pair
        // that is already further apart than the worst seen cannot lower it.
        if (boxDist > minGap && boxDist >= gap - tolerance) continue;

        if (boxDist <= tolerance && overlapArea(a.outline, b.outline) > tolerance) {
          minGap = 0;
          issues.push({
            kind: 'overlap',
            sheet: sheet.index,
            parts: [a.name, b.name],
            measured: 0,
            required: gap,
            message: `${a.name} overlaps ${b.name} on sheet ${sheet.index + 1}`,
          });
          continue;
        }

        const d = outlineDistance(a.outline, b.outline);
        if (d < minGap) minGap = d;
        if (d < gap - tolerance) {
          issues.push({
            kind: 'gap',
            sheet: sheet.index,
            parts: [a.name, b.name],
            measured: d,
            required: gap,
            message: `${a.name} and ${b.name} are ${d.toFixed(3)} mm apart on sheet ${
              sheet.index + 1
            }, less than the ${gap} mm gap`,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    minGap: Number.isFinite(minGap) ? minGap : Infinity,
    minMargin: Number.isFinite(minMargin) ? minMargin : Infinity,
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

function boxDistance(a: Outline, b: Outline): number {
  const ba = ringBounds(a.exterior);
  const bb = ringBounds(b.exterior);
  const dx = Math.max(0, Math.max(ba.minX - bb.maxX, bb.minX - ba.maxX));
  const dy = Math.max(0, Math.max(ba.minY - bb.maxY, bb.minY - ba.maxY));
  return Math.hypot(dx, dy);
}

const toPath = (ring: Ring): Path64 =>
  ring.map((p) => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));

function overlapArea(a: Outline, b: Outline): number {
  const subject: Paths64 = [toPath(a.exterior)];
  const clip: Paths64 = [toPath(b.exterior)];
  const result = intersect(subject, clip, FillRule.NonZero);
  let total = 0;
  for (const path of result) total += Math.abs(pathArea(path));
  return total / (SCALE * SCALE);
}

/** Minimum distance between two non-overlapping outlines, exterior to exterior. */
export function outlineDistance(a: Outline, b: Outline): number {
  let best = Infinity;
  const ea = a.exterior;
  const eb = b.exterior;
  for (let i = 0; i < ea.length; i++) {
    const p1 = ea[i];
    const p2 = ea[(i + 1) % ea.length];
    for (let j = 0; j < eb.length; j++) {
      const q1 = eb[j];
      const q2 = eb[(j + 1) % eb.length];
      const d = segmentDistance(p1, p2, q1, q2);
      if (d < best) best = d;
      if (best === 0) return 0;
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
