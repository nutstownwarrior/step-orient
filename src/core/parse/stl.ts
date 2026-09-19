import type { Mesh } from '../types';

/**
 * SPEC 2 — STL is optional and shares the mesh code path with STEP.
 *
 * STL has no units, no solid grouping and no shared vertices; it is here so a
 * mesh exported from anywhere at all can still be nested.
 */
export function parseStl(buffer: ArrayBuffer, name: string): Mesh[] {
  const mesh = isAsciiStl(buffer) ? parseAsciiStl(buffer, name) : parseBinaryStl(buffer, name);
  if (mesh.indices.length === 0) throw new Error(`${name} contains no triangles`);
  return [mesh];
}

function isAsciiStl(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
  if (!/^\s*solid/i.test(head)) return false;
  // A binary STL may still start with "solid"; the length check is decisive.
  const view = new DataView(buffer);
  if (buffer.byteLength < 84) return true;
  const count = view.getUint32(80, true);
  return 84 + count * 50 !== buffer.byteLength;
}

function parseBinaryStl(buffer: ArrayBuffer, name: string): Mesh {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const positions = new Float64Array(count * 9);
  const indices = new Uint32Array(count * 3);
  let offset = 84;
  for (let t = 0; t < count; t++) {
    offset += 12; // the per-facet normal, which we recompute anyway
    for (let v = 0; v < 3; v++) {
      const base = t * 9 + v * 3;
      positions[base] = view.getFloat32(offset, true);
      positions[base + 1] = view.getFloat32(offset + 4, true);
      positions[base + 2] = view.getFloat32(offset + 8, true);
      indices[t * 3 + v] = t * 3 + v;
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  return { name, positions, indices };
}

function parseAsciiStl(buffer: ArrayBuffer, name: string): Mesh {
  const text = new TextDecoder().decode(buffer);
  const coords: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) coords.push(Number(m[1]), Number(m[2]), Number(m[3]));
  const n = Math.floor(coords.length / 9) * 9;
  const indices = new Uint32Array(n / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { name, positions: Float64Array.from(coords.slice(0, n)), indices };
}
