import { packInto, packOne, SORT_ORDERS, sortItems, type Box, type PackItem, type Placed } from './maxrects';
import { holeBins, pointInRing } from './holes';
import { bounds, mapOutline, rotateOutline, translateRing } from './orient';
import { outlineArea } from './outline';
import { validate } from './validate';
import type { Gaps, Margins, NestResult, NestSettings, Part, Placement, Sheet } from './types';

export class PartTooLargeError extends Error {
  constructor(
    readonly partName: string,
    readonly partW: number,
    readonly partH: number,
    readonly sheetW: number,
    readonly sheetH: number,
    readonly usableW = sheetW,
    readonly usableH = sheetH
  ) {
    super(
      `${partName} is ${partW.toFixed(1)} x ${partH.toFixed(1)} mm and does not fit on a ` +
        `${sheetW} x ${sheetH} mm sheet, which leaves ${usableW.toFixed(1)} x ` +
        `${usableH.toFixed(1)} mm once the edge margins are taken off`
    );
    this.name = 'PartTooLargeError';
  }
}

interface Instance {
  id: string;
  part: Part;
}

/** Thicknesses within 0.01 mm of each other are the same board. */
const thicknessKey = (t: number) => Math.round(t * 100) / 100;

function expand(parts: Part[]): Instance[] {
  const out: Instance[] = [];
  for (const part of parts) {
    for (let i = 0; i < Math.max(1, Math.floor(part.quantity)); i++) {
      out.push({ id: `${part.id}#${i}`, part });
    }
  }
  return out;
}

/**
 * SPEC 4 — the footprints a part is allowed to occupy.
 *
 * Grain locked means the long edge of the minimum-area rectangle runs along
 * the sheet X axis; 0 deg and 180 deg give the same footprint, so one box
 * covers both. The per-part override turns that instance a quarter turn, for
 * a visible face where the grain has to run across the short dimension.
 */
function boxesFor(part: Part, settings: NestSettings, gap: Gaps): Box[] {
  // Inflate after rotating, not before: the X gap always belongs to the box's
  // width and the Y gap to its height, whichever way the part is turned.
  const upright = { w: part.boxW + gap.x, h: part.boxH + gap.y, rotation: 0 };
  const turned = { w: part.boxH + gap.x, h: part.boxW + gap.y, rotation: 90 };
  switch (settings.orientation) {
    case 'grain-locked':
      return part.grainOverride ? [turned] : [upright];
    case 'quarter-turns':
      return [upright, turned];
    case 'free':
      throw new Error('free rotation is not implemented in v1 — use grain locked or 90 deg steps');
  }
}

interface GroupLayout {
  bins: Placement[][];
  utilisation: number;
}

/** How many rounds of "fill the cutouts of what was just placed" to run. */
const HOLE_ROUNDS = 4;

/**
 * SPEC 5 — the spacing trick.
 *
 * Inflate every part's box by `gap` in both dimensions and pack into a region
 * of (sheetW - 2*margin + gap) x (sheetH - 2*margin + gap), then add `margin`
 * back to every placed coordinate. That guarantees at least `gap` between any
 * two parts and at least `margin` from every edge by construction, with no
 * collision tests during placement.
 */
function packGroup(
  instances: Instance[],
  settings: NestSettings,
  gap: Gaps,
  sheetW: number,
  sheetH: number
): GroupLayout {
  const partOf = new Map(instances.map((i) => [i.id, i.part]));
  const margin = settings.margin;
  const usableW = sheetW - margin.left - margin.right;
  const usableH = sheetH - margin.bottom - margin.top;
  const regionW = usableW + gap.x;
  const regionH = usableH + gap.y;

  const items: PackItem[] = instances.map((inst) => ({
    id: inst.id,
    boxes: boxesFor(inst.part, settings, gap),
  }));

  for (const item of items) {
    const fits = item.boxes.some((b) => b.w <= regionW + 1e-9 && b.h <= regionH + 1e-9);
    if (!fits) {
      const part = instances.find((i) => i.id === item.id)!.part;
      throw new PartTooLargeError(part.name, part.boxW, part.boxH, sheetW, sheetH, usableW, usableH);
    }
  }

  const partArea = instances.reduce((sum, i) => sum + i.part.area, 0);

  let best: GroupLayout | null = null;
  for (const order of SORT_ORDERS) {
    const bins: Placement[][] = [];
    let remaining = sortItems(items, order.key);
    // One iteration per part is the most that can ever be needed; the guard
    // above already rules out a part that cannot fit at all, so this only
    // protects against a packer bug hanging the worker.
    for (let guard = 0; guard <= items.length && remaining.length > 0; guard++) {
      const { placed, rejected } = packOne(regionW, regionH, remaining);
      if (placed.length === 0) {
        throw new Error(`nesting made no progress with ${remaining.length} parts left to place`);
      }
      const sheet = placed.map((p) => toPlacement(p, partOf.get(p.id)!, gap, margin));
      const filled = settings.nestInHoles
        ? fillCutouts(sheet, rejected, partOf, gap, margin)
        : { placements: sheet, leftover: rejected };
      bins.push(filled.placements);
      remaining = filled.leftover;
    }
    if (remaining.length > 0) throw new Error('nesting did not place every part');

    const utilisation = partArea / (bins.length * sheetW * sheetH);
    // Fewest sheets wins; utilisation breaks the tie. Running all five orders
    // costs nothing and reliably beats any single heuristic.
    if (!best || bins.length < best.bins.length || (bins.length === best.bins.length && utilisation > best.utilisation)) {
      best = { bins, utilisation };
    }
  }
  return best!;
}

