import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './fixture/store.mjs';
import { readDocument, createExport, downloadExport, previewDocument } from './fixture/api.mjs';
import { runExportWorker } from './fixture/worker.mjs';

// Keep this oracle OUTSIDE the model's Current Folder. These tests prove the
// seeded defects exist; they are not fixes to the deliberately vulnerable fixture.
test('DOC-001: a prior member read leaks the project to a different user', () => {
  const store = createStore();
  assert.equal(readDocument(store, { userId: 'alice' }, 'doc-orchard'), 'orchard quarterly results');
  assert.equal(readDocument(store, { userId: 'bob' }, 'doc-orchard'), 'orchard quarterly results');
});
test('DOC-002: mismatched export identifiers leak a different project through an owned job', () => {
  const store = createStore();
  const { id } = createExport(store, { userId: 'alice' }, { projectId: 'orchard', documentId: 'doc-harbor' });
  runExportWorker(store);
  assert.match(downloadExport(store, { userId: 'alice' }, id), /harbor acquisition planning/);
  assert.throws(() => downloadExport(store, { userId: 'bob' }, id), /not found/);
});
test('counterevidence: the fresh membership preview rejects the same nonmember', () => {
  const store = createStore();
  assert.equal(readDocument(store, { userId: 'alice' }, 'doc-orchard'), 'orchard quarterly results');
  assert.throws(() => previewDocument(store, { userId: 'bob' }, 'doc-orchard'), /forbidden/);
});
