# Build spec: browser-based sheet-goods nesting app

Build a static web app that nests flat CAD parts onto sheets of wood or metal.
It must run entirely client-side and deploy to GitHub Pages — no backend, no
server, no API keys.

## 1. Stack and deployment

- Vite + TypeScript. React is fine but not required; the UI is small.
- All heavy work in a Web Worker so the page stays responsive.
- `vite.config.ts` must set `base: '/<repo-name>/'` or the Pages build will
  request assets from the domain root and 404.
- Add `public/.nojekyll` so Pages does not eat underscore-prefixed asset paths.
- Deploy with a GitHub Actions workflow (`actions/upload-pages-artifact` +
  `actions/deploy-pages`) triggered on push to `main`.
- Verify the production build locally with `npm run build && npx vite preview
  --base /<repo-name>/` before declaring it done. A dev-server-only check will
  miss the base-path bug, which is the single most common way this breaks.

## 2. Input

Accept, via file picker and drag-and-drop, multiple files at once:

- **STEP** (`.step`, `.stp`) — the primary path.
- **DXF** (`.dxf`) — treat each closed polyline/LWPOLYLINE as a part outline.
- **3MF / STL** — optional, same mesh code path as STEP.

For STEP parsing use **`occt-import-js`** (WASM build of the OCCT importer). It
returns triangulated meshes with per-solid grouping, which is all this app
needs. Copy its `.wasm` into `public/` and resolve its URL with
`import.meta.url` so it works under the Pages base path.

Do not attempt to write a STEP parser. Do not use the full `opencascade.js`
unless exact B-rep geometry is later wanted — it is ~40 MB and would make the
page unusable on a phone. Note the tradeoff in the README: with meshes, curved
edges come out as polylines rather than true arcs.

One uploaded file may contain several solids. Treat every solid as a separate
part and show a quantity field per part, defaulting to the number of instances
found.

## 3. Outline extraction — the part that matters

This is where a naive implementation goes wrong. Follow these steps exactly.

### 3.1 Find the plate normal

For each solid, build the area-weighted set of triangle normals. Take the ~20
largest-area distinct normal directions as candidate axes. For each candidate,
compute the solid's extent along it. **The plate normal is the candidate axis
with the smallest extent** — that extent is the material thickness.

Do not use PCA or a raw axis-aligned bounding box. Parts arrive in assembly
coordinates at arbitrary orientations, and AABB gives the wrong answer for
anything rotated off-axis.

### 3.2 Project, do not slice

Rotate the mesh so the plate normal maps to +Z. Then project **every triangle**
to the XY plane and union them all.

This is critical: **never take a cross-section at mid-thickness.** Parts
routinely have chamfers, rebates and countersinks, so a mid-plane slice is
smaller than the blank you actually have to cut. The union of all projected
triangles gives the maximum silhouette — the envelope that covers the part at
every depth. That is the correct cutting outline.

Through-holes survive the union automatically and become interior rings. Blind
pockets vanish, which is correct — you do not cut them on the profile.

### 3.3 Boolean union

Use **Clipper2** (`clipper2-js`) rather than `polygon-clipping`. Clipper works
on scaled integers and unions tens of thousands of triangles in milliseconds;
the floating-point libraries are an order of magnitude slower and produce
slivers on coincident triangle edges. Scale coordinates by 1e4 going in.

Afterwards: offset by +0.01 mm then −0.01 mm to close tessellation cracks, then
simplify with a 0.005 mm tolerance. Straight edges must survive this untouched —
a rectangular part has to come out with exactly 4 vertices, and that is a
useful assertion to write into the tests.

Keep only the largest resulting outer ring per solid; retain its interior rings.

### 3.4 Units

STEP files carry their own unit (Onshape writes metres). Read the header unit
and normalise everything to millimetres. Show the detected unit in the UI and
let the user override it, because DXF files are frequently unitless.

## 4. Orientation and grain

User-selectable per job:

- **Grain locked** (default). Rotate each part so the long edge of its
  *minimum-area* rotated bounding rectangle is parallel to the sheet X axis.
  Use minimum-area, not the axis-aligned box, so parts that arrive rotated in
  their own plane still line up. Only 0° and 180° placements are allowed.
- **90° steps.** Parts may also rotate a quarter turn. Use for isotropic
  material like metal or MDF.
- **Free rotation.** Out of scope for v1 — leave the enum value in place and
  throw a clear "not implemented" if selected.

Also offer a per-part override toggle, since on a visible face the grain
sometimes has to run across the short dimension for appearance.

Draw a grain arrow on every sheet preview and write it to a `GRAIN` layer in
the DXF.

## 5. Nesting

Bounding-box packing with **MaxRects, best-short-side-fit**. Reject
shelf/guillotine packing — it wastes noticeably more material on mixed part
sizes.

