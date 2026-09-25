# Sheet Nester

A static web app that nests flat CAD parts onto sheets of wood or metal.
Drop STEP, DXF or STL files in, get a cutting layout back as DXF, SVG, PNG and
a CSV cut list.

Everything runs in the browser. There is no backend, no upload and no API key —
your geometry never leaves the machine.

**Live: https://nutstownwarrior.github.io/step-orient/**

## What it does

1. **Reads your parts.** STEP is the primary path, via `occt-import-js` (a WASM
   build of the OpenCascade importer). One file may hold several solids; each
   becomes a part, and identical parts collapse into one row with a quantity.
   DXF and STL also work. Drop in a **.zip** and it is unpacked in the browser
   — subfolders and all — so a whole assembly export goes in as one file.
2. **Extracts the cutting outline.** For each solid it finds the plate normal,
   projects *every* triangle onto that plane and unions them. See below — this
   is the part that is easy to get wrong.
3. **Orients for grain.** Each part is turned so the long edge of its
   *minimum-area* rotated bounding rectangle runs along the sheet X axis. Any
   part can be pinned to a rotation of its own instead — see below.
4. **Nests.** MaxRects best-short-side-fit, run under five sort orders, keeping
   whichever needs the fewest sheets. Parts are grouped by thickness and nested
   separately, because parts of different thickness cannot share a board.
   Parts a sheet has no room for are then tried in the cutouts of the parts
   that did fit.
5. **Checks the result.** An independent pass re-measures the actual placed
   polygons: every part inside the sheet, every edge margin respected, every
   part-to-part distance at least the requested gap, no overlaps. The measured
   minimum gap is shown in the UI. If a check fails, the violation is shown
   instead of a clean-looking result.

## The two things worth knowing before you cut

### Meshes, not B-rep: curved edges come out as polylines

`occt-import-js` returns triangulated meshes. That is all this app needs and it
is about 7 MB of WASM. The full `opencascade.js`, which would give exact B-rep
geometry, is around 40 MB and would make the page unusable on a phone.

The tradeoff: **a curved edge comes out as a polyline, not a true arc.** A
circular hole becomes a many-sided polygon, and a filleted corner becomes a
short chain of straight segments. For routing and laser cutting at the
tessellation tolerance used here that is fine — the chord error is well under a
tenth of a millimetre — but if you need real `ARC` entities in the DXF, this is
not the tool.

Straight edges are exact. A rectangular part comes out with exactly four
vertices, which the test suite asserts.

### Bounding-box nesting, with one exception

Packing is done on each part's bounding rectangle, not its true shape. The
consequences:

- Two L-shaped parts will not be interlocked.
- A part's bounding box reserves its corners even when they are empty.
- The measured gap is between the real outlines, so the layout is always safe —
  just not always as tight as a true-shape nester would manage.

The exception is cutouts. **Parts are placed inside the cutouts of other
parts** when they fit, which is the one case where the waste is large and
obvious. Each cutout is shrunk by the gap and reduced to the maximal
rectangles that fit inside it, and those rectangles are handed to the packer
like any other free area — so a part in a cutout is held to exactly the same
gap and validated by exactly the same checks as a part anywhere else.

This only ever runs on parts the sheet itself had no room for, so it can
save a sheet but never make a layout worse. Turn it off with **Nest parts
inside cutouts** for plain bounding-box packing.

**It changes the cutting order.** A part nested in a cutout has to be cut
before the host's cutout is released, or the waste it sits in drops out with
the part still in it. The app flags this everywhere it can: the validation
banner names each nested part and its host, those parts are drawn in a
different colour on the preview, the `LABEL` layer of the DXF reads
`insert (in host plate)`, and the cut list gains a `nested_in` column.

