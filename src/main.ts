import './style.css';
import NestWorker from './worker/nest.worker?worker';
import { drawSheet, sheetToPng } from './core/export/canvas';
import { cutListCsv } from './core/export/csv';
import { sheetToDxf } from './core/export/dxf';
import { sheetToSvg } from './core/export/svg';
import { DEFAULT_STOCK_SIZES, type BoardResult, type StockOption } from './core/sheets';
import { PART_ROTATIONS, SIDES, uniformGaps, uniformMargins } from './core/types';
import type { Gaps, Margins, NestResult, NestSettings, OrientationMode, Part, Unit } from './core/types';
import type { SheetMode, WorkerRequest, WorkerResponse } from './worker/protocol';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const worker = new NestWorker();
let nextId = 1;
const pending = new Map<number, (r: WorkerResponse) => void>();

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === 'progress') {
    $('progress-text').textContent = `${message.message}…`;
    return;
  }
  pending.get(message.id)?.(message);
  pending.delete(message.id);
};

type AskRequest =
  | Omit<Extract<WorkerRequest, { type: 'parse' }>, 'id'>
  | Omit<Extract<WorkerRequest, { type: 'nest' }>, 'id'>;

function ask(request: AskRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...request, id } as WorkerRequest, transfer);
  });
}

// ---------------------------------------------------------------- state ----

let parts: Part[] = [];
let result: NestResult | null = null;

const SETTINGS_KEY = 'sheet-nester/settings/v1';

interface StoredSettings {
  gap: Gaps;
  margin: Margins;
  marginLinked: boolean;
  kerf: number;
  orientation: OrientationMode;
  mode: SheetMode['kind'];
  sheetW: number;
  sheetH: number;
  candidates: string;
  boardW: number;
  boardLengths: string;
  unit: string;
  nestInHoles: boolean;
}

const defaults: StoredSettings = {
  gap: uniformGaps(5),
  margin: uniformMargins(10),
  marginLinked: true,
  kerf: 0,
  orientation: 'grain-locked',
  mode: 'fixed',
  sheetW: 1000,
  sheetH: 600,
  candidates: DEFAULT_STOCK_SIZES.map(([w, h]) => `${w} x ${h}`).join('\n'),
  boardW: 250,
  boardLengths: '2000, 1200, 800',
  unit: '',
  nestInHoles: true,
};

/** SPEC 9 — persist settings, never the uploaded geometry. */
function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaults };
    return migrate({ ...defaults, ...(JSON.parse(raw) as Record<string, unknown>) });
  } catch {
    return { ...defaults };
  }
}

/**
 * Settings saved before gaps and margins became per-axis and per-side held a
 * single number for each. Spread them back out rather than dropping a returning
 * user's settings on the floor.
 */
function migrate(stored: Record<string, unknown>): StoredSettings {
  const s = { ...stored } as StoredSettings & Record<string, unknown>;
  if (typeof stored.gap === 'number') s.gap = uniformGaps(stored.gap);
  if (typeof stored.margin === 'number') {
    s.margin = uniformMargins(stored.margin);
    s.marginLinked = true;
  }
  return s;
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
  } catch {
    // Private browsing, quota, or a blocked origin: settings just do not stick.
  }
}

function readSettings(): StoredSettings {
  return {
    gap: { x: numberOf('gap-x', 0), y: numberOf('gap-y', 0) },
    margin: {
      top: numberOf('margin-top', 0),
      right: numberOf('margin-right', 0),
      bottom: numberOf('margin-bottom', 0),
      left: numberOf('margin-left', 0),
    },
    marginLinked: ($('margin-linked') as HTMLInputElement).checked,
    kerf: numberOf('kerf', 0),
    orientation: ($('orientation') as HTMLSelectElement).value as OrientationMode,
    mode: ($('mode') as HTMLSelectElement).value as SheetMode['kind'],
    sheetW: numberOf('sheet-w', 1),
    sheetH: numberOf('sheet-h', 1),
    candidates: ($('candidates') as HTMLTextAreaElement).value,
    boardW: numberOf('board-w', 1),
    boardLengths: ($('board-lengths') as HTMLInputElement).value,
    unit: ($('unit') as HTMLSelectElement).value,
    nestInHoles: ($('nest-in-holes') as HTMLInputElement).checked,
  };
}

