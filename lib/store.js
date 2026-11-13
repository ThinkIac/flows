// packages/flows/lib/store.js — persistência em arquivos JSON (sem DB).
//
// Modelo 2.0: um workflow é um GRAFO (nodes[] + edges[]). Workflows antigos
// (steps[]) são migrados para um grafo linear na leitura — retrocompatível.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shapeOf, mergeShape } = require('./shape');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

const MAX_RUNS = 500;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file, fallback) {
  ensureDir();
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function token() { return crypto.randomBytes(16).toString('hex'); }

// ── Normalização ────────────────────────────────────────────────────────────────

// Shape absorvido do gatilho: mapa chave→tipo, no máximo 60 chaves de 1º nível.
// Só formato, nunca valores (ver lib/shape.js).
function normalizeShape(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return null;
  const out = {};
  for (const k of Object.keys(shape).slice(0, 60)) {
    const v = shape[k];
    out[String(k).slice(0, 80)] = (v && typeof v === 'object') ? 'object' : String(v).slice(0, 40);
  }
  return Object.keys(out).length ? out : null;
}

function normalizeTrigger(trigger = {}, existing = null) {
  const type = ['event', 'webhook', 'manual', 'semantic', 'cron', 'schedule'].includes(trigger.type)
    ? trigger.type : existing?.type || 'manual';
  const out = { type };
  if (type === 'event') {
    out.event = (trigger.event || existing?.event || '').toString().trim();
    if (trigger.resourceId || existing?.resourceId) out.resourceId = String(trigger.resourceId || existing.resourceId);
    // Interface do evento absorvida pelo flow. O catálogo do tap é memória e some
    // no reboot; aqui o shape sobrevive e alimenta o formulário de teste.
    //
    // O shape é do SERVIDOR: só absorbTriggerShape escreve nele. Aqui apenas o
    // carregamos adiante — e nunca quando o evento muda, senão o editor (que
    // devolve o trigger inteiro no PUT) colaria a interface do evento antigo no
    // novo. Ignorar trigger.shape do cliente também impede envenenar a interface.
    if (existing && existing.event === out.event) {
      const carried = normalizeShape(existing.shape);
      if (carried) out.shape = carried;
    }
  }
  if (type === 'webhook') out.webhookToken = trigger.webhookToken || existing?.webhookToken || token();
  if (type === 'semantic') {
    out.text = (trigger.text ?? existing?.text ?? '').toString().slice(0, 300);
    out.threshold = Number.isFinite(trigger.threshold) ? trigger.threshold
      : (Number.isFinite(existing?.threshold) ? existing.threshold : 0.6);
  }
  // Gatilho recorrente: expressão cron de 5 campos "min hora dom mês dow".
  if (type === 'cron') out.cron = (trigger.cron ?? existing?.cron ?? '0 9 * * *').toString().trim().slice(0, 120);
  // Gatilho de data única: dispara uma vez em `at` (ISO) e o flow se auto-desativa.
  if (type === 'schedule') out.at = (trigger.at ?? existing?.at ?? '').toString().trim().slice(0, 40);
  return out;
}

function normalizeNode(node = {}) {
  return {
    id: node.id || id('nd'),
    type: node.type || 'log',
    name: (node.name || node.type || 'nó').toString().slice(0, 80),
    config: node.config && typeof node.config === 'object' ? node.config : {},
    position: node.position && typeof node.position === 'object'
      ? { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 }
      : { x: 0, y: 0 },
    ...(node.type === 'agent-tool' && node.ownerAgentId ? { ownerAgentId: String(node.ownerAgentId) } : {}),
  };
}

function normalizeEdge(edge = {}) {
  return {
    id: edge.id || id('eg'),
    from: edge.from,
    fromPort: edge.fromPort || 'out',
    to: edge.to,
    ...(edge.toPort ? { toPort: edge.toPort } : {}),
    ...(edge.kind === 'agent-tool' ? { kind: 'agent-tool' } : {}),
  };
}

function normalizeInput(inp = {}) {
  return {
    name: (inp.name || 'param').toString().slice(0, 60),
    type: ['string', 'number', 'boolean', 'object', 'array'].includes(inp.type) ? inp.type : 'string',
    description: (inp.description || '').toString().slice(0, 200),
    required: !!inp.required,
  };
}

// Migra um workflow legado (steps[]) para o modelo de grafo (nodes[]+edges[]).
function migrate(wf) {
  if (Array.isArray(wf.nodes) && wf.nodes.length) return wf; // já é grafo
  if (!Array.isArray(wf.steps) || !wf.steps.length) {
    wf.nodes = wf.nodes || [];
    wf.edges = wf.edges || [];
    return wf;
  }
  const nodes = [];
  const edges = [];
  let prev = null;
  wf.steps.forEach((s, i) => {
    const n = normalizeNode({ id: s.id, type: s.type, name: s.name, config: s.config, position: { x: 80, y: 80 + i * 120 } });
    nodes.push(n);
    if (prev) edges.push(normalizeEdge({ from: prev.id, to: n.id }));
    prev = n;
  });
  wf.nodes = nodes;
  wf.edges = edges;
  return wf;
}

// ── Workflows ────────────────────────────────────────────────────────────────────

function listWorkflows() {
  return readJson(WORKFLOWS_FILE, []).map(migrate);
}
function getWorkflow(wfId) {
  return listWorkflows().find((w) => w.id === wfId) || null;
}
function saveWorkflows(all) { writeJson(WORKFLOWS_FILE, all); }

function applyFields(wf, input) {
  if (input.name !== undefined) wf.name = input.name.toString().slice(0, 120);
  if (input.description !== undefined) wf.description = input.description.toString().slice(0, 500);
  if (input.enabled !== undefined) wf.enabled = !!input.enabled;
  // Best-effort preserva o comportamento histórico. Durável torna checkpoints,
  // esperas e retomada opt-in por workflow.
  if (input.executionMode !== undefined) {
    wf.executionMode = input.executionMode === 'durable' ? 'durable' : 'best-effort';
  }
  // Opt-in por Flow. A autoridade continua limitada às Tools fixas declaradas
  // no grafo e é revalidada contra a definição e o código a cada execução.
  if (input.autoApprovePermissions !== undefined) wf.autoApprovePermissions = input.autoApprovePermissions === true;
  if (input.trigger !== undefined) wf.trigger = normalizeTrigger(input.trigger, wf.trigger);
  // Rede de segurança: um cliente legado pode enviar `steps[]` em vez de `nodes[]`
  // (editor antigo). Sem isto o save era silenciosamente descartado — ver
  // migrate(). Convertemos steps → grafo linear quando `nodes` não vier no patch.
  if (!Array.isArray(input.nodes) && Array.isArray(input.steps) && input.steps.length) {
    const migrated = migrate({ steps: input.steps });
    input = { ...input, nodes: migrated.nodes, edges: input.edges || migrated.edges };
  }
  if (Array.isArray(input.nodes)) wf.nodes = input.nodes.map(normalizeNode);
  if (Array.isArray(input.edges)) wf.edges = input.edges.map(normalizeEdge);
  if (Array.isArray(input.inputs)) wf.inputs = input.inputs.map(normalizeInput);
  if (input.publishAsTool !== undefined) wf.publishAsTool = !!input.publishAsTool;
  // Último payload usado no botão Testar. Persistido junto do flow para que o
  // formulário de teste volte preenchido depois de fechar o editor ou reiniciar.
  if (input.testPayload !== undefined) wf.testPayload = clampPayload(input.testPayload);
  return wf;
}

// Limita o tamanho de um payload guardado no workflow/run. Devolve null se não
// for serializável ou exceder o teto (o chamador decide o que fazer).
const MAX_PAYLOAD_BYTES = 64 * 1024;
function clampPayload(payload) {
  if (payload == null) return null;
  try {
    const s = JSON.stringify(payload);
    if (s === undefined || s.length > MAX_PAYLOAD_BYTES) return null;
    return JSON.parse(s);
  } catch { return null; }
}

function createWorkflow(input = {}) {
  const all = readJson(WORKFLOWS_FILE, []);
  const now = new Date().toISOString();
  const wf = applyFields({
    id: id('wf'),
    ...(input.localAccess === true ? { localAccess: true } : {}),
    name: 'Novo workflow',
    description: '',
    enabled: input.enabled !== false,
    executionMode: input.executionMode === 'durable' ? 'durable' : 'best-effort',
    autoApprovePermissions: input.autoApprovePermissions === true,
    trigger: { type: 'manual' },
    nodes: [{ id: id('nd'), type: 'trigger', name: 'Trigger', config: {}, position: { x: 80, y: 150 } }],
    edges: [],
    inputs: [],
    publishAsTool: false,
    createdAt: now,
    updatedAt: now,
  }, input);
  wf.trigger = normalizeTrigger(input.trigger || {});
  all.push(wf);
  saveWorkflows(all);
  return migrate(wf);
}

function updateWorkflow(wfId, patch = {}) {
  const all = readJson(WORKFLOWS_FILE, []);
  const idx = all.findIndex((w) => w.id === wfId);
  if (idx === -1) return null;
  const wf = applyFields(all[idx], patch);
  wf.updatedAt = new Date().toISOString();
  all[idx] = wf;
  saveWorkflows(all);
  return migrate(wf);
}

// Marca o último disparo por tempo (gatilhos cron/schedule). Usado pelo motor de
// tempo em index.js como guarda de deduplicação (evita disparar 2x no mesmo
// minuto) sem passar pela normalização completa de applyFields.
function markTriggered(wfId, iso) {
  const all = readJson(WORKFLOWS_FILE, []);
  const idx = all.findIndex((w) => w.id === wfId);
  if (idx === -1) return null;
  all[idx].lastTriggeredAt = iso || new Date().toISOString();
  saveWorkflows(all);
  return all[idx];
}

// Absorve a INTERFACE do payload que disparou o flow (gatilho event/webhook).
// Chamado no caminho de dispatch, então é barato: só grava quando o shape MUDA
// (chave nova), evitando I/O a cada evento. É isto que faz a interface do evento
// sobreviver ao reboot — o catálogo do tap, não.
function absorbTriggerShape(wfId, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const observed = normalizeShape(shapeOf(payload));
  if (!observed) return null;
  const all = readJson(WORKFLOWS_FILE, []);
  const idx = all.findIndex((w) => w.id === wfId);
  if (idx === -1) return null;
  const trigger = all[idx].trigger || {};
  const prev = normalizeShape(trigger.shape);
  const merged = normalizeShape(prev ? mergeShape(prev, observed) : observed);
  if (!merged) return null;
  if (prev && JSON.stringify(prev) === JSON.stringify(merged)) return prev; // nada novo: não escreve
  all[idx].trigger = { ...trigger, shape: merged };
  saveWorkflows(all);
  return merged;
}

// Duplica um workflow inteiro (nós, arestas, inputs, gatilho). A cópia:
//   • ganha ids novos para si, para cada nó e cada aresta (ids repetidos fariam
//     o editor e o motor confundirem os dois flows);
//   • nasce DESLIGADA e despublicada — duplicar não deve ativar automação nem
//     sobrescrever a tool gerada pelo original;
//   • recebe um webhookToken novo, senão as duas cópias responderiam na mesma URL.
function duplicateWorkflow(wfId, { name } = {}) {
  const all = readJson(WORKFLOWS_FILE, []);
  const src = all.find((w) => w.id === wfId);
  if (!src) return null;
  const origin = migrate(JSON.parse(JSON.stringify(src)));

  const idMap = new Map();
  let nodes = (origin.nodes || []).map((n) => {
    const fresh = id('nd');
    idMap.set(n.id, fresh);
    return normalizeNode({ ...n, id: fresh });
  });
  nodes = nodes.map((node) => node.type === 'agent-tool' && node.ownerAgentId
    ? { ...node, ownerAgentId: idMap.get(node.ownerAgentId) || node.ownerAgentId }
    : node);
  const edges = (origin.edges || [])
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((e) => normalizeEdge({ from: idMap.get(e.from), fromPort: e.fromPort, to: idMap.get(e.to), toPort: e.toPort, kind: e.kind, id: id('eg') }));

  const now = new Date().toISOString();
  const trigger = { ...(origin.trigger || { type: 'manual' }) };
  if (trigger.type === 'webhook') trigger.webhookToken = token();

  const copy = {
    id: id('wf'),
    ...(origin.localAccess === true ? { localAccess: true } : {}),
    name: (name || `${origin.name || 'Workflow'} (cópia)`).toString().slice(0, 120),
    description: origin.description || '',
    enabled: false,
    executionMode: origin.executionMode === 'durable' ? 'durable' : 'best-effort',
    // Uma cópia é uma nova automação e não herda aceite automático de risco.
    autoApprovePermissions: false,
    // `trigger` como existing também: preserva o shape absorvido do evento
    // (normalizeTrigger só carrega o shape quando o evento não mudou).
    trigger: normalizeTrigger(trigger, trigger),
    nodes,
    edges,
    inputs: (origin.inputs || []).map(normalizeInput),
    publishAsTool: false,
    testPayload: clampPayload(origin.testPayload ?? null),
    copyOf: origin.id,
    createdAt: now,
    updatedAt: now,
  };
  all.push(copy);
  saveWorkflows(all);
  return copy;
}

function deleteWorkflow(wfId) {
  const all = readJson(WORKFLOWS_FILE, []);
  const idx = all.findIndex((w) => w.id === wfId);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveWorkflows(all);
  return true;
}

// ── Runs ──────────────────────────────────────────────────────────────────────
function listRuns({ workflowId, limit = 50 } = {}) {
  let runs = readJson(RUNS_FILE, []);
  if (workflowId) runs = runs.filter((r) => r.workflowId === workflowId);
  return runs.slice(-Math.max(1, limit)).reverse();
}
function getRun(runId) {
  const runs = readJson(RUNS_FILE, []);
  return runs.find((r) => r.id === runId) || null;
}
function appendRun(run) {
  const runs = readJson(RUNS_FILE, []);
  runs.push(run);
  writeJson(RUNS_FILE, runs.slice(-MAX_RUNS));
  return run;
}

// Atualiza um run já persistido (ex.: de "running" para "ok"/"error" quando o
// grafo tem um nó human_approval e o run inicial foi persistido antes dele
// resolver). Sem-op silencioso se o run não existir mais (ex.: expulso do
// MAX_RUNS por volume de execuções concorrentes).
function updateRun(runId, patch) {
  const runs = readJson(RUNS_FILE, []);
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx === -1) return null;
  runs[idx] = { ...runs[idx], ...patch };
  writeJson(RUNS_FILE, runs);
  return runs[idx];
}

module.exports = {
  DATA_DIR, id, token, clampPayload,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, duplicateWorkflow, deleteWorkflow, markTriggered,
  absorbTriggerShape,
  listRuns, getRun, appendRun, updateRun,
  normalizeNode, normalizeEdge, normalizeTrigger, normalizeInput, normalizeShape, migrate,
};
