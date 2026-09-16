import { beforeEach, describe, expect, it, vi } from 'vitest';

type MetadataFixture = {
  num_rows: bigint;
  schema: Array<{ name: string; num_children: number }>;
};

type SchemaFixture = {
  children: Array<{ element: { name: string } }>;
};

type ChunkFixture = {
  columnName: string;
  columnData: unknown[];
  rowStart: number;
};

type ReadFixtureOptions = {
  file: ArrayBuffer;
  metadata: MetadataFixture;
  compressors: { GZIP: unknown };
  utf8: boolean;
  onChunk: (chunk: ChunkFixture) => void;
};

const parquetMocks = vi.hoisted(() => ({
  parquetMetadata: vi.fn<(file: ArrayBuffer) => MetadataFixture>(),
  parquetRead: vi.fn<(options: ReadFixtureOptions) => Promise<void>>(),
  parquetSchema: vi.fn<(metadata: MetadataFixture) => SchemaFixture>(),
}));

vi.mock('hyparquet', () => ({
  parquetMetadata: parquetMocks.parquetMetadata,
  parquetRead: parquetMocks.parquetRead,
  parquetSchema: parquetMocks.parquetSchema,
}));

vi.mock('hyparquet-compressors', () => ({
  compressors: { GZIP: vi.fn() },
}));

import { getWorksheetCell } from '../../src';
import { importParquetFile } from '../../src/import/parquet-importer';

