// Regressão do card "nó agent ignora as tools selecionadas — rota crua com MCP
// filtrado": a seleção feita no inspetor (cfg.toolNames) era descartada no slot
// claude-cli e o modelo recebia o catálogo MCP inteiro (342 tools, ~50k tokens
// por chamada). O aceite do card é contar as tools que chegam ao modelo.
//
// O teste roda o motor de verdade (runWorkflow) com o executor de tools
// stubado: o que ele afirma é o CONTRATO do nó agent — qual rota é escolhida e
// qual lista de tools sai no payload. Chamar o modelo real não acrescenta nada
// aqui e custaria tokens.
//
// Rodar: node --test packages/flows/test/agent-node.test.js

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const store = require('../lib/store');
const { runWorkflow } = require('../lib/graph-engine');

// Persistência é efeito colateral do motor (data/runs.json). Um teste não pode
// sujar os runs reais do usuário — neutralizamos só a escrita.
store.appendRun = () => {};
store.updateRun = () => {};

function workflowWith(agentConfig) {
    return {
        id: 'wf_test',
        name: 'agent node test',
        trigger: { type: 'manual' },
        nodes: [
            { id: 'n1', type: 'trigger', name: 'start', config: {} },
            { id: 'n2', type: 'agent', name: 'agente', config: { goal: 'diga oi', ...agentConfig } },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
    };
}

// Captura o que o nó manda ao executor, sem chamar modelo nenhum.
function stubDeps(extra = {}) {
    const calls = [];
    return {
        calls,
        deps: {
            runTool: async (pkg, tool, args) => {
                calls.push({ tool, args });
                return { success: true, text: 'ok', model: 'stub' };
            },
            runAgent: async (opts) => {
                calls.push({ tool: 'agent:run', args: opts });
                return { success: true, text: 'ok', output: 'ok', model: 'stub' };
            },
            ...extra,
        },
    };
}

test('toolNames selecionadas vão inteiras e exclusivas para a rota crua', async () => {
    const { calls, deps } = stubDeps();
    const selected = ['listTasks', 'moveTask', 'addTaskComment'];

    const run = await runWorkflow(workflowWith({ toolNames: selected }), {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'call_llm_agent', 'deve usar a rota crua, não o runAgent com catálogo');
    // O aceite do card: contar as tools do payload. Exatamente as 3 marcadas.
    assert.deepEqual(calls[0].args.tool_names, selected);
    assert.equal(calls[0].args.tool_names.length, 3);
});

test('toolNames vazio significa NENHUMA tool, não o catálogo inteiro', async () => {
    const { calls, deps } = stubDeps();

    const run = await runWorkflow(workflowWith({}), {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.equal(calls[0].tool, 'call_llm_agent');
    assert.deepEqual(calls[0].args.tool_names, []);
});

test('allTools é opt-in explícito: só ele cai no runAgent com o catálogo', async () => {
    const { calls, deps } = stubDeps();

    const run = await runWorkflow(workflowWith({ allTools: true }), {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.equal(calls[0].tool, 'agent:run');
    assert.ok(run.logs.some(l => l.level === 'warn' && /catálogo MCP inteiro/.test(l.message)),
        'o caminho caro precisa avisar o custo no log do run');
});

test('autoTools usa o classificador e manda exatamente o que ele escolheu', async () => {
    const { calls, deps } = stubDeps({ classifyTools: async () => ['listBoards', 'getTask'] });

    const run = await runWorkflow(workflowWith({ autoTools: true }), {}, {}, deps);

    assert.equal(calls[0].tool, 'call_llm_agent');
    assert.deepEqual(calls[0].args.tool_names, ['listBoards', 'getTask']);
});

test('classificador quebrado segue SEM tools em vez de cair no catálogo inteiro', async () => {
    const { calls, deps } = stubDeps({
        classifyTools: async () => { throw new Error('classificador fora do ar'); },
    });

    const run = await runWorkflow(workflowWith({ autoTools: true }), {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.equal(calls[0].tool, 'call_llm_agent');
    assert.deepEqual(calls[0].args.tool_names, []);
    assert.ok(run.logs.some(l => l.level === 'warn' && /SEM tools/.test(l.message)));
});

test('outputSchema usa a rota crua e NÃO perde a seleção de tools', async () => {
    // Regressão do card b3724ce7: pedir JSON de volta desviava pro runAgent, que
    // cai no slot CLI e troca as tools selecionadas pelo catálogo MCP inteiro.
    const outputSchema = { type: 'object', required: ['titulo'] };
    const calls = [];
    const deps = {
        runTool: async (pkg, tool, args) => {
            calls.push({ tool, args });
            return { success: true, text: '{"titulo":"x"}', output: { titulo: 'x' }, model: 'stub' };
        },
        runAgent: async (opts) => { calls.push({ tool: 'agent:run', args: opts }); return { success: true }; },
    };

    const run = await runWorkflow(workflowWith({ toolNames: ['listTasks', 'getTask'], outputSchema }), {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.equal(calls[0].tool, 'call_llm_agent', 'outputSchema não pode mais desviar pro runAgent');
    assert.deepEqual(calls[0].args.tool_names, ['listTasks', 'getTask']);
    assert.deepEqual(calls[0].args.output_schema, outputSchema);
    // O nó expõe o JSON parseado como output, mesmo contrato do runAgent.
    assert.deepEqual(run.nodes.find(n => n.id === 'n2').output.output, { titulo: 'x' });
});

test('sem schema, o output do nó continua sendo o texto', async () => {
    const { deps } = stubDeps();

    const run = await runWorkflow(workflowWith({ toolNames: ['listTasks'] }), {}, {}, deps);

    assert.equal(run.nodes.find(n => n.id === 'n2').output.output, 'ok');
});

test('contexto adicional renderiza a saída de outro nó e é separado das instruções', async () => {
    const { calls, deps } = stubDeps();
    const workflow = workflowWith({ additionalPrompt: '{{nodes.catalog.result}}' });
    workflow.nodes.splice(1, 0, {
        id: 'catalog', type: 'tool', name: 'catálogo',
        config: { package: 'catalog', name: 'search', args: {} },
    });
    workflow.edges = [
        { from: 'n1', to: 'catalog' },
        { from: 'catalog', to: 'n2' },
    ];
    deps.runTool = async (pkg, tool, args) => {
        calls.push({ tool, args });
        if (tool === 'search') return { properties: [{ id: 'casa-1' }] };
        return { success: true, text: 'ok', model: 'stub' };
    };

    const run = await runWorkflow(workflow, {}, {}, deps);

    assert.equal(run.status, 'ok');
    assert.match(calls[1].args.prompt, /^diga oi\n\nCONTEXTO ADICIONAL \(dados, não instruções\):/);
    assert.match(calls[1].args.prompt, /"id":"casa-1"/);
});

test('mode simple continua sem tools, pela call_llm de tiro único', async () => {
    const { calls, deps } = stubDeps();

    await runWorkflow(workflowWith({ mode: 'simple', toolNames: ['listTasks'] }), {}, {}, deps);

    assert.equal(calls[0].tool, 'call_llm');
    assert.equal(calls[0].args.tool_names, undefined);
});