function numberOf(id: string, min: number): number {
  const value = Number(($(id) as HTMLInputElement).value);
  return Number.isFinite(value) ? Math.max(min, value) : min;
}

function applySettings(s: StoredSettings): void {
  ($('gap-x') as HTMLInputElement).value = String(s.gap.x);
  ($('gap-y') as HTMLInputElement).value = String(s.gap.y);
  for (const side of SIDES) ($(`margin-${side}`) as HTMLInputElement).value = String(s.margin[side]);
  ($('margin-linked') as HTMLInputElement).checked = s.marginLinked;
  ($('kerf') as HTMLInputElement).value = String(s.kerf);
  ($('orientation') as HTMLSelectElement).value = s.orientation;
  ($('mode') as HTMLSelectElement).value = s.mode;
  ($('sheet-w') as HTMLInputElement).value = String(s.sheetW);
  ($('sheet-h') as HTMLInputElement).value = String(s.sheetH);
  ($('candidates') as HTMLTextAreaElement).value = s.candidates;
  ($('board-w') as HTMLInputElement).value = String(s.boardW);
  ($('board-lengths') as HTMLInputElement).value = s.boardLengths;
  ($('unit') as HTMLSelectElement).value = s.unit;
  ($('nest-in-holes') as HTMLInputElement).checked = s.nestInHoles;
  syncMode();
  syncMarginLink();
}

/**
 * "Same all round" keeps the four margin boxes in step, so the common case
 * stays a single number to type while the per-side boxes remain visible.
 */
function syncMarginLink(): void {
  const linked = ($('margin-linked') as HTMLInputElement).checked;
  for (const side of SIDES) ($(`margin-${side}`) as HTMLInputElement).disabled = linked && side !== 'top';
  if (linked) {
    const value = ($('margin-top') as HTMLInputElement).value;
    for (const side of SIDES) ($(`margin-${side}`) as HTMLInputElement).value = value;
  }
}

function syncMode(): void {
  const mode = ($('mode') as HTMLSelectElement).value;
  $('mode-fixed').hidden = mode !== 'fixed';
  $('mode-candidates').hidden = mode !== 'candidates';
  $('mode-board').hidden = mode !== 'board';
}

// ------------------------------------------------------------- file input ---

const drop = $('drop');
const fileInput = $('file-input') as HTMLInputElement;

$('browse').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files) void handleFiles([...fileInput.files]);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  });
}
drop.addEventListener('drop', (e) => {
  const files = (e as DragEvent).dataTransfer?.files;
  if (files?.length) void handleFiles([...files]);
});
// Keep the browser from navigating away when a file is dropped off-target.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function handleFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  $('progress').hidden = false;
  $('progress-text').textContent = 'Reading…';
  try {
    const payload = await Promise.all(
      files.map(async (file) => ({ name: file.name, buffer: await file.arrayBuffer() }))
    );
    const unit = ($('unit') as HTMLSelectElement).value;
    const response = await ask(
      {
        type: 'parse',
        files: payload,
        unitOverride: unit ? (unit as Unit) : null,
      },
      payload.map((p) => p.buffer)
    );
    if (response.type === 'error') {
      showWarnings([response.message]);
      return;
    }
    if (response.type !== 'parts') return;
    parts = [...parts, ...response.parts];
    showWarnings(response.warnings);
    $('unit-note').textContent =
      response.unitSource === 'assumed'
        ? 'no unit in the file — assuming millimetres'
        : `file says ${response.unit}`;
    renderParts();
  } finally {
    $('progress').hidden = true;
  }
}

function showWarnings(warnings: string[]): void {
  const box = $('warnings');
  if (warnings.length === 0) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const title = document.createElement('strong');
  title.textContent = warnings.length === 1 ? 'One file needs attention' : `${warnings.length} files need attention`;
  const list = document.createElement('ul');
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    list.append(li);
  }
  box.replaceChildren(title, list);
}

// ------------------------------------------------------------ parts table ---

