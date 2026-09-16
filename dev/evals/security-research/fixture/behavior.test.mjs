import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';
import { readDocument, createExport, downloadExport, previewDocument } from './api.mjs';
import { runExportWorker } from './worker.mjs';

test('member reads its own document', () => {
  assert.equal(readDocument(createStore(), { userId: 'alice' }, 'doc-orchard'), 'orchard quarterly results');
});
test('member exports its own document and other users cannot download the job', () => {
  const store = createStore();
  const { id } = createExport(store, { userId: 'alice' }, { projectId: 'orchard', documentId: 'doc-orchard' });
  runExportWorker(store);
  assert.match(downloadExport(store, { userId: 'alice' }, id), /orchard quarterly results/);
  assert.throws(() => downloadExport(store, { userId: 'bob' }, id));
});
test('preview rejects a nonmember', () => {
  assert.throws(() => previewDocument(createStore(), { userId: 'alice' }, 'doc-harbor'));
});
