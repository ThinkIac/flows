// packages/flows/index.js — Flows 2.0: automação estilo n8n/Make no runtime Lógos.
//
// O que faz:
//   • escuta eventos do event bus e dispara workflows (trigger `event`)
//   • expõe webhooks públicos que disparam workflows (trigger `webhook`)
//   • executa workflows manualmente pela API/UI/tool (trigger `manual`)
//   • DESCOBRE eventos automaticamente (tap do bus) com payload sugerido
//   • oferece tools @register_tool como nós (catálogo do runtime)
//   • gatilho SEMÂNTICO: casa eventos por similaridade de embeddings (Ollama)
//   • um flow pode virar uma tool: gera generated/<id>.js com @register_tool
//
// Motor: DAG (lib/graph-engine via lib/runner). Rotas em /flows/*, views em
// /view/flows/Index e /view/flows/Editor.

'use strict';

const { on, getDefaultContainer } = require('logos');
const store = require('./lib/store');
const runner = require('./lib/runner');
const tap = require('./lib/tap');
const tools = require('./lib/tools');
const semantic = require('./lib/semantic');
const embedder = require('./lib/embedder');
const publish = require('./lib/publish');
const llmOptions = require('./lib/llm-options');
const cron = require('./lib/cron');
const templates = require('./lib/templates');
const shapeUtil = require('./lib/shape');

// ── Wiring no load (boot e cada hot-reload do módulo) ──────────────────────────
//
// tap: grampeia o bus singleton para descobrir eventos + alimentar o semântico.
// semantic: recebe (evento, payload) do tap e dispara flows por similaridade.
// Idempotência: tap guarda estado em globalThis; semantic.init só troca ponteiros.

try {
  const container = getDefaultContainer && getDefaultContainer();
  if (container && container.bus) tap.install(container.bus);
} catch { /* observação nunca quebra o boot */ }

semantic.init({ runFlow: runner.run });
tap.onEvent(semantic.handle);

// ── Inscrições no event bus para triggers do tipo `event` ──────────────────────
//
// Padrões de evento são dinâmicos (definidos pelos workflows), então inscrevemos
// via on() em vez de @register_hook. Guardamos os offs em globalThis para que um
// hot-reload não acumule handlers duplicados.
//
// A chave é POR DIRETÓRIO do pacote (STATE_KEY): uma cópia deste pacote dentro de
// packages/ (flows.bak, flows2…) também é escaneada e re-executada pelo runtime, e
// com a chave compartilhada ela chamava clearSubscriptions() e derrubava as
// inscrições do flows real — todos os gatilhos de evento morriam em silêncio,
// voltando só até o próximo re-scan. Cada cópia agora mexe apenas no seu estado.

const STATE_KEY = (name) => `__flows:${name}:${__dirname}`;

const REG = (globalThis[STATE_KEY('subscriptions')] = globalThis[STATE_KEY('subscriptions')] || { offs: [] });

function clearSubscriptions() {
  for (const off of REG.offs) { try { off && off(); } catch { /* ignore */ } }
  REG.offs = [];
}

function rebuildSubscriptions() {
  clearSubscriptions();
  const patterns = new Set(
    store.listWorkflows()
      .filter((w) => w.enabled && w.trigger?.type === 'event' && w.trigger.event)
      .map((w) => w.trigger.event)
  );
  for (const pattern of patterns) {
    const off = on(pattern, async (payload) => {
      const matching = store.listWorkflows()
        .filter((w) => w.enabled && w.trigger?.type === 'event' && w.trigger.event === pattern);
      for (const wf of matching) {
        // Absorve a interface do evento NO FLOW (não só no tap, que é memória e
        // some no reboot) — é o que permite oferecer um formulário de teste com
        // os campos certos depois de reiniciar o runtime.
        try { if (!wf.localAccess) store.absorbTriggerShape(wf.id, payload); } catch { /* observação nunca quebra o disparo */ }
        // Eventos de entrada não podem ficar presos por waits do workflow.
        // Isso permite que mensagens seguintes sejam persistidas durante um
        // debounce, em vez de só chegarem ao Flow depois que ele responder.
        void runner.run(wf, payload, { source: `event:${pattern}` }).catch(() => { /* isola o bus */ });
      }
    });
    if (typeof off === 'function') REG.offs.push(off);
  }
  return patterns.size;
}

rebuildSubscriptions();