Spacing trick, use it rather than doing collision tests during placement:
inflate every part's box by `gap` in both dimensions, and pack into a region of
`(sheetW - 2*margin + gap) x (sheetH - 2*margin + gap)`, then add `margin` back
to every placed coordinate. This guarantees at least `gap` between any two
parts and at least `margin` from every edge, by construction.

Run the packer under five different sort orders — descending area, longest
side, height, width, perimeter — and keep whichever needs the fewest sheets,
breaking ties on utilisation. It costs nothing and reliably beats any single
heuristic.

Multi-sheet: fill one sheet, carry the rejects to the next, repeat. Cap the
loop iterations so a part larger than the sheet cannot hang the worker; surface
that case as a specific error naming the offending part and its size.

**Group parts by thickness** and nest each group separately. Parts of different
thickness cannot share a sheet, and silently mixing them is a real-money bug.

Expose a `kerf` input (default 0) and add it to the effective gap, so a router
bit's width is accounted for.

## 6. Validation — non-negotiable

After packing, before showing anything, run an independent check on the actual
placed polygons:

- every part lies inside the sheet and respects the edge margin
- `distance()` between every pair of parts on a sheet is >= the requested gap
- no part overlaps another

Report the measured minimum gap in the UI. If any check fails, show the
violation prominently instead of a clean-looking result. The whole value of
this tool is that the numbers are trustworthy; a plausible-looking layout that
is 2 mm out is worse than no tool.

## 7. Sheet input and the "what should I buy" mode

Two modes:

1. **Fixed sheet** — user enters width x height, gets sheet count and
   utilisation.
2. **Find a size** — user enters a list of candidate stock sizes (with sensible
   defaults: 2500x1250, 2440x1220, 2050x1250, 1200x600, 1000x600, 800x600,
   250x2000, 250x1200, 250x800) and gets a ranked table of sheets needed and
   material used for each.

Also support a **max width constraint** — the common case where a supplier only
sells boards up to some width. Given a fixed width, binary-search the minimum
length that fits everything on one board, and report it alongside the standard
lengths.

## 8. Output

- **DXF** per sheet. Layers: `CUT` (part outlines, exterior and interior
  rings), `SHEET` (board outline), `LABEL` (part name text), `GRAIN` (direction
  arrow). Set `$INSUNITS = 4` for millimetres. Write LWPOLYLINE entities. Do
  not pull in a heavy DXF library — ASCII DXF R2010 with only these entity
  types is about 80 lines to emit by hand.
- **SVG** per sheet, for anyone cutting on a laser that takes SVG.
- **PNG** preview, and an on-screen canvas preview with part labels and
  dimensions.
- **Cut list** as CSV: part name, quantity, width, height, thickness, sheet
  number.

## 9. UI

Single page, works on a phone. Top to bottom: drop zone -> detected parts table
(name, size, thickness, quantity, orientation override) -> settings (gap,
margin, kerf, orientation mode, sheet mode and sizes) -> Nest button ->
results (validation status, sheet count, utilisation, previews, download
buttons).

Show a spinner with progress during parsing — a 5 MB STEP file takes a few
seconds to tessellate.

Persist settings in `localStorage`. Do not persist uploaded geometry.

## 10. Acceptance test

Commit this fixture and assert on it. A wooden box, 11 parts, all 10 mm thick,
exported from Onshape as individual STEP files in metres:

| part | size (mm) | notes |
|---|---|---|
| back wall | 350 x 210 | |
| front wall | 350 x 210 | two openings, 320 x 50.6 |
| left wall | 250 x 210 | |
| right wall | 250 x 210 | |
| lid top | 330 x 230 | |
| lid front wall | 350 x 39.8 | |
| lid back wall | 350 x 39.8 | |
| lid left wall | 250 x 39.8 | |
| lid right wall | 250 x 39.8 | |
| upper drawer front | 319.4 x 50 | |
| lower drawer front | 319.4 x 50 | |

Total outline area 375,216 mm². Expected results with 5 mm gap, 10 mm margin,
grain locked:

- every part extracts as a rectangle with exactly 4 exterior vertices; the
  front wall has exactly 2 interior rings
- 1000 x 600 sheet -> 1 sheet, 62.5% used
- 1000 x 500 sheet -> 1 sheet, 75.0% used
- 800 x 600 sheet -> 2 sheets
- 250 mm wide board -> minimum single-board length 2149 mm; 2 x 1200 mm boards
- measured minimum part-to-part gap exactly 5.000 mm in every case

If the extraction returns anything other than clean rectangles here, the
projection step is wrong — most likely it is slicing rather than projecting.

## 11. README

Cover: what it does, the mesh-vs-B-rep tradeoff and its effect on curved edges,
the fact that bounding-box nesting will not place small parts inside the holes
of larger ones, and a pointer to Deepnest for jobs where true-shape nesting is
worth the extra effort.
