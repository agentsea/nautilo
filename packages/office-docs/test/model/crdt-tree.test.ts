import { describe, expect, it } from 'vitest';
import { docsTreeToDocument, type DocsTreeNode } from '../../src/model/crdt-tree.js';

const emptyRoot: DocsTreeNode = { type: 'doc', children: [] };

describe('docsTreeToDocument styles registry', () => {
  it('accepts an object registry', () => {
    const doc = docsTreeToDocument(emptyRoot, {
      stylesJson: JSON.stringify({ custom: { name: 'Custom' } }),
    });

    expect(doc.styles).toEqual({ custom: { name: 'Custom' } });
  });

  it.each(['null', '42', '"style"', '[]'])(
    'rejects a non-record JSON value: %s',
    (stylesJson) => {
      const doc = docsTreeToDocument(emptyRoot, { stylesJson });
      expect(doc.styles).toBeUndefined();
    },
  );
});
