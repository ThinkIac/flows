import test from 'node:test';
import assert from 'node:assert/strict';
import { changesBetween, applyChanges, saveQueue } from '../views/workspace-state.js';

test('panel edits preserve concurrent movement and unrelated nodes', () => {
  const base = { trigger: { type: 'manual' }, nodes: [{ id: 'a', name: 'A', position: { x: 1 }, config: {} }], edges: [] };
  const draft = structuredClone(base); draft.nodes[0].config.message = 'hello'; draft.trigger = { type: 'event', event: 'test:*' };
  const current = structuredClone(base); current.nodes[0].position.x = 200; current.nodes.push({ id: 'b' });
  const merged = applyChanges(current, changesBetween(base, draft));
  assert.equal(merged.nodes[0].position.x, 200); assert.equal(merged.nodes[0].config.message, 'hello');
  assert.equal(merged.nodes[1].id, 'b'); assert.deepEqual(merged.trigger, draft.trigger);
});
test('deleted nodes cannot be resurrected by a late property edit', () => {
  assert.deepEqual(applyChanges({ nodes: [] }, changesBetween({ nodes: [{ id: 'a', name: 'old' }] }, { nodes: [{ id: 'a', name: 'new' }] })), { nodes: [] });
});
test('saves are ordered, snapshot their input and recover after failure', async () => {
  const calls = []; let release;
  const queue = saveQueue(async (value) => { calls.push(value.n); if (value.n === 1) await new Promise(r => release = r); if (value.n === 2) throw Error('offline'); return true; });
  const input = { n: 1 }; const first = queue(input); input.n = 99;
  const second = queue({ n: 2 }); const failed = assert.rejects(second, /offline/); const third = queue({ n: 3 });
  await new Promise(r => setImmediate(r)); assert.deepEqual(calls, [1]); release();
  await first; await failed; await third; assert.deepEqual(calls, [1, 2, 3]);
});

test('workspace opening emits a host event without navigation', async () => {
  const { openWorkspace } = await import('../views/workspace-flow.js');
  const messages=[]; const previous=globalThis.window;
  globalThis.window={location:{origin:'https://local',href:'https://local/flows'},top:{postMessage:(...args)=>messages.push(args)}};
  try {
    openWorkspace({id:'flow-a',name:'A'});
    assert.deepEqual(messages,[[{source:'agent',type:'canvas-document:open',detail:{appId:'flows',item:{id:'flow-a',name:'A'}}},'https://local']]);
    assert.equal(window.location.href,'https://local/flows');
  } finally { if(previous===undefined)delete globalThis.window;else globalThis.window=previous; }
});
