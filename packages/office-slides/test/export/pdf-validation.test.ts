import { describe, it, expect } from 'vitest';
import { validateSlidesPdf } from '../../src/export/pdf-validation';
import { buildPdfFixture } from './build-pdf-fixture';
describe('prepared PDF validation', () => {
  it('inspects valid pages without rewriting the original bytes', async () => {
    const bytes = await buildPdfFixture(); const original = bytes.slice();
    await validateSlidesPdf(bytes, 1);
    expect(bytes).toEqual(original);
    await expect(validateSlidesPdf(bytes, 2)).rejects.toThrow('page count');
  });
  it('rejects a header without a readable PDF document', async () => {
    await expect(validateSlidesPdf(new TextEncoder().encode('%PDF-1.7 garbage'), 1)).rejects.toThrow();
  });
});
