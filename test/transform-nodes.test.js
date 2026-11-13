'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyRules, evaluateCondition } = require('../lib/rule-engine');
const { runScript } = require('../lib/script-runner');
const store = require('../lib/store');
const { runWorkflow } = require('../lib/graph-engine');

store.appendRun = () => {};
store.updateRun = () => {};

test('rules applies priority, safe actions, routes and keeps input immutable', async () => {
  const input = { age: 20, profile: { name: 'Ana' } };
  const logs = [];
  const result = await applyRules(input, [{
    id: 'adult', route: 'approved', priority: 10,
    conditions: { and: [
      { type: 'greaterThan', field: 'age', value: 17 },
      { type: 'fieldExists', field: 'profile.name' },
    ] },
    actions: [
      { type: 'setField', field: 'profile.approved', value: true },
      { type: 'log', message: 'Approved {{profile.name}}' },
    ],
  }], { log: (message) => logs.push(message) });
  assert.equal(input.profile.approved, undefined);
  assert.equal(result.output.profile.approved, true);
  assert.deepEqual(result.matchedRules, ['adult']);
  assert.deepEqual(result.__ports, ['matched', 'approved']);
  assert.deepEqual(logs, ['Approved Ana']);
});

test('rules uses unmatched and rejects executable or polluting payloads', async () => {
  const result = await applyRules({ age: 2 }, [{ conditions: { type: 'greaterThan', field: 'age', value: 17 }, actions: [] }]);
  assert.deepEqual(result.__ports, ['unmatched']);
  assert.throws(() => evaluateCondition({ expression: 'process.exit()' }, {}), /não são permitidas/);
  await assert.rejects(() => applyRules({}, [{ conditions: { type: 'fieldNull', field: 'x' }, actions: [{ type: 'setField', field: '__proto__.owned', value: true }] }]), /inseguro/);
  await assert.rejects(() => applyRules({ x: 'aaa' }, [{ conditions: { type: 'matchesRegex', field: 'x', value: '(a+)+$' }, actions: [] }]), /não permitida/);
  assert.equal({}.owned, undefined);
});

test('script returns JSON data and captures console output', async () => {
  const result = await runScript('console.log("value", input.x); return { doubled: input.x * 2 };', {
    input: { x: 4 }, trigger: {}, vars: {}, nodes: {},
  }, { timeoutMs: 1000 });
  assert.deepEqual(result.output, { doubled: 8 });
  assert.deepEqual(result.logs, ['value 4']);
});

test('script sandbox blocks host capabilities and dynamic-code escapes', async () => {
  for (const code of [
    'return process.cwd();',
    'return require("node:fs").readFileSync("/etc/passwd", "utf8");',
    'return fetch("https://example.com");',
    'return input.constructor.constructor("return process")();',
  ]) {
    await assert.rejects(() => runScript(code, { input: {}, trigger: {}, vars: {}, nodes: {} }, { timeoutMs: 1000 }));
  }
});

test('script sandbox kills synchronous infinite loops', async () => {
  const started = Date.now();
  await assert.rejects(() => runScript('while (true) {}', { input: {}, trigger: {}, vars: {}, nodes: {} }, { timeoutMs: 150 }), /excedeu|timed out/);
  assert.ok(Date.now() - started < 2000);
});

test('graph runs Script into Rules and activates generic and named routes', async () => {
  const workflow = {
    id: 'transform_graph', name: 'transform graph', trigger: { type: 'manual' },
    nodes: [
      { id: 'start', type: 'trigger', name: 'Start', config: {} },
      { id: 'script', type: 'script', name: 'Map', config: { input: '{{trigger}}', code: 'return { age: input.age + 1 };', timeoutMs: 1000 } },
      { id: 'rules', type: 'rules', name: 'Decide', config: { record: '{{nodes.script.output}}', rules: [{ id: 'adult', route: 'approved', conditions: { type: 'greaterThan', field: 'age', value: 17 }, actions: [{ type: 'setField', field: 'status', value: 'ok' }] }] } },
      { id: 'generic', type: 'log', name: 'Matched', config: { message: 'matched' } },
      { id: 'named', type: 'log', name: 'Approved', config: { message: 'approved' } },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'script' },
      { id: 'e2', from: 'script', to: 'rules' },
      { id: 'e3', from: 'rules', fromPort: 'matched', to: 'generic' },
      { id: 'e4', from: 'rules', fromPort: 'approved', to: 'named' },
    ],
  };
  const run = await runWorkflow(workflow, { age: 20 });
  assert.equal(run.status, 'ok');
  assert.equal(run.nodes.find((node) => node.id === 'rules').output.output.status, 'ok');
  assert.equal(run.edges.find((edge) => edge.id === 'e3').state, 'active');
  assert.equal(run.edges.find((edge) => edge.id === 'e4').state, 'active');
});