// ── Motor de tempo: gatilhos `cron` (recorrente) e `schedule` (data única) ──────
//
// Tick a cada 30s. Dedupe por minuto via wf.lastTriggeredAt (dois ticks caem no
// mesmo minuto). Um gatilho `schedule` dispara uma vez quando `at` já passou e
// então AUTO-DESATIVA o flow (enabled=false) — a própria desativação é a guarda
// contra redisparo. Estado do interval em globalThis para não acumular no
// hot-reload deste módulo (mesma chave por diretório das inscrições acima — uma
// cópia do pacote não pode dar clearInterval no tick do flows real).

const TIME = (globalThis[STATE_KEY('timeEngine')] = globalThis[STATE_KEY('timeEngine')] || { interval: null });

function recoverDurableRuns() {
  const nowDate = new Date();
  for (const run of store.listRuns({ limit: 500 })) {
    // `running` só é recuperado no boot: durante a vida normal do processo ele
    // pode ser um nó legítimo ainda em execução. `waiting` é seguro retomar
    // sempre que seu wakeAt venceu.
    if (run.executionMode !== 'durable' || !run.checkpoint) continue;
    if (run.status === 'running' || (run.status === 'waiting' && run.wakeAt && new Date(run.wakeAt) <= nowDate)) {
      runner.resume(run).catch(() => { /* o runner reagenda erro transitório */ });
    }
  }
}

function timeTick() {
  const nowDate = new Date();
  // Retoma waits duráveis antes dos gatilhos comuns. O estado do run, inclusive
  // o nó atual, vive em runs.json; portanto não depende do processo que criou o
  // agendamento ainda estar vivo.
  for (const run of store.listRuns({ limit: 500 })) {
    if (run.status !== 'waiting' || !run.wakeAt || new Date(run.wakeAt) > nowDate) continue;
    runner.resume(run).catch(() => { /* mantém o checkpoint para a próxima tentativa */ });
  }
  for (const wf of store.listWorkflows()) {
    if (!wf.enabled) continue;
    const t = wf.trigger || {};

    if (t.type === 'cron') {
      if (!cron.isValidCron(t.cron)) continue;
      if (wf.lastTriggeredAt && cron.sameMinute(new Date(wf.lastTriggeredAt), nowDate)) continue;
      if (!cron.matchesCron(t.cron, nowDate)) continue;
      store.markTriggered(wf.id, nowDate.toISOString());
      runner.run(wf, { firedAt: nowDate.toISOString(), cron: t.cron }, { source: `cron:${t.cron}` })
        .catch(() => { /* isola o motor de tempo */ });
    } else if (t.type === 'schedule') {
      const at = t.at ? new Date(t.at) : null;
      if (!at || isNaN(at.getTime()) || at.getTime() > nowDate.getTime()) continue;
      if (wf.lastTriggeredAt) continue; // já disparou — não redispara
      store.markTriggered(wf.id, nowDate.toISOString());
      // Auto-desativa: data única já cumprida. Faz antes de rodar para que um run
      // longo (ex.: human_approval) não deixe janela para um segundo disparo.
      if (!wf.localAccess) store.updateWorkflow(wf.id, { enabled: false });
      runner.run(wf, { firedAt: nowDate.toISOString(), scheduledFor: t.at }, { source: `schedule:${t.at}` })
        .catch(() => { /* isola o motor de tempo */ })
        .finally(() => { if (wf.localAccess && store.getWorkflow(wf.id)) store.updateWorkflow(wf.id, { enabled: false }); });
    }
  }
}

function startTimeEngine() {
  if (TIME.interval) return;
  recoverDurableRuns();
  TIME.interval = setInterval(timeTick, 30000);
  timeTick();
}

startTimeEngine();

