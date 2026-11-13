'use strict';

// Contrato da execução durável:
// - delay não mantém um timer em memória; o run fica waiting com wakeAt.
// - ao retomar, os nós já confirmados não executam outra vez.
// - efeitos externos recebem uma chave estável por run/nó para idempotência.

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const { runWorkflow, resumeWorkflow } = require('../lib/graph-engine');

function durable(nodes, edges) {
  return { id: 'wf_durable_test', name: 'Durável', executionMode: 'durable', trigger: { type: 'manual' }, nodes, edges };
}

function memoryStore(t) {
  const runs = new Map();
  const original = { appendRun: store.appendRun, updateRun: store.updateRun };
  store.appendRun = (run) => { runs.set(run.id, structuredClone(run)); return run; };
  store.updateRun = (id, patch) => {
    const next = { ...(runs.get(id) || {}), ...structuredClone(patch) };
    runs.set(id, next);
    return next;
  };
  t.after(() => Object.assign(store, original));
  return runs;
}

test('delay durável persiste wakeAt e retoma sem esperar timer em memória', async (t) => {
  const runs = memoryStore(t);
  const wf = durable(
    [{ id: 'start', type: 'trigger', name: 'Início' }, { id: 'wait', type: 'delay', name: 'Espera', config: { ms: 1000 } }, { id: 'done', type: 'set', name: 'Fim', config: { key: 'ok', value: true } }],
    [{ from: 'start', to: 'wait' }, { from: 'wait', to: 'done' }],
  );
  const first = await runWorkflow(wf, { a: 1 }, {}, {});
  assert.equal(first.status, 'waiting');
  assert.ok(Date.parse(first.wakeAt) > Date.now());
  assert.equal(runs.get(first.id).checkpoint.nodeState.wait, 'pending');

  const resumed = await resumeWorkflow(wf, { ...runs.get(first.id), wakeAt: new Date(Date.now() - 1).toISOString() }, {}, {});
  assert.equal(resumed.status, 'ok');
  assert.equal(resumed.nodes.find((node) => node.id === 'done').output.ok, true);
});

test('retomada não repete nó confirmado e fornece chave de idempotência ao efeito', async (t) => {
  const runs = memoryStore(t);
  const calls = [];
  const wf = durable(
    [{ id: 'start', type: 'trigger', name: 'Início' }, { id: 'effect', type: 'tool', name: 'Efeito', config: { package: 'x', name: 'send', args: {} } }, { id: 'wait', type: 'delay', name: 'Espera', config: { ms: 1000 } }],
    [{ from: 'start', to: 'effect' }, { from: 'effect', to: 'wait' }],
  );
  const deps = { runTool: async (_pkg, _name, _args, options) => { calls.push(options.idempotencyKey); return { success: true }; } };
  const first = await runWorkflow(wf, {}, {}, deps);
  assert.equal(first.status, 'waiting');
  const resumed = await resumeWorkflow(wf, { ...runs.get(first.id), wakeAt: new Date(Date.now() - 1).toISOString() }, {}, deps);
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(calls, [`${first.id}:effect`]);
});