describe('importParquetFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 2n,
      schema: [{ name: 'schema', num_children: 4 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: ['name', 'score', 'active', 'joined'].map((name) => ({
        element: { name },
      })),
    });
  });

  it('maps reader records into an editable worksheet', async () => {
    parquetMocks.parquetRead.mockImplementation(async ({ onChunk }) => {
      onChunk({ columnName: 'name', columnData: ['Alice', 'Bob'], rowStart: 0 });
      onChunk({ columnName: 'score', columnData: [95, null], rowStart: 0 });
      onChunk({ columnName: 'active', columnData: [true, undefined], rowStart: 0 });
      onChunk({ columnName: 'joined', columnData: [undefined, '2026-08-31'], rowStart: 0 });
    });
    const file = new Uint8Array([80, 65, 82, 49]).buffer;

    const imported = await importParquetFile(file, { sheetName: 'People' });

    expect(parquetMocks.parquetRead).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        metadata: {
          num_rows: 2n,
          schema: [{ name: 'schema', num_children: 4 }],
        },
        utf8: false,
      }),
    );
    const readOptions = parquetMocks.parquetRead.mock.calls[0]?.[0];
    expect(readOptions?.compressors.GZIP).toBeTypeOf('function');
    expect(readOptions?.onChunk).toBeTypeOf('function');
    expect(imported.name).toBe('People');
    expect(imported.rowCount).toBe(3);
    expect(imported.columnCount).toBe(4);
    expect(getWorksheetCell(imported.worksheet, { r: 1, c: 1 })).toEqual({
      v: 'name',
      s: { b: true },
    });
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 2 })?.v).toBe('95');
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 3 })?.v).toBe(
      'TRUE',
    );
    expect(
      getWorksheetCell(imported.worksheet, { r: 3, c: 2 }),
    ).toBeUndefined();
    expect(getWorksheetCell(imported.worksheet, { r: 3, c: 4 })).toEqual({
      v: '2026-08-31',
      s: { nf: 'date' },
    });
  });

  it('imports a valid zero-row schema as a header-only sheet', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 0n,
      schema: [{ name: 'schema', num_children: 1 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: [{ element: { name: 'id' } }],
    });
    parquetMocks.parquetRead.mockResolvedValue(undefined);

    const imported = await importParquetFile(new ArrayBuffer(0), {
      sheetName: 'Empty',
    });
    expect(imported.rowCount).toBe(1);
    expect(getWorksheetCell(imported.worksheet, { r: 1, c: 1 })?.v).toBe('id');
  });

  it('rejects Parquet data without columns', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 0n,
      schema: [{ name: 'schema', num_children: 0 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({ children: [] });
    await expect(
      importParquetFile(new ArrayBuffer(0), { sheetName: 'Empty' }),
    ).rejects.toThrow('Parquet import contains no columns');
  });

  it('applies an explicit cell policy without partially returning a worksheet', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 40_000n,
      schema: [{ name: 'schema', num_children: 1 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: [{ element: { name: 'value' } }],
    });
    parquetMocks.parquetRead.mockImplementation(async ({ onChunk }) => {
      onChunk({
        columnName: 'value',
        columnData: Array.from({ length: 40_000 }, () => 'x'),
        rowStart: 0,
      });
    });

    await expect(
      importParquetFile(new ArrayBuffer(0), {
        sheetName: 'Too Large',
        maxCells: 40_000,
      }),
    ).rejects.toThrow('Parquet import exceeds the caller cell limit');
  });

  it('imports more than 40,000 cells completely by default', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 40_000n,
      schema: [{ name: 'schema', num_children: 1 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: [{ element: { name: 'value' } }],
    });
    parquetMocks.parquetRead.mockImplementation(async ({ onChunk }) => {
      onChunk({
        columnName: 'value',
        columnData: Array.from({ length: 40_000 }, (_, index) => `${index}`),
        rowStart: 0,
      });
    });

    const imported = await importParquetFile(new ArrayBuffer(0), {
      sheetName: 'Complete',
    });
    expect(imported.cellCount).toBe(40_001);
    expect(getWorksheetCell(imported.worksheet, { r: 40_001, c: 1 })?.v).toBe(
      '39999',
    );
  });

  it('does not apply the former estimated byte budget by default', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 1n,
      schema: [{ name: 'schema', num_children: 1 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: [{ element: { name: 'body' } }],
    });
    parquetMocks.parquetRead.mockImplementation(async ({ onChunk }) => {
      onChunk({
        columnName: 'body',
        columnData: ['x'.repeat(4_000_000)],
        rowStart: 0,
      });
    });

    const imported = await importParquetFile(new ArrayBuffer(0), {
      sheetName: 'Long Text',
    });
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 1 })?.v).toHaveLength(
      4_000_000,
    );
  });

  it('preserves Parquet native values without precision loss or JSON errors', async () => {
    parquetMocks.parquetMetadata.mockReturnValue({
      num_rows: 1n,
      schema: [{ name: 'schema', num_children: 4 }],
    });
    parquetMocks.parquetSchema.mockReturnValue({
      children: ['id', 'occurredAt', 'bytes', 'nested'].map((name) => ({
        element: { name },
      })),
    });
    parquetMocks.parquetRead.mockImplementation(async ({ onChunk }) => {
      onChunk({
        columnName: 'id',
        columnData: [9_007_199_254_740_993n],
        rowStart: 0,
      });
      onChunk({
        columnName: 'occurredAt',
        columnData: [new Date('2026-09-01T12:34:56.000Z')],
        rowStart: 0,
      });
      onChunk({
        columnName: 'bytes',
        columnData: [new Uint8Array([0, 15, 255])],
        rowStart: 0,
      });
      onChunk({
        columnName: 'nested',
        columnData: [
          {
            ids: [1n, 2n],
            payload: new Uint8Array([171, 205]),
          },
        ],
        rowStart: 0,
      });
    });

    const imported = await importParquetFile(new ArrayBuffer(0), {
      sheetName: 'Native values',
    });

    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 1 })).toEqual({
      v: '9007199254740993',
    });
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 2 })).toEqual({
      v: '2026-09-01 12:34:56',
      s: { nf: 'date' },
    });
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 3 })).toEqual({
      v: '0x000fff',
    });
    expect(getWorksheetCell(imported.worksheet, { r: 2, c: 4 })).toEqual({
      v: '{"ids":["1","2"],"payload":"0xabcd"}',
    });
  });
});
