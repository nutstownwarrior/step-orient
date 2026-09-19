import { pointInPolygon, PointInPolygonResult, type Path64 } from 'clipper2-ts';
import { SCALE, ringArea } from '../outline';
import type { Outline, Ring } from '../types';

/**
 * SPEC 2 — treat each closed polyline as a part outline.
 *
 * With one refinement the spec's wording leaves room for: a ring that lies
 * wholly inside another becomes that ring's interior, not a part of its own.
 * A DXF of a panel with two holes is one part with two holes, and cutting the
 * holes as separate parts would be a real-money mistake.
 */
export function parseDxfOutlines(text: string): Outline[] {
  const rings = readClosedPolylines(text);
  return groupRings(rings);
}

interface Pair {
  code: number;
  value: string;
}

function tokenise(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

function readClosedPolylines(text: string): Ring[] {
  const pairs = tokenise(text);
  const rings: Ring[] = [];

  let entity = '';
  let ring: Ring = [];
  let closed = false;
  let pendingX: number | null = null;
  let inVertexList = false;

  const flush = () => {
    if (closed && ring.length >= 3) rings.push(dedupe(ring));
    ring = [];
    closed = false;
    pendingX = null;
  };

  for (const { code, value } of pairs) {
    if (code === 0) {
      const next = value.trim().toUpperCase();
      if (entity === 'LWPOLYLINE' || (entity === 'POLYLINE' && next !== 'VERTEX')) flush();
      if (next === 'VERTEX' && entity === 'POLYLINE') {
        inVertexList = true;
        continue;
      }
      if (next !== 'VERTEX') {
        entity = next;
        inVertexList = false;
        if (entity === 'LWPOLYLINE' || entity === 'POLYLINE') {
          ring = [];
          closed = false;
          pendingX = null;
        }
      }
      continue;
    }
    if (entity !== 'LWPOLYLINE' && entity !== 'POLYLINE') continue;

    if (code === 70 && !inVertexList) {
      closed = (Number(value) & 1) === 1;
    } else if (code === 10) {
      pendingX = Number(value);
    } else if (code === 20 && pendingX !== null) {
      ring.push({ x: pendingX, y: Number(value) });
      pendingX = null;
    }
  }
  flush();
  return rings;
}

function dedupe(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) out.push(p);
  }
  // A DXF polyline may repeat its first point at the end; a ring must not.
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) out.pop();
  return out;
}

const toPath = (ring: Ring): Path64 =>
  ring.map((p) => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));

function groupRings(rings: Ring[]): Outline[] {
  const withArea = rings
    .map((ring) => ({ ring, area: Math.abs(ringArea(ring)), path: toPath(ring) }))
    .filter((r) => r.area > 1e-9)
    .sort((a, b) => b.area - a.area);

  const outlines: Outline[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < withArea.length; i++) {
    if (taken.has(i)) continue;
    const outer = withArea[i];
    const interiors: Ring[] = [];
    for (let j = i + 1; j < withArea.length; j++) {
      if (taken.has(j)) continue;
      const probe = withArea[j].path[0];
      if (pointInPolygon(probe, outer.path) !== PointInPolygonResult.IsOutside) {
        interiors.push(withArea[j].ring);
        taken.add(j);
      }
    }
    outlines.push({
      exterior: ringArea(outer.ring) >= 0 ? outer.ring : outer.ring.slice().reverse(),
      interiors: interiors.map((r) => (ringArea(r) <= 0 ? r : r.slice().reverse())),
    });
  }
  return outlines;
}
