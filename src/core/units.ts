import { UNIT_TO_MM, type Unit } from './types';

export interface DetectedUnit {
  unit: Unit;
  /** Where the unit came from, for the UI to show. */
  source: 'step-header' | 'dxf-insunits' | 'assumed';
}

/**
 * SPEC 3.4 — read the unit out of a STEP header.
 *
 * STEP files carry their own unit and Onshape writes metres. OCCT already
 * converts the geometry to millimetres on import, so this is not used to scale
 * anything by default — it is what the UI shows, and what a user override is
 * measured against when a file declares the wrong unit.
 */
export function detectStepUnit(text: string): DetectedUnit {
  // e.g. ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )
  const si = /LENGTH_UNIT\s*\(\s*\)[^;]*?SI_UNIT\s*\(\s*([^,]*?)\s*,\s*\.METRE\.\s*\)/i.exec(text)
    ?? /SI_UNIT\s*\(\s*([^,]*?)\s*,\s*\.METRE\.\s*\)[^;]*?LENGTH_UNIT\s*\(\s*\)/i.exec(text);
  if (si) {
    const prefix = si[1].trim().toUpperCase();
    if (prefix === '$' || prefix === '*' || prefix === '') return { unit: 'm', source: 'step-header' };
    if (prefix === '.MILLI.') return { unit: 'mm', source: 'step-header' };
    if (prefix === '.CENTI.') return { unit: 'cm', source: 'step-header' };
  }
  // Imperial files use a conversion-based unit whose name says what it is.
  const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'/i.exec(text);
  if (conv) {
    const name = conv[1].trim().toUpperCase();
    if (name.startsWith('INCH')) return { unit: 'in', source: 'step-header' };
    if (name.startsWith('FOOT') || name.startsWith('FEET')) return { unit: 'ft', source: 'step-header' };
  }
  return { unit: 'mm', source: 'assumed' };
}

/** DXF $INSUNITS codes, as far as this app cares. */
const INSUNITS: Record<number, Unit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };

export function detectDxfUnit(text: string): DetectedUnit {
  const m = /\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/i.exec(text);
  const unit = m ? INSUNITS[Number(m[1])] : undefined;
  // 0 means "unitless", which DXF files very often are.
  return unit ? { unit, source: 'dxf-insunits' } : { unit: 'mm', source: 'assumed' };
}

export const unitScale = (from: Unit): number => UNIT_TO_MM[from];
