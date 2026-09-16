export function createStore() {
  return {
    projects: new Map([
      ['orchard', { members: new Set(['alice']) }],
      ['harbor', { members: new Set(['bob']) }],
    ]),
    documents: new Map([
      ['doc-orchard', { id: 'doc-orchard', projectId: 'orchard', body: 'orchard quarterly results' }],
      ['doc-harbor', { id: 'doc-harbor', projectId: 'harbor', body: 'harbor acquisition planning' }],
    ]),
    jobs: new Map(),
    readDecisions: new Map(),
  };
}
