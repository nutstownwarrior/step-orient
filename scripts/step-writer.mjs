// Minimal ISO-10303-21 (AP214) writer for planar-faced solids.
//
// Only what the fixtures need: MANIFOLD_SOLID_BREP made of ADVANCED_FACEs on
// PLANEs, bounded by EDGE_LOOPs of straight EDGE_CURVEs. Vertices and edges are
// shared between adjacent faces so the reader gets a properly sewn closed shell.

const F = (n) => {
  // STEP reals must contain a '.'; keep them short but exact enough for 1e-9 mm.
  if (!Number.isFinite(n)) throw new Error(`non-finite coordinate: ${n}`);
  if (Object.is(n, -0)) n = 0;
  let s = n.toPrecision(15).replace(/0+$/, '');
  if (s.includes('e') || s.includes('E')) {
    s = n.toExponential(12).replace(/e/, 'E');
    if (!s.split('E')[0].includes('.')) s = s.replace('E', '.E');
    return s;
  }
  if (!s.includes('.')) s += '.';
  return s;
};

const key = (p) => p.map((v) => (Math.round(v * 1e9) / 1e9).toFixed(9)).join('|');

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a);
  if (l === 0) throw new Error('zero-length vector');
  return [a[0] / l, a[1] / l, a[2] / l];
};

class StepFile {
  constructor() {
    this.lines = [];
    this.next = 1;
  }
  add(body) {
    const id = this.next++;
    this.lines.push(`#${id}=${body};`);
    return id;
  }
}

/**
 * @param {{name: string, unit: 'METRE'|'MILLI', faces: {outer: number[][], inners?: number[][][]}[]}} opts
 */
export function writeStep({ name, unit, faces }) {
  const f = new StepFile();

  // --- geometry ---------------------------------------------------------
  const vertexCache = new Map(); // point key -> VERTEX_POINT id
  const vertexPoint = new Map(); // VERTEX_POINT id -> coords
  const edgeCache = new Map(); // "v1,v2" (sorted) -> {id, from, to}

  const vertex = (p) => {
    const k = key(p);
    let id = vertexCache.get(k);
    if (id === undefined) {
      const cp = f.add(`CARTESIAN_POINT('',(${p.map(F).join(',')}))`);
      id = f.add(`VERTEX_POINT('',#${cp})`);
      vertexCache.set(k, id);
      vertexPoint.set(id, p);
    }
    return id;
  };

  const edge = (pa, pb) => {
    const va = vertex(pa);
    const vb = vertex(pb);
    if (va === vb) throw new Error('degenerate edge');
    const k = va < vb ? `${va},${vb}` : `${vb},${va}`;
    let e = edgeCache.get(k);
    if (!e) {
      const from = vertexPoint.get(va);
      const to = vertexPoint.get(vb);
      const d = norm(sub(to, from));
      const org = f.add(`CARTESIAN_POINT('',(${from.map(F).join(',')}))`);
      const dir = f.add(`DIRECTION('',(${d.map(F).join(',')}))`);
      const vec = f.add(`VECTOR('',#${dir},1.)`);
      const line = f.add(`LINE('',#${org},#${vec})`);
      e = { id: f.add(`EDGE_CURVE('',#${va},#${vb},#${line},.T.)`), from: va, to: vb };
      edgeCache.set(k, e);
    }
    return { e, forward: e.from === va };
  };

  const loop = (pts) => {
    const oriented = [];
    for (let i = 0; i < pts.length; i++) {
      const { e, forward } = edge(pts[i], pts[(i + 1) % pts.length]);
      oriented.push(f.add(`ORIENTED_EDGE('',*,*,#${e.id},${forward ? '.T.' : '.F.'})`));
    }
    return f.add(`EDGE_LOOP('',(${oriented.map((i) => `#${i}`).join(',')}))`);
  };

  // Newell normal: points toward the viewer for a counter-clockwise loop, so
  // callers must wind outer loops CCW as seen from outside the solid.
  const newell = (pts) => {
    let n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return norm(n);
  };

  const faceIds = [];
  for (const face of faces) {
    const n = newell(face.outer);
    // Reference direction: any in-plane unit vector.
    let ref = norm(sub(face.outer[1], face.outer[0]));
    // Re-orthogonalise against n to keep the placement well formed.
    const dot = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
    ref = norm([ref[0] - dot * n[0], ref[1] - dot * n[1], ref[2] - dot * n[2]]);
    const org = f.add(`CARTESIAN_POINT('',(${face.outer[0].map(F).join(',')}))`);
    const axis = f.add(`DIRECTION('',(${n.map(F).join(',')}))`);
    const refd = f.add(`DIRECTION('',(${ref.map(F).join(',')}))`);
    const plc = f.add(`AXIS2_PLACEMENT_3D('',#${org},#${axis},#${refd})`);
    const plane = f.add(`PLANE('',#${plc})`);
    const bounds = [f.add(`FACE_OUTER_BOUND('',#${loop(face.outer)},.T.)`)];
    for (const inner of face.inners ?? []) {
      bounds.push(f.add(`FACE_BOUND('',#${loop(inner)},.T.)`));
    }
    faceIds.push(f.add(`ADVANCED_FACE('',(${bounds.map((i) => `#${i}`).join(',')}),#${plane},.T.)`));
  }

  const shell = f.add(`CLOSED_SHELL('',(${faceIds.map((i) => `#${i}`).join(',')}))`);
  const brep = f.add(`MANIFOLD_SOLID_BREP('${name}',#${shell})`);

  // --- units and context -------------------------------------------------
  const lengthUnit = f.add(
    `( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(${unit === 'METRE' ? '$' : '.MILLI.'},.METRE.) )`
  );
  const angleUnit = f.add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const solidUnit = f.add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const uncert = f.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${F(
      unit === 'METRE' ? 1e-8 : 1e-5
    )}),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`
  );
  const ctx = f.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncert}))` +
      ` GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidUnit}))` +
      ` REPRESENTATION_CONTEXT('${name}','3D') )`
  );

  const appCtx = f.add(
    `APPLICATION_CONTEXT('core data for automotive mechanical design processes')`
  );
  f.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#${appCtx})`);
  const prodCtx = f.add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const product = f.add(`PRODUCT('${name}','${name}','',(#${prodCtx}))`);
  f.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
  const pdf = f.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const pdCtx = f.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = f.add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
  const pds = f.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const org = f.add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const zdir = f.add(`DIRECTION('',(0.,0.,1.))`);
  const xdir = f.add(`DIRECTION('',(1.,0.,0.))`);
  const plc = f.add(`AXIS2_PLACEMENT_3D('',#${org},#${zdir},#${xdir})`);
  const rep = f.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(#${plc},#${brep}),#${ctx})`);
  f.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);

  const stamp = '2024-01-01T00:00:00';
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    `FILE_NAME('${name}','${stamp}',(''),(''),'step-orient fixture generator','',''); `.trimEnd(),
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...f.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

export { cross, sub, norm, len };