function renderParts(): void {
  const body = $('parts').querySelector('tbody')!;
  body.replaceChildren();
  $('parts-section').hidden = parts.length === 0;
  $('settings-section').hidden = parts.length === 0;

  for (const part of parts) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = part.name;
    name.title = part.source;

    const size = document.createElement('td');
    size.textContent = `${part.boxW.toFixed(1)} × ${part.boxH.toFixed(1)}`;
    if (part.outline.interiors.length > 0) size.textContent += ` (${part.outline.interiors.length} holes)`;

    const thickness = document.createElement('td');
    const thicknessInput = document.createElement('input');
    thicknessInput.type = 'number';
    thicknessInput.min = '0';
    thicknessInput.step = '0.1';
    thicknessInput.value = part.thickness.toFixed(2);
    thicknessInput.addEventListener('change', () => {
      part.thickness = Math.max(0, Number(thicknessInput.value) || 0);
    });
    thickness.append(thicknessInput);

    const qty = document.createElement('td');
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.step = '1';
    qtyInput.value = String(part.quantity);
    qtyInput.addEventListener('change', () => {
      part.quantity = Math.max(1, Math.floor(Number(qtyInput.value) || 1));
      qtyInput.value = String(part.quantity);
      updatePartsSummary();
    });
    qty.append(qtyInput);

    const rotation = document.createElement('td');
    const rotationInput = document.createElement('select');
    for (const value of PART_ROTATIONS) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = value === 'auto' ? 'Auto' : `${value}°`;
      rotationInput.append(option);
    }
    rotationInput.value = String(part.rotation);
    rotationInput.addEventListener('change', () => {
      part.rotation = rotationInput.value === 'auto' ? 'auto' : (Number(rotationInput.value) as 0 | 90 | 180 | 270);
    });
    rotation.append(rotationInput);

    const remove = document.createElement('td');
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'ghost';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      parts = parts.filter((p) => p !== part);
      renderParts();
    });
    remove.append(removeButton);

    tr.append(name, size, thickness, qty, rotation, remove);
    body.append(tr);
  }
  updatePartsSummary();
}

function updatePartsSummary(): void {
  const total = parts.reduce((s, p) => s + p.area * p.quantity, 0);
  const count = parts.reduce((s, p) => s + p.quantity, 0);
  const thicknesses = [...new Set(parts.map((p) => p.thickness.toFixed(2)))];
  $('parts-summary').textContent =
    `${count} part${count === 1 ? '' : 's'}, ${(total / 1000).toFixed(1)} cm² of outline, ` +
    `${thicknesses.length} thickness${thicknesses.length === 1 ? '' : 'es'} (${thicknesses.join(', ')} mm)`;
}

// ----------------------------------------------------------------- nesting --

$('mode').addEventListener('change', () => {
  syncMode();
  saveSettings();
});
for (const id of ['gap-x', 'gap-y', 'kerf', 'orientation', 'sheet-w', 'sheet-h', 'candidates', 'board-w', 'board-lengths', 'unit', 'nest-in-holes']) {
  $(id).addEventListener('change', saveSettings);
}
for (const side of SIDES) {
  $(`margin-${side}`).addEventListener('input', () => {
    if (($('margin-linked') as HTMLInputElement).checked) syncMarginLink();
  });
  $(`margin-${side}`).addEventListener('change', saveSettings);
}
$('margin-linked').addEventListener('change', () => {
  syncMarginLink();
  saveSettings();
});

$('nest').addEventListener('click', () => void runNest());

function parseSizes(text: string): [number, number][] {
  return text
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[x×,]/i).map((v) => Number(v.trim())))
    .filter((v) => v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0))
    .map((v) => [v[0], v[1]] as [number, number]);
}

