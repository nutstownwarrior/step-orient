/** A point in the plane, in millimetres. */
export interface Pt {
  x: number;
  y: number;
}

/** A closed ring. First point is not repeated at the end. */
export type Ring = Pt[];

/** A part outline: one exterior ring plus any number of interior rings. */
export interface Outline {
  exterior: Ring;
  interiors: Ring[];
}

export interface Mesh {
  /** Flat [x,y,z, x,y,z, ...] in the file's own units. */
  positions: Float64Array;
  /** Flat triangle vertex indices. */
  indices: Uint32Array;
  name: string;
}

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const UNIT_TO_MM: Record<Unit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export type OrientationMode = 'grain-locked' | 'quarter-turns' | 'free';

/** A part as extracted from a file, before nesting. */
export interface Part {
  id: string;
  name: string;
  source: string;
  /** Outline in its own local frame, already rotated so the plate normal is +Z. */
  outline: Outline;
  /** Material thickness in mm (the extent along the plate normal). */
  thickness: number;
  /** Outline area in mm^2, holes subtracted. */
  area: number;
  /** Width/height of the minimum-area rotated bounding rectangle, mm. */
  boxW: number;
  boxH: number;
  quantity: number;
  /**
   * Per-part grain override: when true this instance may be turned a quarter
   * turn even in grain-locked mode (a visible face where the grain has to run
   * across the short dimension).
   */
  grainOverride: boolean;
}

/** A part placed on a sheet. */
export interface Placement {
  partId: string;
  name: string;
  /** Lower-left corner of the placed bounding box, mm from the sheet origin. */
  x: number;
  y: number;
  /** Placed bounding-box size, mm. */
  w: number;
  h: number;
  /** Rotation applied to the oriented outline, degrees, one of 0/90/180/270. */
  rotation: number;
  /** The outline as actually placed, in sheet coordinates. */
  outline: Outline;
  /**
   * Set when this part sits inside a cutout of another part on the same sheet.
   * Names the host, because it has to be cut before the host's cutout is
   * released.
   */
  nestedIn?: string;
}

export interface Sheet {
  index: number;
  width: number;
  height: number;
  thickness: number;
  placements: Placement[];
  /** Outline area of the placed parts / sheet area. */
  utilisation: number;
}

/**
 * Clearance between parts, per axis.
 *
 * One number per axis rather than one per side: the gap between two parts is a
 * single distance that both of them share, so "the gap on A's right" and "the
 * gap on B's left" are the same measurement. What can genuinely differ is the
 * direction — you may want more room across the feed than along it.
 */
export interface Gaps {
  /** Minimum clearance between parts sitting side by side, mm. */
  x: number;
  /** Minimum clearance between parts sitting one above the other, mm. */
  y: number;
}

/** Unused strip along each edge of the sheet, mm. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Side = keyof Margins;

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

export const uniformGaps = (value: number): Gaps => ({ x: value, y: value });

export const uniformMargins = (value: number): Margins => ({
  top: value,
  right: value,
  bottom: value,
  left: value,
});

export interface NestSettings {
  gap: Gaps;
  margin: Margins;
  kerf: number;
  orientation: OrientationMode;
  sheetWidth: number;
  sheetHeight: number;
  /**
   * Pack parts the sheet had no room for into the cutouts of parts that did
   * fit. Off gives plain bounding-box nesting, where a cutout is always waste.
   */
  nestInHoles: boolean;
}

export interface ValidationIssue {
  kind: 'outside-sheet' | 'margin' | 'gap' | 'overlap';
  sheet: number;
  parts: string[];
  /** The side an edge-margin issue was measured against. */
  side?: Side;
  measured: number;
  required: number;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  /** Smallest measured part-to-part distance across all sheets, mm. */
  minGap: number;
  /** Smallest measured clearance to each sheet edge across all sheets, mm. */
  minMargin: Margins;
  issues: ValidationIssue[];
}

export interface NestResult {
  sheets: Sheet[];
  /** One group per distinct thickness. */
  thicknesses: number[];
  totalPartArea: number;
  utilisation: number;
  validation: ValidationReport;
}
