import { nest, PartTooLargeError } from './nest';
import type { NestSettings, Part } from './types';

/** SPEC 7 — sensible defaults for the "what should I buy" table. */
export const DEFAULT_STOCK_SIZES: [number, number][] = [
  [2500, 1250],
  [2440, 1220],
  [2050, 1250],
  [1200, 600],
  [1000, 600],
  [800, 600],
  [250, 2000],
  [250, 1200],
  [250, 800],
];

export interface StockOption {
  /** The candidate size as entered. */
  width: number;
  height: number;
  /** The orientation actually used; the grain runs along `usedWidth`. */
  usedWidth: number;
  usedHeight: number;
  sheets: number;
  /** Outline area / total board area bought. */
  utilisation: number;
  /** Total board area bought, mm^2. */
  materialArea: number;
  error?: string;
}

/**
 * SPEC 7 mode 2 — rank candidate stock sizes.
 *
 * Boards are sold whole, so the honest ranking is by the material you have to
 * buy, not by the fraction of it you use. Fewest sheets breaks ties.
 */
export function rankStock(
  parts: Part[],
  settings: NestSettings,
  candidates: [number, number][] = DEFAULT_STOCK_SIZES
): StockOption[] {
  const options: StockOption[] = [];
  for (const [w, h] of candidates) {
    // A board is a physical rectangle; which way round you feed it is a choice.
    // Both orientations are tried and the better one reported, so entering a
    // narrow board as "250 x 2000" does not silently rule it out just because
    // the grain axis was written second.
    const tries = w === h ? [[w, h]] : [[w, h], [h, w]];
    let best: StockOption | null = null;
    let firstError: string | undefined;

    for (const [sw, sh] of tries as [number, number][]) {
      try {
        const result = nest(parts, { ...settings, sheetWidth: sw, sheetHeight: sh });
        const option: StockOption = {
          width: w,
          height: h,
          usedWidth: sw,
          usedHeight: sh,
          sheets: result.sheets.length,
          utilisation: result.utilisation,
          materialArea: result.sheets.length * sw * sh,
        };
        if (!best || option.materialArea < best.materialArea || (option.materialArea === best.materialArea && option.sheets < best.sheets)) {
          best = option;
        }
      } catch (err) {
        firstError ??= err instanceof PartTooLargeError ? err.message : String((err as Error).message ?? err);
      }
    }

    options.push(
      best ?? {
        width: w,
        height: h,
        usedWidth: w,
        usedHeight: h,
        sheets: Infinity,
        utilisation: 0,
        materialArea: Infinity,
        error: firstError ?? 'could not nest onto this size',
      }
    );
  }
  return options.sort((a, b) => a.materialArea - b.materialArea || a.sheets - b.sheets);
}

export interface BoardResult {
  /** Board width (the constrained dimension), mm. */
  boardWidth: number;
  /** Shortest single board that fits the whole job, mm; null if impossible. */
  minLength: number | null;
  /** How many boards of each standard length would be needed instead. */
  standard: { length: number; boards: number; error?: string }[];
  error?: string;
}

const fitsOnOne = (parts: Part[], settings: NestSettings, width: number, length: number): boolean => {
  try {
    return nest(parts, { ...settings, sheetWidth: length, sheetHeight: width }).sheets.length === 1;
  } catch {
    return false;
  }
};

/**
 * SPEC 7 — max width constraint.
 *
 * The supplier only sells boards up to some width, so the width is fixed and
 * the length is the free variable. Binary-search the shortest board that still
 * takes the whole job in one piece, and report it next to the standard lengths.
 *
 * Feasibility is very nearly monotonic in length but not provably so for a
 * heuristic packer, so the search starts from a length that certainly works
 * (everything in a single row) and narrows from there.
 */
export function minimumBoardLength(
  parts: Part[],
  settings: NestSettings,
  boardWidth: number,
  standardLengths: number[] = [],
  tolerance = 0.01
): BoardResult {
  const gap = settings.gap + settings.kerf;
  const usableWidth = boardWidth - 2 * settings.margin;

  const instances = parts.flatMap((p) =>
    Array.from({ length: Math.max(1, Math.floor(p.quantity)) }, () => p)
  );
  if (instances.length === 0) {
    return { boardWidth, minLength: null, standard: [], error: 'no parts to nest' };
  }

  // A part whose short side exceeds the usable width can never fit, whatever
  // the length is.
  for (const p of instances) {
    const across = settings.orientation === 'grain-locked' && !p.grainOverride ? p.boxH : Math.min(p.boxW, p.boxH);
    if (across > usableWidth + 1e-9) {
      return {
        boardWidth,
        minLength: null,
        standard: standardLengths.map((length) => ({ length, boards: Infinity })),
        error: `${p.name} is ${across.toFixed(1)} mm across, wider than the ${usableWidth.toFixed(
          1
        )} mm usable width of a ${boardWidth} mm board`,
      };
    }
  }

  // Everything laid end to end always fits; that is the upper bound.
  let hi =
    2 * settings.margin +
    instances.reduce((s, p) => s + p.boxW + gap, 0) -
    gap;
  if (!fitsOnOne(parts, settings, boardWidth, hi)) {
    // Should not happen, but never report a length that does not actually work.
    hi *= 2;
    if (!fitsOnOne(parts, settings, boardWidth, hi)) {
      return { boardWidth, minLength: null, standard: [], error: 'could not fit the job on a single board' };
    }
  }

  // Area gives a hard lower bound no packing can beat.
  const totalArea = instances.reduce((s, p) => s + (p.boxW + gap) * (p.boxH + gap), 0);
  let lo = Math.max(
    ...instances.map((p) => p.boxW + 2 * settings.margin),
    totalArea / (usableWidth + gap) + 2 * settings.margin - gap
  );
  if (fitsOnOne(parts, settings, boardWidth, lo)) hi = lo;

  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (fitsOnOne(parts, settings, boardWidth, mid)) hi = mid;
    else lo = mid;
  }

  // Report to 0.1 mm, preferring the rounded value when it genuinely fits so
  // the number quoted to a supplier is the true minimum rather than a hair over.
  const rounded = Math.round(hi * 10) / 10;
  const minLength = fitsOnOne(parts, settings, boardWidth, rounded)
    ? rounded
    : Math.ceil(hi * 10) / 10;
  return {
    boardWidth,
    minLength,
    standard: standardLengths.map((length) => {
      try {
        const result = nest(parts, { ...settings, sheetWidth: length, sheetHeight: boardWidth });
        return { length, boards: result.sheets.length };
      } catch (err) {
        return { length, boards: Infinity, error: String((err as Error).message ?? err) };
      }
    }),
  };
}
