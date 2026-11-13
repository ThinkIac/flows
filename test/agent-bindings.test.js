const test = require('node:test');
const assert = require('node:assert/strict');
const { compileAgentBindings } = require('../lib/agent-bindings');
const { runWorkflow } = require('../lib/graph-engine');

function workflow() {
  return {
    id: 'wf-bindings', trigger: { type: 'manual' },
    nodes: [
      { id: 'agent', type: 'agent', name: 'Agent', config: { goal: 'Leia a mensagem' }, position: { x: 0, y: 0 } },
      { id: 'binding', type: 'agent-tool', name: 'getMessage', ownerAgentId: 'agent', position: { x: 220, y: 0 }, config: {
        toolName: 'getMessage', package: 'mail', args: { messageId: '{{trigger.id}}', empty: '', zero: 0, disabled: false, nullable: null },
        argModes: { messageId: 'fixed', empty: 'fixed', zero: 'fixed', disabled: 'fixed', nullable: 'fixed', body: 'ai' },
        schemaSnapshot: { type: 'object', required: ['messageId', 'body'], properties: { messageId: { type: 'string' }, body: { type: 'string' }, empty: { type: 'string' }, zero: { type: 'number' }, disabled: { type: 'boolean' }, nullable: { type: 'object', nullable: true } } },
      } },
    ],
    edges: [{ id: 'cap', from: 'agent', fromPort: 'tools', to: 'binding', toPort: 'capability', kind: 'agent-tool' }],
  };
}

test('compila campos fixos sem perder valores falsy e remove-os do schema do modelo', () => {
  const [binding] = compileAgentBindings(workflow().nodes[0], workflow());
  assert.deepEqual(binding.fixedArgs, { messageId: '{{trigger.id}}', empty: '', zero: 0, disabled: false, nullable: null });
  assert.deepEqual(Object.keys(binding.inputSchemaForModel.properties), ['body']);
  assert.deepEqual(binding.inputSchemaForModel.required, ['body']);
});

test('binding não é agendado e chega compilado ao executor do Agent', async () => {
  let call;
  const result = await runWorkflow(workflow(), { id: 'msg-42' }, {}, { runTool: async (pkg, tool, args) => { call = { pkg, tool, args }; return { success: true, text: 'ok' }; } });
  assert.equal(result.status, 'ok');
  assert.equal(result.nodes.length, 1);
  assert.equal(call.tool, 'call_llm_agent');
  assert.deepEqual(call.args.tool_names, ['getMessage']);
  assert.equal(call.args.tool_bindings[0].fixedArgs.messageId, 'msg-42');
  assert.equal(call.args.tool_bindings[0].fixedArgs.disabled, false);
});

test('rejeita a mesma tool duplicada no mesmo Agent', () => {
  const wf = workflow();
  wf.nodes.push({ ...wf.nodes[1], id: 'binding-2' });
  assert.throws(() => compileAgentBindings(wf.nodes[0], wf), /tool duplicada/);
});