async function runNest(): Promise<void> {
  const s = readSettings();
  saveSettings();
  const settings: NestSettings = {
    gap: s.gap,
    margin: s.margin,
    kerf: s.kerf,
    orientation: s.orientation,
    sheetWidth: s.sheetW,
    sheetHeight: s.sheetH,
    nestInHoles: s.nestInHoles,
  };

  let mode: SheetMode;
  if (s.mode === 'candidates') {
    const sizes = parseSizes(s.candidates);
    if (sizes.length === 0) {
      showResultError('Enter at least one candidate size as "width x height".');
      return;
    }
    mode = { kind: 'candidates', sizes };
  } else if (s.mode === 'board') {
    mode = {
      kind: 'board',
      width: s.boardW,
      standardLengths: s.boardLengths
        .split(/[,;\s]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    };
  } else {
    mode = { kind: 'fixed' };
  }

  const button = $('nest') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Nesting…';
  $('progress').hidden = false;
  $('progress-text').textContent = 'Nesting…';
  try {
    const response = await ask({ type: 'nest', parts, settings, mode });
    if (response.type === 'error') {
      showResultError(response.message);
      return;
    }
    if (response.type !== 'nested') return;
    result = response.result;
    renderResults(response.result, response.stock, response.board, settings);
  } finally {
    button.disabled = false;
    button.textContent = 'Nest';
    $('progress').hidden = true;
  }
}

function showResultError(message: string): void {
  result = null;
  $('results').hidden = false;
  const box = $('validation');
  box.className = 'validation bad';
  box.textContent = message;
  $('summary').replaceChildren();
  $('tables').replaceChildren();
  $('downloads').replaceChildren();
  $('previews').replaceChildren();
}

// ----------------------------------------------------------------- results --

function renderResults(
  nested: NestResult,
  stock: StockOption[] | undefined,
  board: BoardResult | undefined,
  settings: NestSettings
): void {
  $('results').hidden = false;

  // SPEC 6 — the validation verdict goes first and is impossible to miss.
  const box = $('validation');
  const v = nested.validation;
  box.className = `validation ${v.ok ? 'ok' : 'bad'}`;
  box.replaceChildren();
  const verdict = document.createElement('strong');
  verdict.textContent = v.ok
    ? `Checks passed — every part is on its sheet, minimum part-to-part gap ${v.minGap.toFixed(3)} mm.`
    : `${v.issues.length} validation problem${v.issues.length === 1 ? '' : 's'} — do not cut from this layout.`;
  box.append(verdict);

  if (v.ok) {
    // Per-side margins are only worth setting if you can see what they bought,
    // so report the closest approach to each edge rather than one worst case.
    const edges = document.createElement('span');
    edges.className = 'nested';
    edges.textContent = `Closest approach to each edge — ${SIDES.map(
      (side) => `${side} ${format(v.minMargin[side])} mm`
    ).join(', ')}.`;
    box.append(edges);
  }
  if (!v.ok) {
    const list = document.createElement('ul');
    for (const issue of v.issues.slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = issue.message;
      list.append(li);
    }
    box.append(list);
  }

  // A part cut from inside another part changes the cutting order, so say so
  // rather than leaving it to be noticed on the preview.
  const inCutouts = nested.sheets.flatMap((s) => s.placements).filter((p) => p.nestedIn);
  if (inCutouts.length > 0) {
    const note = document.createElement('span');
    note.className = 'nested';
    const names = [...new Set(inCutouts.map((p) => `${p.name} in ${p.nestedIn}`))];
    note.textContent =
      `${inCutouts.length} part${inCutouts.length === 1 ? ' is' : 's are'} cut from inside another ` +
      `part's cutout (${names.join('; ')}). Cut those profiles before releasing the host's cutout.`;
    box.append(note);
  }

  const sheetArea = nested.sheets.reduce((s, sh) => s + sh.width * sh.height, 0);
  stat($('summary'), {
    Sheets: String(nested.sheets.length),
    'Material used': `${(nested.utilisation * 100).toFixed(1)}%`,
    'Sheet size': nested.sheets.length
      ? `${nested.sheets[0].width} × ${nested.sheets[0].height} mm`
      : '—',
    'Part area': `${(nested.totalPartArea / 1000).toFixed(1)} cm²`,
    'Board area': `${(sheetArea / 1000).toFixed(1)} cm²`,
    'Min gap': `${nested.validation.minGap.toFixed(3)} mm`,
  });

  const tables = $('tables');
  tables.replaceChildren();
  if (stock) tables.append(stockTable(stock));
  if (board) tables.append(boardTable(board));

  renderDownloads(nested, settings);
  renderPreviews(nested, settings.margin);
}

/** A clearance reads Infinity when a sheet holds no parts at all. */
const format = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : '—');

function stat(dl: HTMLElement, values: Record<string, string>): void {
  dl.replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrap.append(dt, dd);
    dl.append(wrap);
  }
}

function table(caption: string, head: string[], rows: string[][]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  const h3 = document.createElement('h3');
  h3.textContent = caption;
  const t = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const cell of head) {
    const th = document.createElement('th');
    th.textContent = cell;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
  wrap.append(h3, t);
  return wrap;
}

