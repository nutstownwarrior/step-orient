import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { outlineArea, outlineFromMesh } from '../src/core/outline';
import { canonicalise } from '../src/core/orient';
import { readStep, type OcctModule } from '../src/core/parse/occt';
import type { Part } from '../src/core/types';

const require = createRequire(import.meta.url);
let occt: Promise<OcctModule> | null = null;

export function fixtureOcct(): Promise<OcctModule> {
  occt ??= require('occt-import-js')();
  return occt!;
}

/** The SPEC 10 fixture, parsed exactly as the worker parses an upload. */
export async function loadFixtureParts(dir = 'fixtures/box'): Promise<Part[]> {
  const module = await fixtureOcct();
  const parts: Part[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ste?p$/i.test(file)) continue;
    const meshes = readStep(module, new Uint8Array(readFileSync(`${dir}/${file}`)), file);
    meshes.forEach((mesh, i) => {
      const { outline, thickness } = outlineFromMesh(mesh);
      const canon = canonicalise(outline);
      parts.push({
        id: `${file}:${i}`,
        name: mesh.name,
        source: file,
        outline: canon.outline,
        thickness,
        area: outlineArea(canon.outline),
        boxW: canon.w,
        boxH: canon.h,
        quantity: 1,
        rotation: 'auto',
      });
    });
  }
  return parts;
}
