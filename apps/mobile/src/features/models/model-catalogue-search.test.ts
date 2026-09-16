import { describe, expect, test } from 'bun:test';

import type { AssistantModelSummary } from '@nautilo/api-client/browser';

import { filterModelCatalogue } from './model-catalogue-search';

const models: AssistantModelSummary[] = [
  {
    id: 'openai:gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    provider: 'OpenAI',
    priority: 1,
    enabled: true,
    costCoefficient: 1,
  },
  {
    id: 'fireworks:kimi-k3',
    displayName: 'Kimi K3',
    provider: 'Fireworks',
    priority: 2,
    enabled: true,
    costCoefficient: 1,
  },
];

describe('model catalogue search', () => {
  test('matches display name, provider, or canonical id without changing order', () => {
    expect(filterModelCatalogue(models, '  sol ')).toEqual([models[0]]);
    expect(filterModelCatalogue(models, 'FIREWORKS')).toEqual([models[1]]);
    expect(filterModelCatalogue(models, 'openai:gpt')).toEqual([models[0]]);
    expect(filterModelCatalogue(models, '')).toEqual(models);
  });

  test('returns an honest empty projection for no match', () => {
    expect(filterModelCatalogue(models, 'claude')).toEqual([]);
  });
});
