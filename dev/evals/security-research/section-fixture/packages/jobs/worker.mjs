export function runExportWorker(store) {
  for (const job of store.jobs.values()) {
    if (job.state !== 'queued') continue;
    const doc = store.documents.get(job.documentId);
    if (!doc) { job.state = 'failed'; continue; }
    job.result = 'document,body\n' + JSON.stringify(doc.id) + ',' + JSON.stringify(doc.body);
    job.state = 'ready';
  }
}
