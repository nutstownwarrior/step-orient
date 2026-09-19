import type { BoardResult, StockOption } from '../core/sheets';
import type { NestResult, NestSettings, Part, Unit } from '../core/types';

export type SheetMode =
  | { kind: 'fixed' }
  | { kind: 'candidates'; sizes: [number, number][] }
  | { kind: 'board'; width: number; standardLengths: number[] };

export type WorkerRequest =
  | {
      id: number;
      type: 'parse';
      files: { name: string; buffer: ArrayBuffer }[];
      unitOverride: Unit | null;
    }
  | {
      id: number;
      type: 'nest';
      parts: Part[];
      settings: NestSettings;
      mode: SheetMode;
    };

export type WorkerResponse =
  | { id: number; type: 'progress'; message: string; value: number }
  | { id: number; type: 'parts'; parts: Part[]; warnings: string[]; unit: string; unitSource: string }
  | { id: number; type: 'nested'; result: NestResult; stock?: StockOption[]; board?: BoardResult }
  | { id: number; type: 'error'; message: string };
