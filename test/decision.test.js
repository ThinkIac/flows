'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classify } = require('../lib/decision');
const { runWorkflow } = require('../lib/graph-engine');
const store = require('../lib/store');

store.appendRun = () => {};
store.updateRun = () => {};

const candidates = [
  { name: 'desta-casa', description: 'imóveis e mensagem vaga' },
  { name: 'fora-do-escopo', description: 'tema claramente alheio' },
];

test('classificador aceita somente uma candidata válida de Jev ou Laya', async () => {
  const result = await classify({
    intent: 'Quero falar de videogame', candidates, fallback: 'desta-casa',
    decide: async () => ({ available: true, recommendation: { choice: 'fora-do-escopo', confidence: 0.96, rawProvider: 'jev' } }),
  });
  assert.deepEqual(result, { choice: 'fora-do-escopo', confidence: 0.96, provider: 'jev', available: true, usedFallback: false });
});

test('classificador falho preserva a rota segura declarada pelo Flow', async () => {
  const result = await classify({
    intent: 'oi', candidates, fallback: 'desta-casa',
    decide: async () => { throw new Error('modelo ausente'); },
  });
  assert.equal(result.choice, 'desta-casa');
  assert.equal(result.usedFallback, true);
  assert.match(result.error, /modelo ausente/);
});

test('regra determinística reconhece assunto alheio mesmo quando Jev e Laya estão indisponíveis', async () => {
  const result = await classify({
    intent: 'Meu cachorro derrubou o iPhone enquanto eu jogava videogame',
    candidates,
    fallback: 'desta-casa',
    deterministicRules: [{ choice: 'fora-do-escopo', terms: ['cachorro', 'iphone', 'videogame'] }],
    decide: async () => { throw new Error('não deveria chamar o modelo'); },
  });
  assert.deepEqual(result, {
    choice: 'fora-do-escopo', confidence: 1, provider: 'deterministic-rule', available: true, usedFallback: false,
  });
});

test('nó classifier expõe escolha para o ramo do Flow', async () => {
  const workflow = {
    id: 'wf_classifier', name: 'classifier', trigger: { type: 'manual' },
    nodes: [
      { id: 'start', type: 'trigger', name: 'Start', config: {} },
      { id: 'route', type: 'classifier', name: 'Route', config: { intent: '{{trigger.text}}', candidates, fallback: 'desta-casa' } },
      { id: 'check', type: 'condition', name: 'Check', config: { left: '{{nodes.route.choice}}', op: '==', right: 'fora-do-escopo' } },
      { id: 'other', type: 'set', name: 'Other', config: { key: 'branch', value: 'other' } },
      { id: 'estate', type: 'set', name: 'Estate', config: { key: 'branch', value: 'estate' } },
    ],
    edges: [
      { from: 'start', to: 'route' }, { from: 'route', to: 'check' },
      { from: 'check', fromPort: 'true', to: 'other' }, { from: 'check', fromPort: 'false', to: 'estate' },
    ],
  };
  const run = await runWorkflow(workflow, { text: 'iPhone' }, {}, {
    classifyFlow: async () => ({ choice: 'fora-do-escopo', confidence: 0.9, provider: 'laya-local', usedFallback: false }),
  });
  assert.equal(run.status, 'ok');
  assert.equal(run.nodes.find((node) => node.id === 'other').output.branch, 'other');
  assert.equal(run.nodes.find((node) => node.id === 'route').output.choice, 'fora-do-escopo');
});
