/// <reference lib="webworker" />
import occtimportjs from 'occt-import-js';
import { outlineArea, outlineFromMesh } from '../core/outline';
import { canonicalise } from '../core/orient';
import { nest } from '../core/nest';
import { loadOcct, readStep, type OcctModule } from '../core/parse/occt';
import { expandArchives, extensionOf, basename } from '../core/parse/archive';
import { parseDxfOutlines } from '../core/parse/dxf';
import { parseStl } from '../core/parse/stl';
import { minimumBoardLength, rankStock } from '../core/sheets';
import { detectDxfUnit, detectStepUnit, unitScale } from '../core/units';
import type { Mesh, Outline, Part, Unit } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

// SPEC 1 — the wasm lives in public/, so its URL has to carry the Pages base
// path. Resolving against import.meta.url keeps it right in dev, in preview
// and on <user>.github.io/<repo>/ alike.
const WASM_URL = new URL(`${import.meta.env.BASE_URL}occt-import-js.wasm`, import.meta.url).href;

const post = (message: WorkerResponse) => self.postMessage(message);

let occtPromise: Promise<OcctModule> | null = null;
const occt = () => {
  occtPromise ??= loadOcct(occtimportjs as never, WASM_URL);
  return occtPromise;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'parse') await handleParse(request);
    else handleNest(request);
  } catch (err) {
    post({ id: request.id, type: 'error', message: (err as Error).message ?? String(err) });
  }
};

async function handleParse(request: Extract<WorkerRequest, { type: 'parse' }>): Promise<void> {
  const parts: Part[] = [];
  const warnings: string[] = [];
  let unit: Unit = 'mm';
  let unitSource = 'assumed';

  // SPEC 2 — a zip is not a part, it is a bag of parts. Unpack first, then the
  // per-file dispatch below never has to know an archive was involved.
  const files = expandArchives(request.files, warnings, (name) =>
    post({ id: request.id, type: 'progress', message: `Unpacking ${basename(name)}`, value: 0 })
  );

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    post({
      id: request.id,
      type: 'progress',
      message: `Reading ${basename(file.name)}`,
      value: i / files.length,
    });

    try {
      const ext = extensionOf(file.name);
      if (ext === 'step' || ext === 'stp') {
        const text = new TextDecoder().decode(new Uint8Array(file.buffer, 0, Math.min(file.buffer.byteLength, 65536)));
        const detected = detectStepUnit(text);
        unit = detected.unit;
        unitSource = detected.source;
        // OCCT already normalises the declared unit to millimetres, so an
        // override means "the header is lying": rescale by the ratio.
        const scale = request.unitOverride ? unitScale(request.unitOverride) / unitScale(detected.unit) : 1;
        const meshes = readStep(await occt(), new Uint8Array(file.buffer), stem(file.name));
        addMeshes(parts, meshes, file.name, scale, warnings);
      } else if (ext === 'stl') {
        const scale = unitScale(request.unitOverride ?? 'mm');
        addMeshes(parts, parseStl(file.buffer, stem(file.name)), file.name, scale, warnings);
      } else if (ext === 'dxf') {
        const text = new TextDecoder().decode(new Uint8Array(file.buffer));
        const detected = detectDxfUnit(text);
        unit = request.unitOverride ?? detected.unit;
        unitSource = detected.source;
        const scale = unitScale(request.unitOverride ?? detected.unit);
        const outlines = parseDxfOutlines(text);
        if (outlines.length === 0) warnings.push(`${file.name}: no closed polylines found`);
        outlines.forEach((outline, index) => {
          addOutline(parts, scaleOutline(outline, scale), `${stem(file.name)} ${index + 1}`, file.name, 0);
        });
      } else if (ext === '3mf') {
        warnings.push(`${file.name}: 3MF is not supported — export STEP or STL instead`);
      } else {
        warnings.push(`${file.name}: unrecognised file type`);
      }
    } catch (err) {
      warnings.push(`${file.name}: ${(err as Error).message ?? err}`);
    }
  }

  post({ id: request.id, type: 'progress', message: 'Extracting outlines', value: 1 });
  post({ id: request.id, type: 'parts', parts: mergeDuplicates(parts), warnings, unit, unitSource });
}

/** Name a part after its own file, not the path it arrived down. */
const stem = (name: string) => basename(name).replace(/\.[^.]+$/, '');

function addMeshes(parts: Part[], meshes: Mesh[], source: string, scale: number, warnings: string[]): void {
  meshes.forEach((mesh) => {
    try {
      const { outline, thickness } = outlineFromMesh(mesh, scale);
      addOutline(parts, outline, mesh.name, source, thickness);
    } catch (err) {
      warnings.push(`${source} / ${mesh.name}: ${(err as Error).message ?? err}`);
    }
  });
}

function scaleOutline(outline: Outline, scale: number): Outline {
  const f = (ring: Outline['exterior']) => ring.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  return { exterior: f(outline.exterior), interiors: outline.interiors.map(f) };
}

function addOutline(parts: Part[], outline: Outline, name: string, source: string, thickness: number): void {
  const canon = canonicalise(outline);
  parts.push({
    id: `${source}:${parts.length}`,
    name,
    source,
    outline: canon.outline,
    thickness,
    area: outlineArea(canon.outline),
    boxW: canon.w,
    boxH: canon.h,
    quantity: 1,
    grainOverride: false,
  });
}

/**
 * SPEC 2 — one uploaded file may contain several solids, and an assembly
 * usually repeats them. Identical outlines collapse into one row whose
 * quantity defaults to the number of instances found.
 */
function mergeDuplicates(parts: Part[]): Part[] {
  const out: Part[] = [];
  const seen = new Map<string, Part>();
  for (const part of parts) {
    const key = [
      part.name,
      part.boxW.toFixed(3),
      part.boxH.toFixed(3),
      part.thickness.toFixed(3),
      part.area.toFixed(3),
      part.outline.exterior.length,
      part.outline.interiors.length,
    ].join('|');
    const existing = seen.get(key);
    if (existing) existing.quantity++;
    else {
      seen.set(key, part);
      out.push(part);
    }
  }
  return out;
}

function handleNest(request: Extract<WorkerRequest, { type: 'nest' }>): void {
  const { parts, settings, mode } = request;
  if (parts.length === 0) throw new Error('no parts to nest');

  if (mode.kind === 'board') {
    const board = minimumBoardLength(parts, settings, mode.width, mode.standardLengths);
    const length = board.minLength ?? settings.sheetWidth;
    const result = nest(parts, { ...settings, sheetWidth: length, sheetHeight: mode.width });
    post({ id: request.id, type: 'nested', result, board });
    return;
  }

  if (mode.kind === 'candidates') {
    const stock = rankStock(parts, settings, mode.sizes);
    const best = stock.find((o) => Number.isFinite(o.materialArea));
    if (!best) throw new Error(stock[0]?.error ?? 'none of the candidate sheet sizes can take this job');
    const result = nest(parts, { ...settings, sheetWidth: best.width, sheetHeight: best.height });
    post({ id: request.id, type: 'nested', result, stock });
    return;
  }

  post({ id: request.id, type: 'nested', result: nest(parts, settings) });
}
