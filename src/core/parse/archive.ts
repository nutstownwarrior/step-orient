import { unzipSync, type UnzipFileInfo } from 'fflate';

/** A file handed to the worker: an uploaded file, or an entry out of a zip. */
export interface InputFile {
  /** Display path. Entries from an archive read `box.zip/parts/side.step`. */
  name: string;
  buffer: ArrayBuffer;
}

/** The extensions worth pulling out of an archive. */
export const CAD_EXTENSIONS = new Set(['step', 'stp', 'dxf', 'stl', '3mf']);

export const basename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export interface ArchiveLimits {
  /** Most entries to extract across all archives in one upload. */
  maxEntries: number;
  /** Most uncompressed bytes to extract across all archives in one upload. */
  maxBytes: number;
  /** How far to follow zips inside zips. */
  maxDepth: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 500,
  maxBytes: 256 * 1024 * 1024,
  maxDepth: 3,
};

interface Budget {
  entries: number;
  bytes: number;
  hitLimit: boolean;
}

/** fflate can inflate stored and deflated entries, and throws on anything else. */
const READABLE_COMPRESSION = new Set([0, 8]);

/**
 * Replace every zip in the list with the CAD files inside it, recursively.
 *
 * Anything that is not a zip passes through untouched, so this sits in front of
 * the normal per-file dispatch rather than beside it.
 *
 * Archives are attacker-shaped input — a 1 MB zip can hold gigabytes — so entry
 * count and uncompressed size are budgeted across the whole upload and checked
 * before anything is decompressed, not after.
 */
export function expandArchives(
  files: InputFile[],
  warnings: string[],
  onArchive?: (name: string) => void,
  limits: ArchiveLimits = DEFAULT_LIMITS
): InputFile[] {
  const out: InputFile[] = [];
  const budget: Budget = { entries: limits.maxEntries, bytes: limits.maxBytes, hitLimit: false };

  for (const file of files) {
    if (extensionOf(file.name) === 'zip') {
      expandZip(file, 1, out, warnings, budget, limits, onArchive);
    } else {
      out.push(file);
    }
  }

  if (budget.hitLimit) {
    warnings.push(
      `Stopped unpacking after ${limits.maxEntries} files or ` +
        `${Math.round(limits.maxBytes / (1024 * 1024))} MB. Split the archive if parts are missing.`
    );
  }
  return out;
}

function expandZip(
  archive: InputFile,
  depth: number,
  out: InputFile[],
  warnings: string[],
  budget: Budget,
  limits: ArchiveLimits,
  onArchive?: (name: string) => void
): void {
  onArchive?.(archive.name);

  let unpacked = 0;
  let unreadable = 0;
  let tooDeep = 0;

  const filter = (entry: UnzipFileInfo): boolean => {
    if (entry.name.endsWith('/')) return false; // directory record
    const leaf = basename(entry.name);
    // Finder and Explorer both leave their own junk in a zip.
    if (entry.name.startsWith('__MACOSX/') || leaf.startsWith('.')) return false;

    const ext = extensionOf(entry.name);
    if (ext === 'zip' && depth >= limits.maxDepth) {
      tooDeep++;
      return false;
    }
    const nested = ext === 'zip';
    // A zip of CAD parts routinely carries a readme, a thumbnail and a PDF;
    // those are not warnings, they are just not for us.
    if (!nested && !CAD_EXTENSIONS.has(ext)) return false;

    if (!READABLE_COMPRESSION.has(entry.compression)) {
      unreadable++;
      return false;
    }
    if (budget.entries <= 0 || entry.originalSize > budget.bytes) {
      budget.hitLimit = true;
      return false;
    }
    budget.entries--;
    budget.bytes -= entry.originalSize;
    return true;
  };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive.buffer), { filter });
  } catch (err) {
    warnings.push(`${archive.name}: could not read the zip — ${(err as Error).message ?? err}`);
    return;
  }

  for (const [entryName, data] of Object.entries(entries)) {
    const file: InputFile = { name: `${archive.name}/${entryName}`, buffer: toBuffer(data) };
    if (extensionOf(entryName) === 'zip') {
      expandZip(file, depth + 1, out, warnings, budget, limits, onArchive);
    } else {
      out.push(file);
    }
    unpacked++;
  }

  if (unreadable > 0) {
    warnings.push(
      `${archive.name}: skipped ${unreadable} file${unreadable === 1 ? '' : 's'} stored with a ` +
        `compression method this reader does not support — re-zip with standard deflate`
    );
  }
  if (tooDeep > 0) {
    warnings.push(
      `${archive.name}: stopped at ${limits.maxDepth} levels of nested zips — flatten the archive`
    );
  } else if (unpacked === 0 && !budget.hitLimit) {
    warnings.push(`${archive.name}: no STEP, DXF or STL files inside`);
  }
}

/** fflate hands back exact-length arrays, but never assume the view is the whole buffer. */
const toBuffer = (data: Uint8Array): ArrayBuffer =>
  data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : (data.slice().buffer as ArrayBuffer);
