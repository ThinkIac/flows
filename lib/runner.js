// packages/flows/lib/runner.js — monta as dependências do motor e executa flows.
// Usado tanto pelo index.js quanto pelos tools gerados em generated/.

'use strict';

const { emit } = require('logos');
const graph = require('./graph-engine');
const tools = require('./tools');
const store = require('./store');
const llmOptions = require('./llm-options');
const sessionMsg = require('./session-msg');

// Classificador de tools da Agent (packages/classification): a MESMA passada
// que o chat usa para reduzir o catálogo às tools relevantes do turno. O nó
// agent chama isto quando nenhuma tool foi escolhida à mão no inspetor.
// require preguiçoso: o pacote classification pode estar desinstalado/desligado,
// e nesse caso o agente simplesmente recebe o catálogo inteiro.
let _classifier;
async function classifyTools(goal, { sessionId } = {}) {
  if (_classifier === undefined) {
    try { _classifier = require('../../classification/hook'); }
    catch { _classifier = null; }
  }
  if (!_classifier?.onAgentStart) return null;
  const args = await _classifier.onAgentStart({ message: String(goal || ''), sessionId: sessionId || `flow:${Date.now()}` });
  const selected = args?.selectedTools;
  if (!Array.isArray(selected) || !selected.length) return null;
  return selected.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
}

async function runAgent(options) {
  const { runAgentTask } = await import('../../agent/host/logos/index.js');
  return runAgentTask(options);
}

const deps = { emit, runTool: tools.runTool, runAgent, sendSessionMessage: sessionMsg.sendSessionMessage, classifyTools };
deps.runWorkflow = (wf, payload, meta) => run(wf, payload, meta || {});

async function run(workflow, payload, meta) {
  const { localDependencies } = await import('./local-policy.js');
  const local = localDependencies(workflow, meta, payload);
  return graph.runWorkflow(workflow, local?.filteredPayload || payload || {}, meta || { source: 'manual' }, local ? { ...deps, ...local } : deps);
}

async function resume(runRecord) {
  const wf = runRecord.workflowSnapshot || store.getWorkflow(runRecord.workflowId);
  if (!wf) throw new Error(`workflow "${runRecord.workflowId}" não encontrado para retomada`);
  if (wf.executionMode !== 'durable') throw new Error('workflow não está em modo durável');
  try {
    const { localDependencies } = await import('./local-policy.js');
    const local = localDependencies(wf, { localSubject: runRecord.localSubject });
    return await graph.resumeWorkflow(wf, runRecord, {}, local ? { ...deps, ...local } : deps);
  } catch (err) {
    // Uma falha transitória ao retomar não pode consumir o checkpoint. Mantém o
    // run elegível para a próxima recuperação/tick em vez de abandoná-lo como
    // "running" sem executor.
    store.updateRun(runRecord.id, { ...runRecord, status: 'waiting', wakeAt: new Date(Date.now() + 30000).toISOString(), lastResumeError: err.message });
    throw err;
  }
}

async function runById(workflowId, payload, meta) {
  const wf = store.getWorkflow(workflowId);
  if (!wf) throw new Error(`workflow "${workflowId}" não encontrado`);
  return run(wf, payload, meta);
}

module.exports = { deps, run, runById, resume, classifyTools, resolveApproval: graph.resolveApproval };