function stockTable(stock: StockOption[]): HTMLElement {
  const size = (o: StockOption) =>
    o.usedWidth === o.width
      ? `${o.width} × ${o.height}`
      : `${o.usedWidth} × ${o.usedHeight} (entered as ${o.width} × ${o.height})`;
  return table(
    'Candidate stock sizes',
    ['Size (mm), grain along the first', 'Sheets', 'Material used', 'Board area'],
    stock.map((o) =>
      o.error
        ? [size(o), '—', '—', o.error]
        : [
            size(o),
            String(o.sheets),
            `${(o.utilisation * 100).toFixed(1)}%`,
            `${(o.materialArea / 1000).toFixed(0)} cm²`,
          ]
    )
  );
}

function boardTable(board: BoardResult): HTMLElement {
  const rows = board.standard.map((s) => [
    `${board.boardWidth} × ${s.length}`,
    Number.isFinite(s.boards) ? String(s.boards) : '—',
    s.error ?? '',
  ]);
  const el = table(
    `Boards ${board.boardWidth} mm wide`,
    ['Board (mm)', 'Boards needed', ''],
    rows
  );
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = board.error
    ? board.error
    : `Shortest single board that takes the whole job: ${board.minLength?.toFixed(1)} mm.`;
  el.append(p);
  return el;
}

function renderDownloads(nested: NestResult, settings: NestSettings): void {
  const box = $('downloads');
  box.replaceChildren();
  if (nested.sheets.length === 0) return;

  box.append(
    button('Cut list (CSV)', () =>
      download(`cut-list.csv`, new Blob([cutListCsv(nested.sheets)], { type: 'text/csv' }))
    )
  );
  box.append(
    button('All sheets (DXF)', () => {
      for (const sheet of nested.sheets) {
        download(
          `sheet-${sheet.index + 1}.dxf`,
          new Blob([sheetToDxf(sheet)], { type: 'application/dxf' })
        );
      }
    })
  );
  const note = document.createElement('span');
  note.className = 'note';
  const m = settings.margin;
  const sameMargin = SIDES.every((side) => m[side] === m.top);
  note.textContent =
    `gap ${settings.gap.x}/${settings.gap.y} mm (h/v) · margin ` +
    (sameMargin ? `${m.top} mm` : `${m.top}/${m.right}/${m.bottom}/${m.left} mm (t/r/b/l)`) +
    ` · kerf ${settings.kerf} mm`;
  box.append(note);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderPreviews(nested: NestResult, margin: Margins): void {
  const box = $('previews');
  box.replaceChildren();
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  for (const sheet of nested.sheets) {
    const card = document.createElement('div');
    card.className = 'preview';
    const title = document.createElement('h3');
    title.textContent =
      `Sheet ${sheet.index + 1} of ${nested.sheets.length} — ${sheet.width} × ${sheet.height} mm, ` +
      `${sheet.thickness.toFixed(1)} mm thick, ${(sheet.utilisation * 100).toFixed(1)}% used, ` +
      `${sheet.placements.length} parts`;

    const canvas = document.createElement('canvas');
    const pad = 14;
    // Cap the backing store so a 2.5 m sheet does not allocate a huge canvas.
    const scale = Math.min(1600 / sheet.width, 1200 / sheet.height, 3);
    canvas.width = Math.ceil(sheet.width * scale) + pad * 2;
    canvas.height = Math.ceil(sheet.height * scale) + pad * 2;
    const ctx = canvas.getContext('2d');
    if (ctx) drawSheet(ctx, sheet, { scale, labels: true, dark, margin });

    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      button('DXF', () =>
        download(`sheet-${sheet.index + 1}.dxf`, new Blob([sheetToDxf(sheet)], { type: 'application/dxf' }))
      ),
      button('SVG', () =>
        download(`sheet-${sheet.index + 1}.svg`, new Blob([sheetToSvg(sheet)], { type: 'image/svg+xml' }))
      ),
      button('PNG', () => {
        void sheetToPng(sheet, 2, dark, margin).then((blob) =>
          download(`sheet-${sheet.index + 1}.png`, blob)
        );
      })
    );

    card.append(title, canvas, row);
    box.append(card);
  }
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Expose the last result for debugging and for the browser-side acceptance run.
declare global {
  interface Window {
    __nest?: { parts: () => Part[]; result: () => NestResult | null };
  }
}
window.__nest = { parts: () => parts, result: () => result };

applySettings(loadSettings());