For jobs where true-shape nesting is worth the extra effort — lots of
irregular parts, expensive material, interlocking profiles — use
[Deepnest](https://deepnest.io/).

## Outline extraction: project, do not slice

The rule that matters: **never take a cross-section at mid-thickness.**

Parts routinely have chamfers, rebates and countersinks. A mid-plane slice of
such a part is *smaller* than the blank you actually have to cut, and you will
find out when the piece comes off the machine 5 mm short.

Instead, every triangle is projected onto the plate plane and the projections
are unioned. That gives the maximum silhouette — the envelope that covers the
part at every depth — which is the correct cutting outline. Through-holes
survive the union and become interior rings. Blind pockets vanish, which is
also correct: you do not cut those on the profile.

The plate normal itself is found by taking the largest-area distinct triangle
normals as candidate axes and keeping the one the solid is thinnest along —
that extent is the material thickness. Not PCA, and not a raw axis-aligned
bounding box: parts arrive in assembly coordinates at arbitrary orientations,
and an AABB gives the wrong answer for anything rotated off-axis.

The acceptance fixture is built to catch a slicing implementation. One part has
a rebate that spans mid-thickness, so a slice reports 250 × 205 where the true
blank is 250 × 210; another has a chamfered face. Both must come out as clean
four-vertex rectangles at full size.

## Archives

A `.zip` is unpacked in the worker before anything else happens, so the rest of
the pipeline never knows an archive was involved. Subfolders are followed, and
a zip inside a zip is followed too, up to three levels.

Files that are not STEP, DXF or STL are skipped in silence — a CAD export
routinely ships a readme, a thumbnail and a PDF alongside the parts, and
warning about each one would bury the warnings that matter. So are directory
records, dotfiles and the `__MACOSX` folder macOS leaves behind. What *does*
get a warning: an archive with no usable files in it, one that will not open,
one nested deeper than three levels, and entries compressed with something
other than deflate.

A zip is attacker-shaped input — a megabyte of archive can hold gigabytes of
output — so entry count (500) and uncompressed size (256 MB) are budgeted
across the whole upload and checked from the central directory *before*
anything is decompressed. One corrupt archive does not stop the others being
read.

Parts keep their path in the archive as their source, so a part that came out
of `box.zip/parts/side.step` says so in the parts table, but is still named
`side`.

## Rotation

The job's **Orientation** setting is the default for every part:

- **Grain locked** — every part upright, long edge along the sheet X axis, so
  the grain runs the length of each part.
- **90° steps** — the nester may also turn a part a quarter turn, for isotropic
  material like metal or MDF.
- **Free rotation** — out of scope for v1. Selecting it raises a clear "not
  implemented" error rather than quietly doing something else.

The **Rotation** column in the parts table overrides that for one part:
**Auto**, or a fixed **0° / 90° / 180° / 270°**. A pinned rotation wins over
the job's mode in both directions — it will turn a part in a grain-locked job,
and it will hold a part upright in a 90° job even where turning would pack
better. It applies to every instance of that part.

- **90° / 270°** run the grain across the short dimension, which a visible face
  sometimes needs.
- **0° / 180°** are the same footprint the other way round. The packer cannot
  tell them apart, but the part can: it decides which end of an asymmetric part
  — a cutout nearer one end, a figured face — lands where.

One rotation per part row, applied to all its instances. To place two instances
of the same part differently, remove the extra quantity from one row and add
the file again as a second row.

## Gaps and margins

Two separate controls, because they are two different things.

**Gap between parts** is set per direction: **horizontal** for parts sitting
side by side, **vertical** for parts stacked one above the other. One figure
per direction rather than one per side, because the gap between two parts is a
single distance that both of them share — "the gap on A's right" and "the gap
on B's left" are the same measurement. What can genuinely differ is the
direction, so a router that needs more room across the feed than along it gets
what it asks for. The kerf is added to both.

**Edge margin** is set per side: **top, right, bottom, left**. Use it for a
damaged edge, a clamping strip, or a board that is only square on three sides.
"Same all round" keeps the four boxes in step for the common case. The usable
area is drawn as a dashed rectangle on every sheet preview, so an asymmetric
margin is visible rather than something you have to take on trust.

Both are guaranteed by construction rather than by collision tests: every
part's box is inflated by the horizontal gap in X and the vertical gap in Y,
the packing region is the usable area inflated by the same, and the margins are
added back to each placed coordinate afterwards.

Validation then re-measures the placed polygons and reports the closest
approach to *each* edge, not one worst case. A pair of parts passes when it is
clear along one axis by that axis's gap — or, for a part nested in a cutout
where neither projection separates the two, clear in every direction by the
larger of the two gaps. When the horizontal and vertical gaps are equal that
reduces to exactly the old rule: nothing anywhere closer than the gap.

Inside a cutout the *larger* of the two gaps is used. A cutout edge can run at
any angle, so there is no axis to charge the smaller gap to, and a part ending
up a millimetre closer to a cutout edge than asked for is a real mistake where
a cutout giving up a millimetre of room is not.

## Sheet modes

- **Fixed sheet** — enter width × height, get sheet count and utilisation.
- **Find a size** — enter candidate stock sizes and get a ranked table of how
  many sheets each needs and how much material that buys.
- **Max width constraint** — for the common case where a supplier only sells
  boards up to some width. Fix the width and the app binary-searches the
  shortest board that takes the whole job in one piece, alongside how many
  boards of each standard length you would need instead.

## Running it

```sh
npm install
npm run dev              # dev server
npm test                 # unit tests and the acceptance fixture
npm run build            # production build into dist/
npm run preview -- --base /step-orient/   # serve the production build
```

Check the production build with `preview`, not just `dev`. GitHub Pages serves
the site from `/<repo>/`, so `vite.config.ts` sets `base` to match; a
dev-server-only check will miss a base-path mistake, which is the single most
common way a Pages deployment of a Vite app breaks.

### Regenerating the fixture

`fixtures/box/*.step` are generated, not hand-written:

```sh
npm run fixtures
```

`scripts/make-fixtures.mjs` writes eleven STEP files in metres — the unit
Onshape exports — each placed at an arbitrary assembly orientation so the
plate-normal search has real work to do. CI regenerates them and fails if the
committed files have drifted.

## Deployment

`.github/workflows/deploy.yml` runs the tests, builds with
`VITE_BASE=/<repo-name>/`, and publishes `dist/` with
`actions/upload-pages-artifact` and `actions/deploy-pages` on every push to
`main`. `public/.nojekyll` stops Pages from swallowing asset paths that start
with an underscore.

To enable it on a fresh clone: repository **Settings → Pages → Source →
GitHub Actions**.

## Notes on the implementation

- **Clipper2, via `clipper2-ts`.** Boolean operations run on scaled integers
  (×10⁴) and union tens of thousands of triangles in milliseconds, where a
  floating-point clipper is an order of magnitude slower and leaves slivers on
  coincident triangle edges. The spec named the `clipper2-js` package, but its
  `ClipperOffset` mangles even a plain rectangle and its `PolyTree` builder
  throws on an uninitialised field; `clipper2-ts` is a current, correct port of
  the same library and is used instead.
- **Micron snapping.** After the union and the rotation into the grain frame,
  coordinates are snapped to 1 µm. Without it, two nominally identical parts
  differ in the ninth decimal place, the packer stops recognising redundant
  free rectangles, and the layout comes out measurably worse.
- **Free rotation is out of scope for v1.** The enum value is there and
  selecting it raises a clear "not implemented" error rather than silently
  doing something else.
- **3MF is not implemented.** Export STEP or STL instead; the app says so
  rather than failing quietly.
- **Cutout rectangles are conservative.** A grid cell inside a cutout counts as
  usable only when no edge of the cutout passes through it, so the result is
  exact for a rectangular or slotted cutout and gives up a cell's width around
  a curve. A part is never allowed to overhang into solid material to gain a
  fraction of a millimetre.
- All heavy work happens in a Web Worker, so the page stays responsive while a
  5 MB STEP file tessellates.
- Settings persist in `localStorage`. Uploaded geometry never does.

## Acceptance test

`test/acceptance.test.ts` asserts the numbers in the spec against the committed
fixture — a wooden box of 11 parts, all 10 mm thick:

| check | expected |
|---|---|
| every part's exterior ring | exactly 4 vertices |
| front wall interior rings | exactly 2, each 320 × 50.6 mm |
| total outline area | 375,216 mm² |
| 1000 × 600 sheet | 1 sheet, 62.5% used |
| 1000 × 500 sheet | 1 sheet, 75.0% used |
| 800 × 600 sheet | 2 sheets |
| 250 mm wide board | 2149 mm minimum single board; 2 × 1200 mm boards |
| measured minimum gap | exactly 5.000 mm in every case |

Those are the plain bounding-box numbers, so the acceptance test runs with
cutout nesting off. `test/cutouts.test.ts` covers what it buys on the same
fixture: the two 320 × 50.6 mm openings in the front wall each take a
250 × 39.8 mm lid wall, which takes the minimum 250 mm board from **2149.4 mm
down to 1925 mm** — one 2000 mm board instead of two. It also asserts the
thing that matters more: that nesting into cutouts never needs *more* sheets
than without it, and that the measured gap stays at exactly 5.000 mm.

One footnote on the board length. The spec quotes 2149 mm; the app reports
**2149.4 mm**, and that 0.4 mm is real rather than slack. The tightest packing
this geometry admits is 1550 mm of large parts end to end, a 5 mm gap, then a
574.4 mm block of small parts, plus two 10 mm margins — so a 2149 mm board is
genuinely 0.4 mm short. The test asserts to the nearest millimetre.
