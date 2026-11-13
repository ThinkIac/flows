import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthorizationStore } from '../lib/authorization.mjs';

const workflow = () => ({ id: 'wf1', trigger: { type: 'event', event: 'visit' }, nodes: [{ id: 'n1', type: 'tool', config: { package: 'desta-casa', name: 'solicitar', args: { property: 'A', visitor: '{{trigger.name}}' } } }], edges: [] });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let wf = workflow(), code = 'v1';
  const options = { file: join(dir, 'grants.json'), getWorkflow: id => id === wf.id ? wf : null, fingerprintPackage: () => code };
  return { open: () => createAuthorizationStore(options), wf, changeCode: () => code = 'v2' };
}
test('authorization repeats across runs and process reload; revocation is immediate', t => {
  const f = fixture(t), db = f.open(), scope = db.preview('wf1');
  db.approve('wf1', scope.scopeHash);
  const context = { workflow: f.wf, nodeId: 'n1' };
  assert.ok(db.match(context, 'desta-casa', 'solicitar'));
  assert.ok(f.open().match(context, 'desta-casa', 'solicitar'));
  f.open().revoke('wf1');
  assert.equal(db.match(context, 'desta-casa', 'solicitar'), null);
});
test('edits, different tools, copies and code changes cannot inherit approval', t => {
  const f = fixture(t), db = f.open();
  db.approve('wf1', db.preview('wf1').scopeHash);
  assert.equal(db.match({ workflow: f.wf, nodeId: 'n1' }, 'other', 'solicitar'), null);
  assert.equal(db.match({ workflow: { ...f.wf, id: 'copy' }, nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
  const snapshot = structuredClone(f.wf);
  f.wf.nodes[0].config.args.property = 'B';
  assert.equal(db.match({ workflow: snapshot, nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
  assert.throws(() => db.approve('wf1', db.scopeHash(snapshot)), /alterado/);
  db.approve('wf1', db.preview('wf1').scopeHash);
  f.changeCode();
  assert.equal(db.match({ workflow: f.wf, nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
});
test('cosmetic edits preserve authorization and client data cannot grant permission', t => {
  const f = fixture(t), db = f.open();
  f.wf.authorization = { approved: true };
  assert.equal(db.match({ workflow: f.wf, nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
  db.approve('wf1', db.preview('wf1').scopeHash);
  f.wf.name = 'New title'; f.wf.nodes[0].position = { x: 2, y: 3 };
  assert.ok(db.match({ workflow: f.wf, nodeId: 'n1' }, 'desta-casa', 'solicitar'));
});
test('dynamic tool identities are excluded from preauthorization', t => {
  const f = fixture(t), db = f.open();
  f.wf.nodes[0].config.name = '{{trigger.tool}}';
  assert.equal(db.preview('wf1').actions.length, 0);
  assert.throws(() => db.approve('wf1', db.preview('wf1').scopeHash), /ferramenta/);
});

test('per-flow automatic acceptance authorizes fixed tools without a stored grant', t => {
  const f = fixture(t), db = f.open();
  f.wf.autoApprovePermissions = true;
  const preview = db.preview('wf1');
  assert.equal(preview.active, true);
  assert.equal(preview.automatic, true);
  assert.equal(preview.explicitActive, false);
  const context = { workflow: structuredClone(f.wf), nodeId: 'n1' };
  const grant = db.match(context, 'desta-casa', 'solicitar');
  assert.equal(grant?.source, 'flow:auto-approve');
  assert.match(grant?.id || '', /^auto:/);
  assert.equal(db.match(context, 'other', 'solicitar'), null);
});

test('automatic acceptance fails closed for stale definitions and dynamic tools', t => {
  const f = fixture(t), db = f.open();
  f.wf.autoApprovePermissions = true;
  const stale = structuredClone(f.wf);
  f.wf.nodes[0].config.args.property = 'B';
  assert.equal(db.match({ workflow: stale, nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
  f.wf.nodes[0].config.name = '{{trigger.tool}}';
  assert.equal(db.match({ workflow: structuredClone(f.wf), nodeId: 'n1' }, 'desta-casa', 'solicitar'), null);
});

test('agent preauthorization is propagated only to its explicitly selected tools', t => {
  const f = fixture(t), db = f.open();
  f.wf.nodes[0] = {
    id: 'agent', type: 'agent',
    config: { goal: 'Crie um lembrete', toolNames: ['create_task'] },
  };
  db.approve('wf1', db.preview('wf1').scopeHash);
  const context = { workflow: f.wf, nodeId: 'agent' };
  assert.ok(db.match(context, null, 'create_task'));
  assert.equal(db.match(context, null, 'delete_task'), null);
  assert.equal(db.match(context, 'tasks', 'create_task'), null);
});

test('agent outer call is authorized under its concrete package identity', t => {
  const f = fixture(t), db = f.open();
  f.wf.autoApprovePermissions = true;
  f.wf.nodes[0] = {
    id: 'agent', type: 'agent',
    config: { goal: 'Atenda o contato', toolNames: ['create_task'] },
  };
  const context = { workflow: structuredClone(f.wf), nodeId: 'agent' };
  assert.ok(db.match(context, 'agent', 'call_llm_agent'));
  assert.equal(db.match(context, null, 'call_llm_agent'), null);
});

test('graph carries authorization through repeated and resumed runs; revocation blocks resume', async t => {
  const { default: store } = await import('../lib/store.js');
  const { default: graph } = await import('../lib/graph-engine.js');
  const f = fixture(t), db = f.open(), records = new Map();
  const original = { appendRun: store.appendRun, updateRun: store.updateRun };
  t.after(() => Object.assign(store, original));
  store.appendRun = run => { records.set(run.id, structuredClone(run)); return run; };
  store.updateRun = (id, patch) => { const next = { ...records.get(id), ...structuredClone(patch) }; records.set(id, next); return next; };
  f.wf.executionMode = 'durable';
  f.wf.nodes.unshift({ id: 'wait', type: 'delay', config: { ms: 1000 } });
  f.wf.edges.push({ from: 'wait', to: 'n1' });
  db.approve('wf1', db.preview('wf1').scopeHash);
  let calls = 0;
  const deps = { runTool: async (pkg, name, args, options) => {
    assert.ok(options.sessionId.startsWith('flow:'));
    if (!db.match(options.flowContext, pkg, name)) throw Error('approval required');
    assert.equal(args.visitor, 'Visitor'); calls++;
    return { success: true };
  } };
  for (let i = 0; i < 2; i++) {
    const first = await graph.runWorkflow(f.wf, { name: 'Visitor' }, {}, deps);
    assert.equal(first.status, 'waiting');
    const resumed = await graph.resumeWorkflow(f.wf, { ...records.get(first.id), wakeAt: new Date(0).toISOString() }, {}, deps);
    assert.equal(resumed.status, 'ok');
  }
  assert.equal(calls, 2);
  const first = await graph.runWorkflow(f.wf, { name: 'Visitor' }, {}, deps);
  db.revoke('wf1');
  const resumed = await graph.resumeWorkflow(f.wf, { ...records.get(first.id), wakeAt: new Date(0).toISOString() }, {}, deps);
  assert.equal(resumed.status, 'error');
  assert.equal(calls, 2);
});