// Invalida caches derivados quando um workflow muda (subscrições + regras semânticas).
function onWorkflowsChanged() {
  rebuildSubscriptions();
  semantic.invalidateRules();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function publicWebhookUrl(req, tokenValue) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}/flows/webhook/${tokenValue}`;
}

function decorateWorkflow(wf, req) {
  const out = { ...wf };
  if (wf.trigger?.type === 'webhook' && wf.trigger.webhookToken) {
    out.webhookUrl = req ? publicWebhookUrl(req, wf.trigger.webhookToken) : `/flows/webhook/${wf.trigger.webhookToken}`;
  }
  out.published = publish.isPublished(wf);
  if (out.published) out.toolName = publish.toolNameFor(wf);
  return out;
}

// Mantém o arquivo gerado em sincronia com o workflow (re-publica se já publicado
// ou se a flag publishAsTool estiver ligada; caso contrário, remove).
function syncPublish(wf) {
  try {
    if (wf.publishAsTool) return publish.publish(wf);
    if (publish.isPublished(wf)) publish.unpublish(wf);
  } catch { /* stabilizer/IO — não quebra a rota */ }
  return null;
}

// ── Rotas: workflows (CRUD) ──────────────────────────────────────────────────────

function routerListWorkflows(req, res) {
  /** @register_router workflows @method GET */
  res.json({ success: true, workflows: store.listWorkflows().map((w) => decorateWorkflow(w, req)) });
}

function routerCreateWorkflow(req, res) {
  /** @register_router workflows @method POST */
  const wf = store.createWorkflow(req.body || {});
  syncPublish(wf);
  onWorkflowsChanged();
  res.status(201).json({ success: true, workflow: decorateWorkflow(wf, req) });
}

function routerGetWorkflow(req, res) {
  /** @register_router workflows/:id @method GET */
  const wf = store.getWorkflow(req.params.id);
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  res.json({ success: true, workflow: decorateWorkflow(wf, req) });
}

function routerUpdateWorkflow(req, res) {
  /** @register_router workflows/:id @method PUT */
  const wf = store.updateWorkflow(req.params.id, req.body || {});
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  syncPublish(wf);
  onWorkflowsChanged();
  res.json({ success: true, workflow: decorateWorkflow(wf, req) });
}

function routerToggleWorkflow(req, res) {
  /** @register_router workflows/:id/toggle @method PATCH */
  const wf = store.getWorkflow(req.params.id);
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  const updated = store.updateWorkflow(req.params.id, { enabled: !wf.enabled });
  onWorkflowsChanged();
  res.json({ success: true, workflow: decorateWorkflow(updated, req) });
}

// Duplicar: cria uma cópia independente (ids novos, desligada, sem publicar).
// Não chamamos syncPublish — a cópia nasce com publishAsTool=false de propósito,
// para não gerar uma segunda tool com o mesmo propósito sem o usuário pedir.
function routerDuplicateWorkflow(req, res) {
  /** @register_router workflows/:id/duplicate @method POST */
  const copy = store.duplicateWorkflow(req.params.id, { name: (req.body || {}).name });
  if (!copy) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  onWorkflowsChanged();
  res.status(201).json({ success: true, workflow: decorateWorkflow(copy, req) });
}

function routerDeleteWorkflow(req, res) {
  /** @register_router workflows/:id @method DELETE */
  const wf = store.getWorkflow(req.params.id);
  if (wf) { try { publish.unpublish(wf); } catch { /* ignore */ } }
  const ok = store.deleteWorkflow(req.params.id);
  if (!ok) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  onWorkflowsChanged();
  res.json({ success: true });
}

async function routerRunWorkflow(req, res) {
  /** @register_router workflows/:id/run @method POST */
  // IMPORTANTE: o framework de rotas serializa o VALOR RETORNADO do handler e
  // encerra a resposta ao fim dele. Chamar res.json() dentro de um .then() (após
  // o handler já ter retornado undefined) resultava em 200 com corpo VAZIO —
  // por isso "Testar"/tools/llm não carregavam. Handlers assíncronos devem ser
  // `async` e RETORNAR o payload (ou { status, ... } para códigos de erro).
  const wf = store.getWorkflow(req.params.id);
  if (!wf) return { status: 404, success: false, error: 'workflow não encontrado' };
  const payload = req.body || {};
  // Guarda o payload do teste no flow para o formulário voltar preenchido na
  // próxima vez (inclusive depois de um reboot).
  if (payload && typeof payload === 'object' && Object.keys(payload).length) {
    try { store.updateWorkflow(wf.id, { testPayload: payload }); } catch { /* conveniência — não quebra o run */ }
  }
  try {
    const run = await runner.run(wf, payload, { source: 'manual' });
    return { success: true, run };
  } catch (err) {
    return { status: 500, success: false, error: err.message };
  }
}

// Replay: roda de novo um run passado COM OS MESMOS PARÂMETROS. O payload que
// disparou o run original é persistido em run.input (ver graph-engine), então
// basta reexecutar o workflow atual com ele. Runs antigos (anteriores a esta
// versão) e payloads grandes demais não têm input — aí o replay não é possível.
// async + return: ver a nota em routerRunWorkflow sobre 200 com corpo vazio.
async function routerReplayRun(req, res) {
  /** @register_router runs/:id/replay @method POST */
  const prev = store.getRun(req.params.id);
  if (!prev) return { status: 404, success: false, error: 'run não encontrado' };
  if (prev.input == null) {
    return { status: 400, success: false, error: 'este run não guardou o payload de entrada — execute-o novamente pelo botão Testar para poder repetir' };
  }
  const wf = store.getWorkflow(prev.workflowId);
  if (!wf) return { status: 404, success: false, error: 'workflow do run não existe mais' };
  try {
    const run = await runner.run(wf, prev.input, { source: `replay:${prev.id}`, replayOf: prev.id });
    return { success: true, run };
  } catch (err) {
    return { status: 500, success: false, error: err.message };
  }
}

// Interface de entrada do flow: os campos que o formulário de teste deve oferecer.
// Vem de três fontes, nesta ordem de precedência por campo:
//   1. inputs[] declarados (viram parâmetros da tool publicada)
//   2. shape do gatilho ABSORVIDO pelo flow (persistido — sobrevive ao reboot)
//   3. shape observado agora pelo tap (memória; só existe se o evento já passou)
// Mais o último payload usado no teste, para o formulário voltar preenchido.
function routerWorkflowInterface(req, res) {
  /** @register_router workflows/:id/interface @method GET */
  const wf = store.getWorkflow(req.params.id);
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  const t = wf.trigger || {};
  const fields = [];
  const seen = new Set();
  const push = (f) => { if (f.path && !seen.has(f.path)) { seen.add(f.path); fields.push(f); } };

  for (const inp of wf.inputs || []) {
    push({ path: inp.name, type: inp.type || 'string', description: inp.description || '', required: !!inp.required, source: 'input' });
  }

  let shape = store.normalizeShape(t.shape);
  let shapeSource = shape ? 'absorvido' : null;
  if (t.type === 'event' && t.event) {
    const live = tap.shapeFor(t.event);
    if (live) {
      shape = store.normalizeShape(shape ? { ...shape, ...live } : live);
      shapeSource = t.shape ? 'absorvido+observado' : 'observado';
    }
  } else if (t.type === 'webhook' && !shape) {
    // Webhook tem interface fixa mesmo sem nunca ter recebido chamada.
    shape = { body: 'object', query: 'object', headers: 'object', method: 'string' };
    shapeSource = 'webhook';
  }
  for (const f of shapeUtil.fieldsFromShape(shape)) push({ ...f, source: 'trigger' });

  return res.json({
    success: true,
    triggerType: t.type || 'manual',
    event: t.event || null,
    shape: shape || null,
    shapeSource,
    fields,
    sample: shape ? shapeUtil.sampleFromShape(shape) : {},
    lastPayload: wf.testPayload || null,
  });
}

function routerListRuns(req, res) {
  /** @register_router runs @method GET */
  const { workflowId, limit } = req.query;
  const runs = store.listRuns({ workflowId, limit: limit ? parseInt(limit, 10) : 50 });
  res.json({ success: true, runs });
}

function routerGetRun(req, res) {
  /** @register_router runs/:id @method GET */
  const run = store.getRun(req.params.id);
  if (!run) { res.status(404); return res.json({ success: false, error: 'run não encontrado' }); }
  res.json({ success: true, run });
}

// ── Rotas: aprovação humana (nó human_approval) ─────────────────────────────────
// Resolve um nó human_approval pendente. O run pode estar "running" há muito
// tempo esperando por isto — ver graph-engine.js (waitForApproval/resolveApproval).

function routerApproveNode(req, res) {
  /** @register_router runs/:runId/approve/:nodeId @method POST */
  const { comment, respondedBy } = req.body || {};
  const ok = runner.resolveApproval(req.params.runId, req.params.nodeId, true, { comment, respondedBy });
  if (!ok) { res.status(404); return res.json({ success: false, error: 'nenhuma aprovação pendente para este run/nó (já resolvida, expirada, ou nunca existiu)' }); }
  res.json({ success: true });
}

function routerRejectNode(req, res) {
  /** @register_router runs/:runId/reject/:nodeId @method POST */
  const { comment, respondedBy } = req.body || {};
  const ok = runner.resolveApproval(req.params.runId, req.params.nodeId, false, { comment, respondedBy });
  if (!ok) { res.status(404); return res.json({ success: false, error: 'nenhuma aprovação pendente para este run/nó (já resolvida, expirada, ou nunca existiu)' }); }
  res.json({ success: true });
}

// ── Rotas: publish (flow → tool) ──────────────────────────────────────────────────

function routerPublishWorkflow(req, res) {
  /** @register_router workflows/:id/publish @method POST */
  const wf = store.updateWorkflow(req.params.id, { publishAsTool: true });
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  try {
    const info = publish.publish(wf);
    tools.invalidate();
    res.json({ success: true, ...info });
  } catch (err) { res.status(500); res.json({ success: false, error: err.message }); }
}

function routerUnpublishWorkflow(req, res) {
  /** @register_router workflows/:id/unpublish @method POST */
  const wf = store.updateWorkflow(req.params.id, { publishAsTool: false });
  if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  publish.unpublish(wf);
  tools.invalidate();
  res.json({ success: true });
}

// ── Rotas: templates (*.flow.json espalhados pelos pacotes) ────────────────────
//
// Qualquer pacote pode publicar flows prontos com um `*.flow.json`. As variáveis
// SOLTAS do template (nós `set` sem conexão) vêm junto na listagem: é com elas
// que a UI monta o formulário de criação.

function routerListTemplates(req, res) {
  /** @register_router templates @method GET */
  const list = templates.list({ force: req.query.force === '1' })
    .map(({ file, ...rest }) => rest); // `file` é caminho de disco — não vaza p/ o cliente
  res.json({ success: true, templates: list });
}

function routerCreateFromTemplate(req, res) {
  /** @register_router templates/create @method POST */
  const { templateId, name, values } = req.body || {};
  if (!templateId) { res.status(400); return res.json({ success: false, error: 'templateId é obrigatório' }); }

  const payload = templates.instantiate(templateId, { name, values: values || {} });
  if (!payload) { res.status(404); return res.json({ success: false, error: 'template não encontrado ou inválido' }); }

  const wf = store.createWorkflow(payload);
  onWorkflowsChanged();
  res.status(201).json({ success: true, workflow: decorateWorkflow(wf, req) });
}

// ── Rotas: descoberta (eventos + tools) ────────────────────────────────────────

// Eventos descobertos pelo tap (nome real + payload sugerido a partir do shape),
// além de sugestões estáticas úteis quando o tap ainda não observou tráfego.
function routerEventCatalog(req, res) {
  /** @register_router events @method GET */
  const discovered = tap.catalog();
  const suggestions = [
    { event: 'agent:tool-end', label: 'Agente terminou de usar uma ferramenta' },
    { event: 'agent:iteration-start', label: 'Início de iteração do agente' },
    { event: 'agent:llm-end', label: 'LLM respondeu' },
    { event: 'agent:finally', label: 'Agente finalizou' },
    { event: 'whatsapp:message:received', label: 'Mensagem do WhatsApp recebida' },
    { event: 'cnpj-scraper:completed', label: 'Raspagem de CNPJ concluída' },
    { event: 'cnpj-scraper:failed', label: 'Raspagem de CNPJ falhou' },
    { event: 'cnpj-scraper:cancelled', label: 'Raspagem de CNPJ cancelada' },
    { event: 'evolution:webhook:received', label: 'Webhook do Evolution recebido' },
    { event: 'instagram:comment.created', label: 'Novo comentário no Instagram' },
    { event: 'instagram:comment.replied', label: 'Resposta a comentário no Instagram' },
    { event: 'instagram:message.received', label: 'DM recebida no Instagram' },
    { event: 'instagram:message.reaction', label: 'Reação a DM no Instagram' },
    { event: 'instagram:story.mention', label: 'Menção em Story no Instagram' },
    { event: 'instagram:webhook.failed', label: 'Falha no webhook do Instagram' },
    { event: '*', label: 'Todos os eventos (use com cautela)' },
  ];
  res.json({ success: true, discovered, suggestions });
}

// Catálogo de tools @register_tool (com schema de parâmetros p/ o inspetor).
// async + return (ver nota em routerRunWorkflow): o padrão .then(res.json) sem
// retorno devolvia 200 vazio — era a causa de "as tools não carregam nunca".
async function routerToolCatalog(req, res) {
  /** @register_router tools @method GET */
  try {
    const catalog = await tools.catalog({ force: req.query.force === '1' });
    return { success: true, tools: catalog };
  } catch (err) {
    return { status: 500, success: false, error: err.message };
  }
}

// Opções de um @param com fonte viva (x-enumSource). Nunca falha em 500: fonte
// fora do ar devolve options:null e o inspetor cai pra campo de texto.
async function routerToolOptions(req, res) {
  /** @register_router tools/options @method GET */
  try {
    const options = await tools.resolveOptions(req.query.source, { force: req.query.force === '1' });
    return { success: true, source: req.query.source || null, options };
  } catch (err) {
    return { success: true, source: req.query.source || null, options: null, error: err.message };
  }
}

// Opções de LLM para o nó Agente: propósitos, ELMs e providers disponíveis.
async function routerLlmOptions(req, res) {
  /** @register_router llm @method GET */
  try {
    const opts = await llmOptions.options({ force: req.query.force === '1' });
    return { success: true, ...opts };
  } catch (err) {
    return { status: 500, success: false, error: err.message };
  }
}

async function routerAgentProfiles(req, res) {
  /** @register_router agent-profiles @method GET */
  try {
    const profiles = await import('../agent/runtime/index.js');
    return { success: true, profiles: await profiles.listAgentProfiles() };
  } catch (err) { return { success: true, profiles: [], unavailable: true, error: err.message }; }
}

async function routerAgentProfile(req, res) {
  /** @register_router agent-profiles/:package/:id @method GET */
  try {
    const profiles = await import('../agent/runtime/index.js');
    const profile = await profiles.getAgentProfile(req.params.package, decodeURIComponent(req.params.id));
    return profile ? { success: true, profile } : { status: 404, success: false, error: 'Perfil não encontrado' };
  } catch (err) { return { status: 500, success: false, error: err.message }; }
}

// ── Rotas: gatilho semântico ─────────────────────────────────────────────────────
//
// Uma "regra semântica" é apenas um workflow com trigger { type:'semantic', text,
// threshold }. Estas rotas são uma visão de conveniência sobre esses workflows.

function semanticView(wf, req) {
  const d = decorateWorkflow(wf, req);
  return { id: wf.id, name: wf.name, enabled: wf.enabled, text: wf.trigger?.text || '', threshold: wf.trigger?.threshold ?? 0.6, published: d.published };
}

async function routerListSemantic(req, res) {
  /** @register_router semantic @method GET */
  const rules = store.listWorkflows()
    .filter((w) => w.trigger?.type === 'semantic')
    .map((w) => semanticView(w, req));
  try {
    const health = await semantic.health();
    return { success: true, rules, health };
  } catch {
    return { success: true, rules, health: { available: false, ...embedder.status() } };
  }
}

// Cria uma nova regra (workflow com trigger semântico) ou atualiza uma existente.
function routerUpsertSemantic(req, res) {
  /** @register_router semantic @method POST */
  const { id, name, text, threshold, enabled } = req.body || {};
  if (!text || !text.trim()) { res.status(400); return res.json({ success: false, error: 'text é obrigatório' }); }
  const trigger = { type: 'semantic', text: text.trim(), threshold: Number.isFinite(threshold) ? threshold : 0.6 };
  let wf;
  if (id) {
    wf = store.updateWorkflow(id, { trigger, ...(name !== undefined ? { name } : {}), ...(enabled !== undefined ? { enabled } : {}) });
    if (!wf) { res.status(404); return res.json({ success: false, error: 'workflow não encontrado' }); }
  } else {
    wf = store.createWorkflow({ name: name || `Regra: ${text.trim().slice(0, 40)}`, trigger, enabled: enabled !== false });
  }
  onWorkflowsChanged();
  res.json({ success: true, rule: semanticView(wf, req) });
}

function routerDeleteSemantic(req, res) {
  /** @register_router semantic/:id @method DELETE */
  const wf = store.getWorkflow(req.params.id);
  if (wf) { try { publish.unpublish(wf); } catch { /* ignore */ } }
  const ok = store.deleteWorkflow(req.params.id);
  if (!ok) { res.status(404); return res.json({ success: false, error: 'regra não encontrada' }); }
  onWorkflowsChanged();
  res.json({ success: true });
}

// ── Webhook receiver ─────────────────────────────────────────────────────────────
// URL pública: /flows/webhook/:token — dispara o workflow associado ao token.

async function handleWebhook(req, res) {
  const wf = store.listWorkflows()
    .find((w) => w.trigger?.type === 'webhook' && w.trigger.webhookToken === req.params.token);
  if (!wf) return { status: 404, success: false, error: 'webhook não encontrado' };
  if (!wf.enabled) return { status: 403, success: false, error: 'workflow desabilitado' };

  const payload = { body: req.body || {}, query: req.query || {}, headers: req.headers || {}, method: req.method };
  try { if (!wf.localAccess) store.absorbTriggerShape(wf.id, payload); } catch { /* observação nunca quebra o webhook */ }
  try {
    const run = await runner.run(wf, payload, { source: 'webhook' });
    // `runStatus` (não `status`): o framework interpreta `status` no retorno como
    // código HTTP — usar o nome cru colidiria com o status do run ("ok"/"error").
    return { success: true, runId: run.id, runStatus: run.status };
  } catch (err) {
    return { status: 500, success: false, error: err.message };
  }
}

function routerWebhookPost(req, res) {
  /** @register_router webhook/:token @method POST */
  return handleWebhook(req, res);
}

function routerWebhookGet(req, res) {
  /** @register_router webhook/:token @method GET */
  return handleWebhook(req, res);
}

// ── Tools visíveis ao agente ──────────────────────────────────────────────────

function flows_list() {
  /**
   * @register_tool flows_list
   * @description Lista todos os workflows de automação do Flows, com status, tipo de gatilho e nº de nós.
   */
  const workflows = store.listWorkflows().map((w) => ({
    id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger,
    nodes: (w.nodes || []).length, published: publish.isPublished(w),
  }));
  return { success: true, workflows };
}

function flows_run({ id, input } = {}) {
  /**
   * @register_tool flows_run
   * @description Executa manualmente um workflow do Flows pelo id, opcionalmente com um payload de entrada.
   * @param {string} id - id do workflow a executar
   * @param {object?} input - payload disponível no template como {{trigger.*}}
   */
  return (async () => {
    if (!id) return { success: false, error: 'id é obrigatório' };
    const wf = store.getWorkflow(id);
    if (!wf) return { success: false, error: 'workflow não encontrado' };
    const run = await runner.run(wf, input || {}, { source: 'tool' });
    return { success: true, run };
  })();
}

function flows_replay({ runId } = {}) {
  /**
   * @register_tool flows_replay
   * @description Repete uma execução passada do Flows com exatamente o mesmo payload de entrada (debug).
   * @param {string} runId - id do run a repetir (veja em GET /flows/runs)
   */
  return (async () => {
    if (!runId) return { success: false, error: 'runId é obrigatório' };
    const prev = store.getRun(runId);
    if (!prev) return { success: false, error: 'run não encontrado' };
    if (prev.input == null) return { success: false, error: 'run sem payload de entrada guardado — não é replayável' };
    const wf = store.getWorkflow(prev.workflowId);
    if (!wf) return { success: false, error: 'workflow do run não existe mais' };
    const run = await runner.run(wf, prev.input, { source: `replay:${prev.id}`, replayOf: prev.id });
    return { success: true, run };
  })();
}

module.exports = {
  // rotas — workflows
  routerListWorkflows,
  routerCreateWorkflow,
  routerGetWorkflow,
  routerUpdateWorkflow,
  routerToggleWorkflow,
  routerDuplicateWorkflow,
  routerDeleteWorkflow,
  routerRunWorkflow,
  routerReplayRun,
  routerWorkflowInterface,
  routerListRuns,
  routerGetRun,
  routerApproveNode,
  routerRejectNode,
  // rotas — publish
  routerPublishWorkflow,
  routerUnpublishWorkflow,
  // rotas — templates
  routerListTemplates,
  routerCreateFromTemplate,
  // rotas — descoberta
  routerEventCatalog,
  routerToolCatalog,
  routerToolOptions,
  routerLlmOptions,
  routerAgentProfiles,
  routerAgentProfile,
  // rotas — semântico
  routerListSemantic,
  routerUpsertSemantic,
  routerDeleteSemantic,
  // rotas — webhook
  routerWebhookPost,
  routerWebhookGet,
  // tools
  flows_list,
  flows_run,
  flows_replay,
  // internos (testes)
  rebuildSubscriptions,
  onWorkflowsChanged,
};
