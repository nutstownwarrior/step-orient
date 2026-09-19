// Polyhedron builders for the acceptance fixture.
//
// Everything is a prism: a 2D profile (optionally with holes) extruded along
// +Z. That covers plain plates, plates with through openings, and — by
// extruding an L-shaped cross-section — a plate with a rebate along one edge.

const rev = (pts) => pts.slice().reverse();

/**
 * Extrude a CCW profile (array of [x,y]) by `depth` along +Z.
 * `holes` are CCW [x,y] loops fully inside the profile.
 * Returns faces with outer loops wound CCW as seen from outside the solid.
 */
export function prism(profile, holes, depth) {
  const at = (p, z) => [p[0], p[1], z];
  const faces = [];
  const holesCW = holes.map(rev);

  // top (+Z) and bottom (-Z) caps
  faces.push({
    outer: profile.map((p) => at(p, depth)),
    inners: holesCW.map((h) => h.map((p) => at(p, depth))),
  });
  faces.push({
    outer: rev(profile).map((p) => at(p, 0)),
    inners: holes.map((h) => h.map((p) => at(p, 0))),
  });

  const walls = (loop) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      faces.push({ outer: [at(a, 0), at(b, 0), at(b, depth), at(a, depth)] });
    }
  };
  walls(profile);
  for (const h of holesCW) walls(h);
  return faces;
}

export const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Plain plate w x h x t, lying in XY, thickness along Z. */
export function plate(w, h, t) {
  return prism(rect(0, 0, w, h), [], t);
}

/** Plate with rectangular through openings. */
export function plateWithOpenings(w, h, t, openings) {
  return prism(
    rect(0, 0, w, h),
    openings.map((o) => rect(o.x, o.y, o.x + o.w, o.y + o.h)),
    t
  );
}

/**
 * Plate w x h x t carrying a rebate `rw` wide and `rd` deep along the y = h
 * edge, cut from the +Z face.
 *
 * The L-shaped cross-section is extruded along the w direction, so the local
 * axes come out as (u, v, w) = (y, z, x) of the finished plate. The silhouette
 * looking down the thickness is still the full w x h rectangle, but a section
 * taken at mid-thickness is w x (h - rw) — which is exactly how a slicing
 * implementation gets caught.
 */
export function rebatedPlate(w, h, t, rw, rd) {
  if (rd <= t / 2) throw new Error('rebate must span mid-thickness to be a useful fixture');
  const profile = [
    [0, 0],
    [h, 0],
    [h, t - rd],
    [h - rw, t - rd],
    [h - rw, t],
    [0, t],
  ];
  // profile is in (y, z); extruding along +Z here means along the plate's x.
  return prism(profile, [], w);
}

/** Plate w x h x t with a chamfer of size c around the +Z face. */
export function chamferedPlate(w, h, t, c) {
  const faces = [];
  const z0 = 0;
  const z1 = t - c;
  const outer = rect(0, 0, w, h);
  const inset = rect(c, c, w - c, h - c);
  const at = (p, z) => [p[0], p[1], z];

  faces.push({ outer: rev(outer).map((p) => at(p, z0)) }); // bottom
  faces.push({ outer: inset.map((p) => at(p, t)) }); // chamfered top
  for (let i = 0; i < 4; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % 4];
    faces.push({ outer: [at(a, z0), at(b, z0), at(b, z1), at(a, z1)] }); // side
    const ai = inset[i];
    const bi = inset[(i + 1) % 4];
    faces.push({ outer: [at(a, z1), at(b, z1), at(bi, t), at(ai, t)] }); // chamfer band
  }
  return faces;
}

/** Rotation matrix from an axis (need not be unit) and an angle in radians. */
export function rotation(axis, angle) {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
}

/** Apply rotation + translation + uniform scale to every point of every face. */
export function transformFaces(faces, m, translate, scale) {
  const tp = (p) => [
    (m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + translate[0]) * scale,
    (m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + translate[1]) * scale,
    (m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + translate[2]) * scale,
  ];
  return faces.map((f) => ({
    outer: f.outer.map(tp),
    inners: (f.inners ?? []).map((h) => h.map(tp)),
  }));
}
