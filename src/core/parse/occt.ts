import type { Mesh } from '../types';

type OcctModule = {
  ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
};

interface OcctResult {
  success: boolean;
  meshes: {
    name?: string;
    attributes: { position: { array: number[] } };
    index: { array: number[] };
  }[];
}

type OcctFactory = (opts?: { locateFile?: (path: string) => string }) => Promise<OcctModule>;

let pending: Promise<OcctModule> | null = null;

/**
 * Load the OCCT wasm importer once per worker.
 *
 * `wasmUrl` must be resolved by the caller with `import.meta.url` so it keeps
 * working under the GitHub Pages base path.
 */
export function loadOcct(factory: OcctFactory, wasmUrl: string): Promise<OcctModule> {
  pending ??= factory({ locateFile: () => wasmUrl });
  return pending;
}

/** Every solid in the file becomes its own mesh. */
export function readStep(occt: OcctModule, bytes: Uint8Array, fallbackName: string): Mesh[] {
  const result = occt.ReadStepFile(bytes, {
    // OCCT converts the file's declared unit to this on read; we detect the
    // header unit separately, only so the UI can show it and allow an override.
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (!result.success) throw new Error(`could not read ${fallbackName} as STEP`);
  return result.meshes.map((m, i) => ({
    name: m.name && m.name.trim() ? m.name : `${fallbackName} solid ${i + 1}`,
    positions: Float64Array.from(m.attributes.position.array),
    indices: Uint32Array.from(m.index.array),
  }));
}

export type { OcctModule };
