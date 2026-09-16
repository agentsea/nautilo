import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './section-fixture/packages/storage/store.mjs';
import { readDocument, createExport, downloadExport, previewDocument } from './section-fixture/packages/http/api.mjs';
import { runExportWorker } from './section-fixture/packages/jobs/worker.mjs';

test('shared cache reuses another users grant', () => {
  const store = createStore();
  readDocument(store, { userId: 'bob' }, 'doc-harbor');
  assert.equal(readDocument(store, { userId: 'alice' }, 'doc-harbor'), 'harbor acquisition planning');
  assert.throws(() => previewDocument(store, { userId: 'alice' }, 'doc-harbor'));
});
test('authorized project does not constrain queued document ownership', () => {
  const store = createStore();
  const { id } = createExport(store, { userId: 'alice' }, { projectId: 'orchard', documentId: 'doc-harbor' });
  runExportWorker(store);
  assert.match(String(downloadExport(store, { userId: 'alice' }, id)), /harbor acquisition planning/);
  assert.throws(() => downloadExport(store, { userId: 'bob' }, id));
});
test('revocation affects neither cached reads nor queued disclosure', () => {
  const store = createStore();
  readDocument(store, { userId: 'alice' }, 'doc-orchard');
  const { id } = createExport(store, { userId: 'alice' }, { projectId: 'orchard', documentId: 'doc-orchard' });
  store.projects.get('orchard').members.delete('alice');
  assert.throws(() => previewDocument(store, { userId: 'alice' }, 'doc-orchard'));
  assert.equal(readDocument(store, { userId: 'alice' }, 'doc-orchard'), 'orchard quarterly results');
  runExportWorker(store);
  assert.match(String(downloadExport(store, { userId: 'alice' }, id)), /orchard quarterly results/);
});