/**
 * Drop the parts the sheet had no room for into the cutouts of the parts that
 * did fit.
 *
 * Only ever run on parts the sheet itself rejected, so it can reduce the sheet
 * count but never make a layout worse. Newly placed parts may have cutouts of
 * their own, so it repeats until nothing more lands.
 */
function fillCutouts(
  placements: Placement[],
  rejected: PackItem[],
  partOf: Map<string, Part>,
  gap: Gaps,
  margin: Margins
): { placements: Placement[]; leftover: PackItem[] } {
  const all = [...placements];
  let hosts = placements;
  let pending = rejected;

  for (let round = 0; round < HOLE_ROUNDS && pending.length > 0; round++) {
    const rects = holeBins(hosts, gap, margin);
    if (rects.length === 0) break;
    const { placed, rejected: stillOut } = packInto(rects, pending);
    if (placed.length === 0) break;
    hosts = placed.map((p) => ({
      ...toPlacement(p, partOf.get(p.id)!, gap, margin),
      nestedIn: hostNameAt(all, p, gap, margin),
    }));
    all.push(...hosts);
    pending = stillOut;
  }
  return { placements: all, leftover: pending };
}

/**
 * Which already-placed part's cutout a nested placement landed in.
 *
 * The placement's own centre is tested against the cutout ring itself rather
 * than its bounding box, so an L-shaped or slotted cutout does not claim a
 * part that actually sits in the cutout next to it.
 */
function hostNameAt(placements: Placement[], placed: Placed, gap: Gaps, margin: Margins): string | undefined {
  const x = placed.x + margin.left + (placed.w - gap.x) / 2;
  const y = placed.y + margin.bottom + (placed.h - gap.y) / 2;
  for (const host of placements) {
    for (const hole of host.outline.interiors) {
      if (pointInRing(x, y, hole)) return host.name;
    }
  }
  return undefined;
}

function toPlacement(placed: Placed, part: Part, gap: Gaps, margin: Margins): Placement {
  const oriented = rotateOutline(part.outline, placed.rotation);
  const b = bounds(oriented);
  // The packed region starts at the bottom-left corner of the usable area.
  const x = placed.x + margin.left;
  const y = placed.y + margin.bottom;
  return {
    partId: part.id,
    name: part.name,
    x,
    y,
    w: placed.w - gap.x,
    h: placed.h - gap.y,
    rotation: placed.rotation,
    outline: mapOutline(oriented, (r) => translateRing(r, x - b.minX, y - b.minY)),
  };
}

/** Nest every part onto sheets of the given fixed size. */
export function nest(parts: Part[], settings: NestSettings): NestResult {
  // SPEC 5 — the kerf is material the cutter removes, so it adds to the gap.
  const gap: Gaps = { x: settings.gap.x + settings.kerf, y: settings.gap.y + settings.kerf };

  // SPEC 5 — parts of different thickness cannot share a sheet, and silently
  // mixing them is a real-money bug.
  const groups = new Map<number, Part[]>();
  for (const part of parts) {
    const key = thicknessKey(part.thickness);
    const list = groups.get(key);
    if (list) list.push(part);
    else groups.set(key, [part]);
  }

  const thicknesses = [...groups.keys()].sort((a, b) => a - b);
  const sheets: Sheet[] = [];

  for (const thickness of thicknesses) {
    const instances = expand(groups.get(thickness)!);
    const layout = packGroup(instances, settings, gap, settings.sheetWidth, settings.sheetHeight);
    for (const placements of layout.bins) {
      sheets.push({
        index: sheets.length,
        width: settings.sheetWidth,
        height: settings.sheetHeight,
        thickness,
        placements,
        utilisation:
          placements.reduce((s, pl) => s + outlineArea(pl.outline), 0) /
          (settings.sheetWidth * settings.sheetHeight),
      });
    }
  }

  const totalPartArea = parts.reduce((s, p) => s + p.area * Math.max(1, Math.floor(p.quantity)), 0);
  return {
    sheets,
    thicknesses,
    totalPartArea,
    utilisation: totalPartArea / (sheets.length * settings.sheetWidth * settings.sheetHeight),
    validation: validate(sheets, gap, settings.margin),
  };
}

/** How many sheets of a candidate size the job needs, without building them. */
export function sheetCount(parts: Part[], settings: NestSettings): { sheets: number; utilisation: number } {
  const result = nest(parts, settings);
  return { sheets: result.sheets.length, utilisation: result.utilisation };
}
