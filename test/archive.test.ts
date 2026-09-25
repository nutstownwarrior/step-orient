import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import {
  basename,
  expandArchives,
  extensionOf,
  type InputFile,
} from '../src/core/parse/archive';

const bytes = (text: string) => new TextEncoder().encode(text);

function zip(entries: Zippable, name = 'upload.zip'): InputFile {
  const data = zipSync(entries);
  return { name, buffer: data.slice().buffer as ArrayBuffer };
}

const text = (file: InputFile) => new TextDecoder().decode(new Uint8Array(file.buffer));

describe('paths', () => {
  it('reads the extension off the leaf, not the path', () => {
    expect(extensionOf('box.zip/parts/side.STEP')).toBe('step');
    expect(extensionOf('my.files/readme')).toBe('');
    expect(extensionOf('plain.dxf')).toBe('dxf');
    expect(basename('a/b/c.stp')).toBe('c.stp');
    expect(basename('c.stp')).toBe('c.stp');
  });
});

describe('unpacking a zip', () => {
  it('passes loose files straight through', () => {
    const warnings: string[] = [];
    const loose: InputFile = { name: 'a.step', buffer: bytes('x').buffer as ArrayBuffer };
    expect(expandArchives([loose], warnings)).toEqual([loose]);
    expect(warnings).toEqual([]);
  });

  it('pulls the CAD files out and names them by their path in the archive', () => {
    const warnings: string[] = [];
    const files = expandArchives(
      [zip({ 'a.step': bytes('A'), parts: { 'b.dxf': bytes('B') } }, 'job.zip')],
      warnings
    );
    expect(files.map((f) => f.name).sort()).toEqual(['job.zip/a.step', 'job.zip/parts/b.dxf']);
    expect(text(files.find((f) => f.name.endsWith('a.step'))!)).toBe('A');
    expect(warnings).toEqual([]);
  });

  it('ignores the junk a zip normally carries without complaining about it', () => {
    const warnings: string[] = [];
    const files = expandArchives(
      [
        zip({
          'a.step': bytes('A'),
          'README.md': bytes('hello'),
          'preview.png': bytes('png'),
          '__MACOSX/._a.step': bytes('junk'),
          '.DS_Store': bytes('junk'),
        }),
      ],
      warnings
    );
    expect(files.map((f) => f.name)).toEqual(['upload.zip/a.step']);
    expect(warnings).toEqual([]);
  });

  it('follows a zip inside a zip', () => {
    const inner = zipSync({ 'deep.step': bytes('D') });
    const warnings: string[] = [];
    const files = expandArchives([zip({ 'inner.zip': inner, 'top.stp': bytes('T') }, 'outer.zip')], warnings);
    expect(files.map((f) => f.name).sort()).toEqual([
      'outer.zip/inner.zip/deep.step',
      'outer.zip/top.stp',
    ]);
  });

  it('stops following zips at the depth limit instead of recursing forever', () => {
    let nested = zipSync({ 'bottom.step': bytes('B') });
    for (let i = 0; i < 5; i++) nested = zipSync({ 'more.zip': nested });
    const warnings: string[] = [];
    const files = expandArchives([{ name: 'deep.zip', buffer: nested.slice().buffer as ArrayBuffer }], warnings);
    expect(files).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/stopped at 3 levels of nested zips/);
  });

  it('says so when an archive holds nothing it can use', () => {
    const warnings: string[] = [];
    expect(expandArchives([zip({ 'notes.txt': bytes('nope') })], warnings)).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no STEP, DXF or STL files inside/);
  });

  it('reports a corrupt archive instead of throwing', () => {
    const warnings: string[] = [];
    const broken: InputFile = { name: 'bad.zip', buffer: bytes('PK\u0003\u0004 not really').buffer as ArrayBuffer };
    expect(expandArchives([broken], warnings)).toHaveLength(0);
    expect(warnings[0]).toMatch(/bad\.zip: could not read the zip/);
  });

  it('keeps unpacking the other files when one archive is corrupt', () => {
    const warnings: string[] = [];
    const files = expandArchives(
      [
        { name: 'bad.zip', buffer: bytes('garbage').buffer as ArrayBuffer },
        zip({ 'good.step': bytes('G') }, 'good.zip'),
      ],
      warnings
    );
    expect(files.map((f) => f.name)).toEqual(['good.zip/good.step']);
    expect(warnings).toHaveLength(1);
  });

  it('stops at the entry budget rather than unpacking an archive bomb', () => {
    const entries: Zippable = {};
    for (let i = 0; i < 50; i++) entries[`p${i}.step`] = bytes(`part ${i}`);
    const warnings: string[] = [];
    const files = expandArchives([zip(entries)], warnings, undefined, {
      maxEntries: 10,
      maxBytes: 1024 * 1024,
      maxDepth: 3,
    });
    expect(files).toHaveLength(10);
    expect(warnings.join(' ')).toMatch(/Stopped unpacking/);
  });

  it('stops at the size budget too', () => {
    const warnings: string[] = [];
    const big = new Uint8Array(4096); // compresses to almost nothing
    const files = expandArchives([zip({ 'a.step': big, 'b.step': big, 'c.step': big })], warnings, undefined, {
      maxEntries: 500,
      maxBytes: 9000,
      maxDepth: 3,
    });
    expect(files).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/Stopped unpacking/);
  });

  it('shares one budget across several archives in the same upload', () => {
    const warnings: string[] = [];
    const files = expandArchives(
      [zip({ 'a.step': bytes('A'), 'b.step': bytes('B') }, 'one.zip'), zip({ 'c.step': bytes('C') }, 'two.zip')],
      warnings,
      undefined,
      { maxEntries: 2, maxBytes: 1024, maxDepth: 3 }
    );
    expect(files.map((f) => f.name)).toEqual(['one.zip/a.step', 'one.zip/b.step']);
    expect(warnings.join(' ')).toMatch(/Stopped unpacking/);
  });

  it('announces each archive it opens so the UI can show progress', () => {
    const opened: string[] = [];
    expandArchives(
      [zip({ 'inner.zip': zipSync({ 'a.step': bytes('A') }) }, 'outer.zip')],
      [],
      (name) => opened.push(name)
    );
    expect(opened).toEqual(['outer.zip', 'outer.zip/inner.zip']);
  });

  it('handles stored (uncompressed) entries as well as deflated ones', () => {
    const data = zipSync({ 'a.step': [bytes('stored'), { level: 0 }] });
    const warnings: string[] = [];
    const files = expandArchives([{ name: 'z.zip', buffer: data.slice().buffer as ArrayBuffer }], warnings);
    expect(files).toHaveLength(1);
    expect(text(files[0])).toBe('stored');
    expect(warnings).toEqual([]);
  });
});

describe('the acceptance fixture as a zip', () => {
  it('unpacks to exactly the eleven STEP files, byte for byte', () => {
    const entries: Zippable = {};
    const originals = new Map<string, Uint8Array>();
    for (const name of readdirSync('fixtures/box').sort()) {
      const data = new Uint8Array(readFileSync(join('fixtures/box', name)));
      entries[`box/${name}`] = data;
      originals.set(name, data);
    }
    const warnings: string[] = [];
    const files = expandArchives([zip(entries, 'wooden-box.zip')], warnings);

    expect(warnings).toEqual([]);
    expect(files).toHaveLength(11);
    expect(files[0].name).toBe('wooden-box.zip/box/01-back-wall.step');
    for (const file of files) {
      const original = originals.get(basename(file.name))!;
      expect(new Uint8Array(file.buffer)).toEqual(original);
    }
  });
});
