<script>
  import AuthorizationDialog from "./AuthorizationDialog.svelte";
  import { onMount, onDestroy, tick } from "svelte";
  import { channel, context, openWorkspace } from "./workspace-flow.js";
  import { changesBetween, applyChanges, saveQueue } from "./workspace-state.js";
  export let documentRole = null;
  import CronBuilder from "./CronBuilder.svelte";

  const BASE = "/flows";
  const NODE_W = 200;
  const HEAD_H = 38;

  // ── Estado do workflow ────────────────────────────────────────────────────
  let wf = null;            // workflow em edição
  let loading = true;
  let toolCatalog = [];     // [{package,name,description,params[]}]
  let toolsLoading = false; // carregamento do catálogo de tools (assíncrono, pode falhar)
  let toolsError = null;    // mensagem quando a descoberta de tools falha
  let eventCatalog = [];    // [{event,count,suggestedPayload}]
  let eventSuggestions = [];
  let showVars = false;     // painel "Variáveis disponíveis" no inspetor
  let llmOpts = { accesses: [], elms: [], providers: [], models: [] }; // opções do nó Agente
  let agentProfiles = [];
  let workflowList = [];    // outros workflows (para o nó Sub-flow)
  let fromId = null;        // ?from=<id> — voltar ao flow principal ao editar um sub-flow

  // ── Canvas ────────────────────────────────────────────────────────────────
  let pan = { x: 40, y: 40 };
  let zoom = 1;
  let canvasEl;
  let selectedNodeId = null;
  let connecting = null;    // { from, fromPort, x, y } (x,y em coords de mundo)
  let linkFrom = null;      // modo "tocar p/ ligar": { from, fromPort } aguardando destino
  let cursor = { x: 0, y: 0 };

  // ── UI ──────────────────────────────────────────────────────────────────
  let paletteQuery = "";
  let toast = null, toastTimer;
  // Mobile: paleta e inspetor viram bottom-sheets acionáveis (null | 'palette' | 'inspector').
  // No desktop este estado é inerte — os painéis são células fixas do grid.
  let mobilePanel = null;

  // Definições dos nós core (o inspetor renderiza os campos por tipo).
  // `cat` agrupa na paleta: gatilho · ação · fluxo (controle) · integração.
  const CORE_NODES = [
    { type: "trigger", label: "Trigger", cat: "trigger", icon: "M13 2 3 14h9l-1 8 10-12h-9l1-8z", ports: ["out"] },
    { type: "log", label: "Log", cat: "action", icon: "M4 6h16M4 12h16M4 18h10", ports: ["out"] },
    { type: "set", label: "Set variable", cat: "action", icon: "M4 7h16M4 12h10M4 17h7", ports: ["out"] },
    { type: "agent", label: "Agent (LLM)", cat: "action", icon: "M12 2a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5zM5 21h14", ports: ["out"] },
    { type: "classifier", label: "Classificador (Jev/Laya)", cat: "action", icon: "M4 5h16M4 12h10M4 19h16M17 9l3 3-3 3", ports: ["out"] },
    { type: "script", label: "Script", cat: "action", icon: "M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14", ports: ["out"] },
    { type: "rules", label: "Rules", cat: "flow", icon: "M4 6h10M4 12h16M4 18h8M17 3l3 3-3 3", ports: ["matched", "unmatched"] },
    { type: "session-message", label: "Session message", cat: "action", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", ports: ["out"] },
    { type: "emit", label: "Emit event", cat: "action", icon: "M13 2 3 14h9l-1 8 10-12h-9l1-8z", ports: ["out"] },
    { type: "condition", label: "Condition", cat: "flow", icon: "M6 3v12a3 3 0 0 0 3 3h6M18 21v-6", ports: ["true", "false"] },
    { type: "switch", label: "Switch", cat: "flow", icon: "M4 7h11l-3-3m3 3l-3 3M20 17H9l3-3m-3 3l3 3", ports: ["default"] },
    { type: "iterate", label: "Iterate", cat: "flow", icon: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4m14 3v1a4 4 0 0 1-4 4H3", ports: ["out"] },
    { type: "merge", label: "Merge", cat: "flow", icon: "M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 21V3", ports: ["out"] },
    { type: "delay", label: "Delay", cat: "flow", icon: "M12 6v6l4 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", ports: ["out"] },
    { type: "http", label: "HTTP", cat: "integration", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20", ports: ["out"] },
    { type: "sub-flow", label: "Sub-flow", cat: "integration", icon: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4v7", ports: ["out"] },
  ];
  // Rótulos e ordem das categorias na paleta.
  const NODE_CATS = [
    { key: "trigger", label: "Trigger" },
    { key: "action", label: "Actions" },
    { key: "flow", label: "Flow" },
    { key: "integration", label: "Integration" },
  ];
  const CONDITION_OPS = ["==", "!=", ">", "<", ">=", "<=", "contains", "truthy", "empty"];
  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  function nodeDef(type) { return CORE_NODES.find((n) => n.type === type) || (type === "agent-tool" ? { type, label: "Tool Binding", icon: "M8 12h8M12 8v8", ports: [] } : { type, label: type, icon: "M4 6h16M4 12h16M4 18h10", ports: ["out"] }); }

  // Nós que podem falhar e por isso ganham uma saída "error" (ramo on-error).
  const FAILABLE = new Set(["http", "tool", "agent", "classifier", "script", "rules", "sub-flow", "session-message", "iterate"]);
  // Portas de saída de uma INSTÂNCIA de nó (dinâmicas): switch deriva das cases;
  // nós falíveis ganham a porta "error" para o ramo de tratamento.
  function nodePorts(n) {
    if (n.type === "agent-tool") return [];
    if (n.type === "switch") {
      const cases = Array.isArray(n.config?.cases) ? n.config.cases.map((c) => String(c).trim()).filter(Boolean) : [];
      return [...cases, "default"];
    }
    if (n.type === "rules") {
      const routes = Array.isArray(n.config?.rules) ? n.config.rules.map((r) => String(r?.route || "").trim()).filter(Boolean) : [];
      return [...new Set(["matched", "unmatched", ...routes, "error"])];
    }
    const base = n.type === "agent" ? ["out", "tools"] : nodeDef(n.type).ports.slice();
    if (FAILABLE.has(n.type) && !base.includes("error")) base.push("error");
    return base;
  }

  let theme = "dark";
  let compactWorkspace = false;
  let directCanvasWorkspace = false;
  let workspaceWidgetRole = null;
  let workspaceChannel = null;
  let workspaceSyncTimer = null;
  let documentBus = null, documentContext = null, observed = null, alive = true;
  let framedNodeCount = 0;
  $: if (documentBus && workspaceWidgetRole === "canvas" && wf && wf.nodes.length !== framedNodeCount) { framedNodeCount = wf.nodes.length; tick().then(fitView); }
  let saveError = '', dirty = false;
  const pendingSaves = new Map();
  const pendingChanges = new Map();
  const writeSnapshot = saveQueue(async (snapshot) => {
    const response = await fetch(BASE + '/workflows/' + encodeURIComponent(snapshot.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao salvar');
    return result;
  });
  function snapshotFlow() { return JSON.parse(JSON.stringify({ id: wf.id, ...serialize() })); }
  function publishDocument(extra = {}) {
    if (documentBus && workspaceWidgetRole === 'canvas' && wf) documentBus.state({ flow: snapshotFlow(), selectedId: selectedNodeId, saving, dirty, camera: { x: pan.x, y: pan.y, zoom }, error: saveError, ...extra });
  }
  function observeDocument() {
    if (!documentBus || !wf || loading) return;
    const snapshot = snapshotFlow();
    if (!observed) { observed = snapshot; return; }
    const changes = changesBetween(observed, snapshot);
    observed = snapshot;
    if (changes.length) {
      dirty = true;
      if (workspaceWidgetRole === 'canvas') { publishDocument(); scheduleWorkspaceSave(); }
      else { const operationId = uid('patch'); pendingChanges.set(operationId, changes); documentBus.event('flow.patch', { changes, operationId, selectedId: selectedNodeId }); }
    }
  }
  $: if (wf && selectedNode) { wf; selectedNode; observeDocument(); }
  $: if (wf) { wf; observeDocument(); }
  $: if (documentBus && workspaceWidgetRole === 'canvas') { selectedNodeId; pan; zoom; publishDocument(); }
  async function receiveDocument(message) {
    if (!alive) return;
    if (workspaceWidgetRole === 'canvas') {
      if (message.kind === 'ready' || (message.kind === 'request' && message.request?.type === 'state')) publishDocument();
      if (message.kind === 'event' && message.event?.type === 'flow.patch' && wf) {
        wf = normalize(applyChanges(snapshotFlow(), message.event.detail.changes || []));
        selectedNodeId = message.event.detail.selectedId ?? selectedNodeId;
        observeDocument(); publishDocument({ appliedOperation: message.event.detail.operationId });
      }
      if (message.kind === 'request' && message.request?.type === 'authorization') await openAuthorization();
      if (message.kind === 'request' && message.request?.type === 'test') await openTest();
      if (message.kind === 'request' && message.request?.type === 'runs') { showRun = !showRun; if (showRun) loadRuns({ select: true }); }
      if (message.kind === 'request' && message.request?.type === 'save') {
        const ok = await save({ silent: true }); publishDocument({ acknowledgement: { id: message.request.detail.id, ok } });
      }
      if (message.kind === 'request' && message.request?.type === 'camera') {
        const action = message.request.detail || {};
        if (action.action === 'fit') fitView();
        else if (canvasEl) { const r = canvasEl.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, action.action === 'reset' ? 1 / zoom : action.factor || 1); }
      }
      if (message.kind === 'event' && message.event?.type === 'selection') { selectedNodeId = message.event.detail.nodeId; publishDocument(); }
    } else if (message.kind === 'state' && message.state?.flow) {
      const local = wf && observed ? changesBetween(observed, snapshotFlow()) : [];
      pendingChanges.delete(message.state.appliedOperation);
      wf = normalize(applyChanges(message.state.flow, [...pendingChanges.values()].flat().concat(local)));
      observed = snapshotFlow();
      if (!pendingChanges.size) selectedNodeId = message.state.selectedId;
      loading = false; saving = message.state.saving; dirty = message.state.dirty; saveError = message.state.error || '';
      const ack = message.state.acknowledgement;
      if (ack && pendingSaves.has(ack.id)) { pendingSaves.get(ack.id)(ack.ok); pendingSaves.delete(ack.id); }
    }
  }
  onMount(() => {
    const syncTheme = () => { theme = localStorage.getItem("agent:theme") === "light" ? "light" : "dark"; };
    syncTheme();
    const params = new URLSearchParams(location.search);
    const workspaceMode = params.get("singleWorkspace");
    workspaceWidgetRole = documentRole || params.get("widgetRole");
    documentContext = context();
    if (documentContext.documentId) { documentBus = channel(documentContext, receiveDocument); documentBus.ready(); documentBus.request("state"); }
    compactWorkspace = workspaceMode === "compact" || workspaceMode === "canvas";
    directCanvasWorkspace = workspaceMode === "canvas" || !!workspaceWidgetRole;
    const workspaceId = params.get("workspaceId");
    if (!documentBus && workspaceId && workspaceWidgetRole && typeof BroadcastChannel !== "undefined") {
      workspaceChannel = new BroadcastChannel(`thinkiac:flows:${workspaceId}:${params.get("id") || "new"}`);
      workspaceChannel.onmessage = (event) => {
        if (event.data?.type === "selected") selectedNodeId = event.data.nodeId || null;
        if (event.data?.type === "reload" && event.data.source !== workspaceWidgetRole) boot();
      };
    }
    window.addEventListener("storage", syncTheme);
    if (!documentBus || workspaceWidgetRole === 'canvas') boot();
    else { loadTools(); loadAgentProfiles(); loadLlmOptions(); loadWorkflowList(); loadPkgIcons(); }
    const resize = () => { if (workspaceWidgetRole === 'canvas') fitView(); };
    window.addEventListener('resize', resize);
    return () => { alive = false; documentBus?.close(); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); clearTimeout(toastTimer); for (const resolve of pendingSaves.values()) resolve(false); pendingSaves.clear(); window.removeEventListener("storage", syncTheme); workspaceChannel?.close(); if (workspaceSyncTimer) clearTimeout(workspaceSyncTimer); };
  });
  onDestroy(() => { if (replayTimer) clearInterval(replayTimer); });

  let triggerHelp = false; // popover de ajuda do gatilho (botão "i")
  let triggerExpanded = true;
  const TRIGGER_HELP = {
    event: "Listens for a bus event pattern (for example agent:tool-end, agent:*, or *). The trigger payload is available as {{trigger.*}}.",
    webhook: "Creates a public URL. A POST or GET triggers this flow; body and query are available as {{trigger.body}} and {{trigger.query}}. The URL appears after saving.",
    cron: "Runs on a recurring schedule. Set the frequency above; the scheduler checks every 30 seconds. For example, every day at 09:00.",
    schedule: "Runs once at the chosen date and time, then automatically disables the flow.",
    manual: "Does not run automatically. Use Test, POST /flows/workflows/:id/run, or the flows_run tool.",
    semantic: "Matches events by meaning (embeddings), not only by their exact name. Describe the situation, then set how similar it must be.",
  };

  function setTrigger(type) {
    if (wf.trigger.type === type) {
      triggerExpanded = !triggerExpanded;
      return;
    }
    const t = { type };
    if (type === "event") t.event = wf.trigger.event || "";
    if (type === "semantic") { t.text = wf.trigger.text || ""; t.threshold = wf.trigger.threshold ?? 0.6; }
    if (type === "webhook") t.webhookToken = wf.trigger.webhookToken || "";
    if (type === "cron") t.cron = wf.trigger.cron || "0 9 * * *";
    if (type === "schedule") t.at = wf.trigger.at || defaultScheduleAt();
    wf.trigger = t;
    triggerExpanded = true;
  }

  // Data única default: amanhã 09:00 local, no formato do <input type=datetime-local>.
  function defaultScheduleAt() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  // Converte ISO/Date -> "YYYY-MM-DDTHH:mm" (valor do datetime-local, sem fuso).
  function toLocalInput(v) {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // O <input datetime-local> devolve "YYYY-MM-DDTHH:mm" (hora local). Guardamos
  // como ISO com fuso para o motor de tempo comparar sem ambiguidade.
  function onScheduleInput(e) {
    const v = e.target.value;
    wf.trigger.at = v ? new Date(v).toISOString() : "";
  }
  $: scheduleLocalValue = wf?.trigger?.type === "schedule" ? toLocalInput(wf.trigger.at) : "";
  $: schedulePast = wf?.trigger?.type === "schedule" && wf.trigger.at && new Date(wf.trigger.at).getTime() < Date.now();

  async function loadTools(force = false) {
    toolsLoading = true;
    toolsError = null;
    // Timeout no cliente: se a rota pendurar (descoberta travada no runtime),
    // recupera para o estado de erro com "tentar de novo" + o fallback manual,
    // em vez de girar "Carregando…" para sempre.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(BASE + "/tools" + (force ? "?force=1" : ""), { signal: ctrl.signal });
      const raw = await r.text();
      let tc;
      try { tc = JSON.parse(raw); }
      catch { throw new Error(`resposta inválida (HTTP ${r.status}): ${raw.slice(0, 120)}`); }
      if (!r.ok || tc.success === false) throw new Error(tc.error || `HTTP ${r.status}`);
      toolCatalog = tc.tools || [];
      if (!toolCatalog.length) toolsError = "No tools were found in the runtime.";
    } catch (e) {
      toolCatalog = [];
      toolsError = e.name === "AbortError"
        ? "The runtime took too long to respond. Try again or add a tool by name below."
        : (e.message || "Failed to load tools");
    } finally {
      clearTimeout(timer);
      toolsLoading = false;
    }
  }
  async function loadAgentProfiles() {
    try {
      const result = await fetch(BASE + "/agent-profiles").then((r) => r.json());
      agentProfiles = result.success ? (result.profiles || []) : [];
    } catch { agentProfiles = []; }
  }

  async function loadLlmOptions() {
    try {
      const o = await fetch(BASE + "/llm").then((r) => r.json());
      if (o && o.success !== false) llmOpts = { accesses: o.accesses || [], elms: o.elms || [], providers: o.providers || [], models: o.models || [] };
    } catch { /* mantém defaults vazios */ }
  }

  async function loadWorkflowList() {
    try {
      const o = await fetch(BASE + "/workflows").then((r) => r.json());
      workflowList = (o.workflows || []);
    } catch { /* opcional */ }
  }

  // Ícones dos pacotes (para a paleta de tools). Vêm do registro de apps do
  // Agent como data-URL; nem todo pacote tem — o resto usa um avatar de letra.
  let pkgIcons = {};
  async function loadPkgIcons() {
    try {
      const j = await fetch("/aura-system/apps/list").then((r) => r.json());
      const apps = Array.isArray(j) ? j : (j.data || j.apps || []);
      const m = {};
      for (const a of apps) { if (a && a.packageName && a.icon && !m[a.packageName]) m[a.packageName] = a.icon; }
      pkgIcons = m;
    } catch { /* ícones são opcionais */ }
  }

  // Sanfona da paleta de tools: por padrão os pacotes vêm recolhidos; abre sob
  // demanda. Durante uma busca, tudo abre para não esconder resultados.
  let expandedPkgs = {};
  function togglePkg(pkg) { expandedPkgs = { ...expandedPkgs, [pkg]: !expandedPkgs[pkg] }; }

  // Arrastar um nó/tool da paleta e soltar no canvas na posição do cursor.
  let dragPayload = null;
  function onPaletteDrag(e, payload) {
    dragPayload = payload;
    try { e.dataTransfer.setData("application/json", JSON.stringify(payload)); e.dataTransfer.effectAllowed = "copy"; } catch { /* alguns browsers restringem dataTransfer */ }
  }
  function onCanvasDrop(e) {
    e.preventDefault();
    let p = dragPayload;
    try { const d = e.dataTransfer.getData("application/json"); if (d) p = JSON.parse(d); } catch { /* usa o fallback em memória */ }
    if (!p) return;
    const w = screenToWorld(e.clientX, e.clientY);
    const pos = { x: w.x - NODE_W / 2, y: w.y - 40 };
    if (p.kind === "tool" && p.tool) addToolNode(p.tool, pos);
    else if (p.type) addNode(p.type, pos);
    dragPayload = null;
    mobilePanel = null;
  }

  async function boot() {
    loading = true;
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    fromId = params.get("from") || null;
    try {
      // Tools carregam em paralelo mas com estado próprio (loading/erro/retry):
      // a descoberta varre todos os packages e pode demorar/falhar — nunca deve
      // deixar a paleta silenciosamente vazia.
      loadTools();
      loadAgentProfiles();
      loadLlmOptions();
      loadWorkflowList();
      loadPkgIcons();
      const ec = await fetch(BASE + "/events").then((r) => r.json()).catch(() => ({ discovered: [], suggestions: [] }));
      // O tap contém apenas eventos que já passaram pelo runtime. As sugestões
      // são o catálogo de integrações conhecidas e não podem sumir quando o
      // primeiro evento é observado, ou gatilhos como os do Instagram deixam
      // de aparecer no seletor.
      eventCatalog = [...(ec.discovered || []), ...(ec.suggestions || [])]
        .filter((entry, index, entries) => entry?.event && entries.findIndex((candidate) => candidate?.event === entry.event) === index);
      eventSuggestions = ec.suggestions || [];

      if (id) {
        const res = await fetch(BASE + "/workflows/" + id).then((r) => r.json());
        if (!res.workflow) throw new Error(res.error || "Fluxo não encontrado");
        if (!alive) return;
        wf = normalize(res.workflow);
      } else {
        const res = await fetch(BASE + "/workflows", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Untitled workflow" }),
        }).then((r) => r.json());
        wf = normalize(res.workflow); // normalize já semeia o nó de gatilho
        history.replaceState(null, "", "?id=" + wf.id);
      }
      // Execuções passadas ficam disponíveis já na abertura: o log não depende
      // mais de ter clicado em Testar nesta sessão.
      loadRuns({ select: true });
    } catch (e) {
      showToast("Failed to load editor", "error");
    }
    loading = false;
    if (wf) { observed = snapshotFlow(); publishDocument(); }
    // On phones the canvas is created only after the workflow request resolves.
    // Wait for that DOM update, then frame every node instead of leaving the
    // saved desktop coordinates outside the smaller viewport.
    await tick();
    if (documentBus || window.matchMedia("(max-width: 900px)").matches) {
      requestAnimationFrame(() => requestAnimationFrame(fitView));
    }
  }

  function normalize(w) {
    w = w || {};
    w.nodes = (w.nodes || []).map((n) => ({ ...n, config: n.config || {}, position: n.position || { x: 80, y: 80 } }));
    w.edges = w.edges || [];
    w.inputs = w.inputs || [];
    w.executionMode = w.executionMode === "durable" ? "durable" : "best-effort";
    w.trigger = w.trigger || { type: "manual" };
    // O gatilho é o ponto de entrada obrigatório: todo flow começa nele. Se um
    // flow (novo ou legado) não tiver um nó de gatilho, semeia um. É único e
    // permanente — não aparece na paleta e não pode ser removido (ver removeNode).
    if (!w.nodes.some((n) => n.type === "trigger")) {
      w.nodes = [{ id: uid("nd"), type: "trigger", name: "Trigger", config: {}, position: { x: 60, y: 120 } }, ...w.nodes];
    }
    for (const n of w.nodes) hydrate(n);
    materializeLegacyBindings(w);
    return w;
  }

  function showToast(message, type = "success") {
    toast = { message, type };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2400);
  }

  // ── JSON raw <-> config (para textareas) ──────────────────────────────────
  function hydrate(n) {
    if (n.type === "http") {
      n._headersRaw = n.config.headers ? JSON.stringify(n.config.headers, null, 2) : "";
      n._bodyRaw = typeof n.config.body === "object" ? JSON.stringify(n.config.body, null, 2) : (n.config.body || "");
    }
    if (n.type === "emit") n._payloadRaw = n.config.payload ? JSON.stringify(n.config.payload, null, 2) : "";
    if (n.type === "rules") n._rulesRaw = JSON.stringify(n.config.rules || [], null, 2);
    if (n.type === "classifier") n._candidatesRaw = JSON.stringify(n.config.candidates || [], null, 2);
    if (n.type === "tool") n._argsRaw = (n.config.args && Object.keys(n.config.args).length) ? JSON.stringify(n.config.args, null, 2) : "";
    if (n.type === "agent") {
      // "prompt" é o nome legado de "goal" (era um call_llm de tiro único).
      // Migra na carga para o modelo agent:run sem quebrar workflows salvos.
      if (!n.config.goal && n.config.prompt) { n.config.goal = n.config.prompt; delete n.config.prompt; }
      // toolNames é sempre um array no editor (o catálogo trabalha com nomes
      // marcados). Flows antigos podem ter salvo uma string — normaliza aqui.
      if (typeof n.config.toolNames === "string") {
        const parsed = n.config.toolNames.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        if (parsed.length) n.config.toolNames = parsed; else delete n.config.toolNames;
      }
      n._toolNamesRaw = Array.isArray(n.config.toolNames) ? n.config.toolNames.join(", ") : "";
      n._outputSchemaRaw = n.config.outputSchema && typeof n.config.outputSchema === "object"
        ? JSON.stringify(n.config.outputSchema, null, 2) : "";
    }
  }
  function parseJsonSafe(t, fb) { if (!t || !t.trim()) return fb; try { return JSON.parse(t); } catch { return t; } }

  function serialize() {
    return {
      name: wf.name, description: wf.description, enabled: wf.enabled, trigger: wf.trigger,
      executionMode: wf.executionMode === "durable" ? "durable" : "best-effort",
      autoApprovePermissions: wf.autoApprovePermissions === true,
      inputs: wf.inputs, publishAsTool: !!wf.publishAsTool,
      nodes: wf.nodes.map((n) => {
        const config = { ...n.config };
        if (n.type === "http") { config.headers = parseJsonSafe(n._headersRaw, {}); config.body = parseJsonSafe(n._bodyRaw, n._bodyRaw || undefined); }
        if (n.type === "emit") config.payload = parseJsonSafe(n._payloadRaw, {});
        if (n.type === "rules") config.rules = parseJsonSafe(n._rulesRaw, []);
        if (n.type === "classifier") {
          const candidates = parseJsonSafe(n._candidatesRaw, []);
          config.candidates = Array.isArray(candidates) ? candidates : [];
          const confidence = Number(n.config.minConfidence);
          if (Number.isFinite(confidence)) config.minConfidence = confidence; else delete config.minConfidence;
        }
        // Tool sem schema (catálogo indisponível): args editados como JSON cru
        // vencem; vazio mantém os args montados campo-a-campo (setArg).
        if (n.type === "tool" && n._argsRaw && n._argsRaw.trim()) { const a = parseJsonSafe(n._argsRaw, null); if (a && typeof a === "object") config.args = a; }
        if (n.type === "agent") {
          delete config.prompt; // sempre persiste como "goal" (agent:run)
          const tools = (n._toolNamesRaw || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
          if (tools.length) config.toolNames = tools; else delete config.toolNames;
          const ms = Number(n.config.maxSteps);
          if (ms > 0) config.maxSteps = ms; else delete config.maxSteps;
          const schema = parseJsonSafe(n._outputSchemaRaw, null);
          if (schema && typeof schema === "object") config.outputSchema = schema; else delete config.outputSchema;
        }
        return { id: n.id, type: n.type, name: n.name, config, position: n.position, ...(n.ownerAgentId ? { ownerAgentId: n.ownerAgentId } : {}) };
      }),
      edges: wf.edges.map((e) => ({ id: e.id, from: e.from, fromPort: e.fromPort || "out", to: e.to, ...(e.toPort ? { toPort: e.toPort } : {}), ...(e.kind ? { kind: e.kind } : {}) })),
    };
  }

  // ── Nós ────────────────────────────────────────────────────────────────────
  function uid(p) { return p + "_" + Math.random().toString(36).slice(2, 10); }

  function centerWorld() {
    const r = canvasEl?.getBoundingClientRect();
    if (!r) return { x: 120, y: 120 };
    return { x: (r.width / 2 - pan.x) / zoom - NODE_W / 2, y: (r.height / 2 - pan.y) / zoom - 40 };
  }

  // Nós criados pela paleta devem nascer na cena que a pessoa está vendo. A
  // busca começa no centro visível e abre uma pequena grade até achar espaço.
  // Isso evita que a seleção atual, se estiver fora da tela, empurre o novo nó
  // para fora do canvas.
  function nearNodesPos() {
    const nodes = wf?.nodes || [];
    const NODE_H = 78;
    const center = centerWorld();
    const r = canvasEl?.getBoundingClientRect();
    if (!r) return center;
    const padding = 18;
    const minX = (-pan.x + padding) / zoom;
    const maxX = (r.width - pan.x - NODE_W - padding) / zoom;
    const minY = (-pan.y + padding) / zoom;
    const maxY = (r.height - pan.y - NODE_H - padding) / zoom;
    const collides = (px, py) => nodes.some((n) => Math.abs(n.position.x - px) < NODE_W && Math.abs(n.position.y - py) < NODE_H);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    for (let ring = 0; ring < 12; ring += 1) {
      for (let row = -ring; row <= ring; row += 1) {
        for (let col = -ring; col <= ring; col += 1) {
          if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
          const x = clamp(center.x + col * (NODE_W + 28), minX, maxX);
          const y = clamp(center.y + row * (NODE_H + 28), minY, maxY);
          if (!collides(x, y)) return { x, y };
        }
      }
    }
    return { x: clamp(center.x, minX, maxX), y: clamp(center.y, minY, maxY) };
  }

  function addNode(type, pos, extra = {}) {
    const def = nodeDef(type);
    const node = {
      id: uid("nd"), type, name: extra.name || def.label,
      config: extra.config || {}, position: pos || nearNodesPos(),
    };
    // Nós agente novos começam em "chamada simples" (sem tools) — mais previsível
    // e evita respostas vazias do loop de tool-calling. Nós salvos sem `mode`
    // continuam no modo agente (retrocompatível — ver graph-engine).
    if (type === "agent" && !node.config.mode) node.config.mode = "simple";
    if (type === "script" && !node.config.code) node.config = { timeoutMs: 1000, code: "return input;", ...node.config };
    if (type === "rules" && !Array.isArray(node.config.rules)) node.config = { record: "{{trigger}}", rules: [], ...node.config };
    hydrate(node);
    wf.nodes = [...wf.nodes, node];
    selectedNodeId = node.id;
    syncWorkspace("selected");
    scheduleWorkspaceSave();
  }

  // Adiciona um nó tool digitando o nome (fallback quando o catálogo não carrega).
  // Aceita "pacote:tool" ou só "tool".
  let manualTool = "";
  function addManualTool() {
    const raw = (manualTool || "").trim();
    if (!raw) return;
    let pkg = null, name = raw;
    if (raw.includes(":")) { const i = raw.indexOf(":"); pkg = raw.slice(0, i).trim() || null; name = raw.slice(i + 1).trim(); }
    if (!name) return;
    addNode("tool", null, { name, config: { package: pkg, name, args: {} } });
    manualTool = "";
    mobilePanel = null;
  }

  function addToolNode(tool, pos = null) {
    addNode("tool", pos, {
      name: tool.name,
      config: { package: tool.package, name: tool.name, args: {} },
    });
  }
  function removeNode(id) {
    const n = wf.nodes.find((x) => x.id === id);
    // O gatilho é o ponto de entrada do flow — único e permanente. Tudo começa
    // nele, então não pode ser removido (nem adicionado outro — ver paleta).
    if (n && n.type === "trigger") { showToast("The trigger starts the flow and cannot be removed", "error"); return; }
    if (n?.type === "agent-tool" && n.ownerAgentId) {
      const owner = wf.nodes.find((candidate) => candidate.id === n.ownerAgentId);
      if (owner) {
        const names = agentTools(owner).filter((name) => name !== n.config.toolName);
        if (names.length) owner.config.toolNames = names; else delete owner.config.toolNames;
        owner._toolNamesRaw = names.join(", ");
      }
    }
    const removedIds = new Set([id]);
    if (n?.type === "agent") for (const binding of wf.nodes.filter((candidate) => candidate.type === "agent-tool" && candidate.ownerAgentId === id)) removedIds.add(binding.id);
    wf.nodes = wf.nodes.filter((x) => !removedIds.has(x.id));
    wf.edges = wf.edges.filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to));
    if (selectedNodeId === id) selectedNodeId = null;
    scheduleWorkspaceSave();
  }

  function syncWorkspace(type = "reload") { if (documentBus) { if (workspaceWidgetRole === 'canvas') publishDocument(); else if (type === 'selected') documentBus.event('selection', { nodeId: selectedNodeId }); return; } workspaceChannel?.postMessage({ type, nodeId: selectedNodeId, source: workspaceWidgetRole }); }
  function scheduleWorkspaceSave() {
    if (!workspaceWidgetRole) return;
    clearTimeout(workspaceSyncTimer);
    workspaceSyncTimer = setTimeout(async () => { if (await save({ silent: true })) syncWorkspace(); }, 180);
  }

  $: selectedNode = wf ? wf.nodes.find((n) => n.id === selectedNodeId) : null;
  $: selectedTool = selectedNode && selectedNode.type === "tool"
    ? toolCatalog.find((t) => t.name === selectedNode.config.name && (!selectedNode.config.package || t.package === selectedNode.config.package))
    : null;
  $: selectedBindingTool = selectedNode && selectedNode.type === "agent-tool" ? toolCatalog.find((t) => t.name === selectedNode.config.toolName && (!selectedNode.config.package || t.package === selectedNode.config.package)) : null;
  function setBindingMode(node, key, mode) { node.config.argModes = { ...(node.config.argModes || {}), [key]: mode }; wf.nodes = wf.nodes; }
  function setBindingArg(node, key, value) { node.config.args = { ...(node.config.args || {}), [key]: value }; setBindingMode(node, key, "fixed"); }

  // Nó agente: modo (simples/agente) e roteamento (auto/propósito/modelo).
  $: agentMode = selectedNode && selectedNode.type === "agent" ? (selectedNode.config.mode || "agent") : "agent";
  $: agentRoute = selectedNode && selectedNode.type === "agent"
    ? (selectedNode.config.routeBy || (selectedNode.config.model ? "model" : "auto"))
    : "auto";
  function setAgentMode(node, m) { node.config.mode = m; wf.nodes = wf.nodes; }

  /* ── Catálogo de tools do nó agente ───────────────────────────────────────
   * Antes era um campo de texto com nomes separados por vírgula: ninguém sabia
   * quais nomes existem. Agora as tools são ESCOLHIDAS num catálogo buscável,
   * agrupado por pacote (o mesmo `toolCatalog` da paleta).
   *
   * Lista vazia é uma escolha válida e o padrão: em tempo de execução o
   * classificador da Agent lê o objetivo e seleciona as tools relevantes
   * (ver lib/runner.js → classifyTools e graph-engine, nó agent).
   */
  let toolPickOpen = false;
  let toolPickQuery = "";

  function agentTools(node) {
    return Array.isArray(node?.config?.toolNames) ? node.config.toolNames : [];
  }
  function setAgentTools(node, names) {
    const uniq = [...new Set(names.filter(Boolean))];
    if (uniq.length) node.config.toolNames = uniq;
    else delete node.config.toolNames;
    node._toolNamesRaw = uniq.join(", ");  // compat: serialize() ainda lê o raw
    syncAgentBindings(node, uniq);
    wf.nodes = wf.nodes;
  }
  function schemaForTool(tool) {
    const properties = {};
    for (const p of tool?.params || []) properties[p.key] = { type: p.schemaType || "string", description: p.description, ...(p.enum ? { enum: p.enum } : {}) };
    return { type: "object", properties, required: (tool?.params || []).filter((p) => p.required).map((p) => p.key) };
  }
  function syncAgentBindings(agent, names) {
    if (!wf) return;
    const current = wf.nodes.filter((n) => n.type === "agent-tool" && n.ownerAgentId === agent.id);
    const keep = new Set(names);
    for (const binding of current) if (!keep.has(binding.config.toolName)) removeNode(binding.id);
    names.forEach((name, index) => {
      if (current.some((n) => n.config.toolName === name)) return;
      const meta = toolCatalog.find((t) => t.name === name);
      const id = uid("bind");
      wf.nodes = [...wf.nodes, { id, type: "agent-tool", name, ownerAgentId: agent.id, config: { toolName: name, package: meta?.package || null, schemaSnapshot: schemaForTool(meta), args: {}, argModes: {} }, position: { x: agent.position.x + NODE_W + 80, y: agent.position.y + index * 110 } }];
      wf.edges = [...wf.edges, { id: uid("eg"), from: agent.id, fromPort: "tools", to: id, toPort: "capability", kind: "agent-tool" }];
    });
  }
  function materializeLegacyBindings(document) {
    wf = document;
    for (const agent of document.nodes.filter((n) => n.type === "agent")) {
      const names = Array.isArray(agent.config.toolNames) ? agent.config.toolNames : [];
      const linked = document.nodes.some((n) => n.type === "agent-tool" && n.ownerAgentId === agent.id);
      if (names.length && !linked) syncAgentBindings(agent, names);
    }
  }
  function applyAgentProfile(agent, profile) {
    if (!profile) return;
    if (profile.system != null) agent.config.system = profile.system;
    if (profile.model) agent.config.model = profile.model;
    if (profile.fallbackModel) agent.config.fallbackModel = profile.fallbackModel;
    if (profile.maxSteps) agent.config.maxSteps = profile.maxSteps;
    if (profile.outputSchema) { agent.config.outputSchema = profile.outputSchema; agent._outputSchemaRaw = JSON.stringify(profile.outputSchema, null, 2); }
    if (Array.isArray(profile.tools)) setAgentTools(agent, profile.tools);
    agent.config.profile = { sourceRef: { package: profile.source?.package || "specialists", id: profile.id, revision: profile.source?.revision ?? null }, importedAt: new Date().toISOString(), name: profile.name };
    wf.nodes = wf.nodes;
  }
  function toggleAgentTool(node, name) {
    const cur = agentTools(node);
    setAgentTools(node, cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
  }
  function openToolPicker() {
    toolPickQuery = "";
    toolPickOpen = true;
    if (!toolCatalog.length && !toolsLoading) loadTools();
  }

  $: agentToolNames = selectedNode && selectedNode.type === "agent" ? agentTools(selectedNode) : [];
  $: toolPickQ = toolPickQuery.trim().toLowerCase();
  $: toolPickList = toolCatalog.filter((t) => !toolPickQ
    || t.name.toLowerCase().includes(toolPickQ)
    || (t.package || "").toLowerCase().includes(toolPickQ)
    || (t.description || "").toLowerCase().includes(toolPickQ));
  $: toolPickByPkg = groupBy(toolPickList, "package");
  function setAgentRoute(node, m) {
    node.config.routeBy = m;
    if (m !== "model") node.config.model = "";
    wf.nodes = wf.nodes;
  }

  // ── Geometria de portas ──────────────────────────────────────────────────
  function outPortY(node, port) {
    const ports = nodePorts(node);
    const idx = Math.max(0, ports.indexOf(port));
    return node.position.y + HEAD_H + 16 + idx * 22;
  }
  function inPortPos(node) { return { x: node.position.x, y: node.position.y + HEAD_H + 16 }; }
  function outPortPos(node, port) { return { x: node.position.x + NODE_W, y: outPortY(node, port) }; }

  function edgePath(e) {
    const from = wf.nodes.find((n) => n.id === e.from);
    const to = wf.nodes.find((n) => n.id === e.to);
    if (!from || !to) return "";
    const a = outPortPos(from, e.fromPort || "out");
    const b = inPortPos(to);
    return bezier(a, b);
  }
  function bezier(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  // ── Interação: pan / mover nó / conectar / pinça ──────────────────────────
  const MIN_Z = 0.35, MAX_Z = 1.8;
  const clampZoom = (z) => Math.min(MAX_Z, Math.max(MIN_Z, z));
  let drag = null; // { kind, ... }
  let pointers = new Map(); // pointerId -> {x,y} — só ponteiros no fundo do canvas (para pinça)
  let pinch = null;         // { d0, z0, mx, my, px, py }

  function screenToWorld(clientX, clientY) {
    const r = canvasEl.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  }

  // Zoom mantendo fixo o ponto (cx,cy) em coords locais do canvas.
  function zoomAround(cx, cy, factor) {
    const nz = clampZoom(zoom * factor);
    pan = { x: cx - (cx - pan.x) * (nz / zoom), y: cy - (cy - pan.y) * (nz / zoom) };
    zoom = nz;
  }
  function zoomStep(dir) {
    const r = canvasEl.getBoundingClientRect();
    zoomAround(r.width / 2, r.height / 2, dir > 0 ? 1.2 : 1 / 1.2);
  }

  // Reenquadra: ajusta pan/zoom para caber todos os nós, com folga.
  function fitView() {
    if (!wf?.nodes?.length || !canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    const NODE_H = 74;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of wf.nodes) {
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_W); maxY = Math.max(maxY, n.position.y + NODE_H);
    }
    const isMobile = window.matchMedia("(max-width: 900px)").matches;
    // The mobile action bar overlays the lower edge of the canvas, so reserve
    // enough space for it while framing the graph.
    const padX = isMobile ? 32 : documentBus ? 340 : 56;
    const padTop = isMobile ? 150 : 140;
    const padBottom = isMobile ? 112 : 56;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const availableW = Math.max(1, r.width - padX * 2);
    const availableH = Math.max(1, r.height - padTop - padBottom);
    const nz = Math.max(.05, Math.min(documentBus ? 1 : MAX_Z, availableW / bw, availableH / bh));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    zoom = nz;
    pan = {
      x: r.width / 2 - cx * nz,
      y: (isMobile ? padTop + availableH / 2 : r.height / 2) - cy * nz,
    };
  }

  function beginPinch() {
    const pts = [...pointers.values()];
    const r = canvasEl.getBoundingClientRect();
    pinch = {
      d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      z0: zoom,
      mx: (pts[0].x + pts[1].x) / 2 - r.left,
      my: (pts[0].y + pts[1].y) / 2 - r.top,
      px: pan.x, py: pan.y,
    };
  }

  // Cria uma aresta se ainda não existir. Retorna true se criou.
  function addEdge(from, fromPort, to) {
    if (!from || !to || from === to) return false;
    const exists = wf.edges.some((x) => x.from === from && x.fromPort === (fromPort || "out") && x.to === to);
    if (exists) return false;
    wf.edges = [...wf.edges, { id: uid("eg"), from, fromPort: fromPort || "out", to }];
    return true;
  }
  // Completa o modo "tocar p/ ligar" num nó de destino.
  function completeLink(toId) {
    if (!linkFrom) return;
    if (addEdge(linkFrom.from, linkFrom.fromPort, toId)) showToast("Nodes connected");
    linkFrom = null;
  }
  // Abre o inspetor de configuração do nó (double-tap no mobile; inerte no desktop).
  function openNodeConfig(node) {
    selectedNodeId = node.id;
    syncWorkspace("selected");
    mobilePanel = "inspector";
  }
  function onKey(e) {
    if (e.key === "Escape") { if (linkFrom) linkFrom = null; else if (connecting) connecting = null; }
  }

  function onCanvasPointerDown(e) {
    if (e.target.closest(".node") || e.target.closest(".port") || e.target.closest(".zoomctl, .canvas__triggerbar, input, textarea, select, button")) return;
    if (linkFrom) { linkFrom = null; return; } // toque no fundo cancela o modo ligar
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    if (pointers.size >= 2) { drag = null; beginPinch(); return; } // dois dedos → pinça
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    selectedNodeId = null;
  }
  function onNodePointerDown(e, node) {
    // Modo "tocar p/ ligar" ativo → este nó é o destino (mesmo tocando na porta de entrada).
    if (linkFrom && linkFrom.from !== node.id) { e.stopPropagation(); completeLink(node.id); return; }
    if (e.target.closest(".port")) return;
    e.stopPropagation();
    selectedNodeId = node.id;
    syncWorkspace("selected");
    drag = { kind: "node", id: node.id, sx: e.clientX, sy: e.clientY, ox: node.position.x, oy: node.position.y };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  function onOutPortDown(e, node, port) {
    e.stopPropagation();
    const p = outPortPos(node, port);
    connecting = { from: node.id, fromPort: port, x: p.x, y: p.y };
    drag = { kind: "connect", sx: e.clientX, sy: e.clientY, moved: false };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  function onPointerMove(e) {
    // Pinça: dois ponteiros no fundo do canvas escalam em torno do ponto médio inicial.
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const nz = clampZoom(pinch.z0 * (d / pinch.d0));
      pan = { x: pinch.mx - (pinch.mx - pinch.px) * (nz / pinch.z0), y: pinch.my - (pinch.my - pinch.py) * (nz / pinch.z0) };
      zoom = nz;
      return;
    }
    if (!drag) return;
    if (drag.kind === "pan") { pan = { x: drag.px + (e.clientX - drag.sx), y: drag.py + (e.clientY - drag.sy) }; }
    else if (drag.kind === "node") {
      const n = wf.nodes.find((x) => x.id === drag.id);
      if (n) { n.position = { x: drag.ox + (e.clientX - drag.sx) / zoom, y: drag.oy + (e.clientY - drag.sy) / zoom }; wf.nodes = wf.nodes; }
    } else if (drag.kind === "connect") {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
      const w = screenToWorld(e.clientX, e.clientY);
      connecting = { ...connecting, x: w.x, y: w.y };
    }
  }
  function onPointerUp(e) {
    if (drag && drag.kind === "connect") {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      // Solta sobre a porta de entrada OU em qualquer parte do nó de destino.
      const target = el && (el.closest("[data-in]") || el.closest(".node"));
      const toId = target && (target.getAttribute("data-in") || target.getAttribute("data-node"));
      if (toId && toId !== connecting.from) {
        addEdge(connecting.from, connecting.fromPort, toId);
        linkFrom = null;
      } else if (!drag.moved) {
        // Toque simples na porta (sem arrastar) → entra no modo "tocar p/ ligar":
        // o próximo toque num nó cria a conexão. Facilita muito no mobile.
        linkFrom = { from: connecting.from, fromPort: connecting.fromPort };
      }
      connecting = null;
    }
    // Fim do gesto de pinça / pan multitoque
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1 && drag == null) {
      // sobrou um dedo depois da pinça → retoma o pan a partir dele
      const [p] = [...pointers.values()];
      drag = { kind: "pan", sx: p.x, sy: p.y, px: pan.x, py: pan.y };
    }
    if (pointers.size === 0) drag = null;
    else if (drag && drag.kind !== "pan") drag = null;
    if (pointers.size === 0) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const r = canvasEl.getBoundingClientRect();
    zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }
  function removeEdge(id) { wf.edges = wf.edges.filter((e) => e.id !== id); }

  // ── Inspetor: params de tool ───────────────────────────────────────────────
  function setArg(key, value) {
    selectedNode.config.args = { ...(selectedNode.config.args || {}), [key]: value };
    selectedNode._argsRaw = ""; // edição campo-a-campo vence sobre o JSON cru
    wf.nodes = wf.nodes;
  }
  function argValue(key) { return selectedNode.config.args?.[key] ?? ""; }

  // Params com fonte viva (@enumSource no JSDoc da tool): as opções são
  // resolvidas sob demanda pelo servidor. Fonte que não resolve não trava nada
  // — o campo continua sendo texto livre.
  let enumOptions = {};   // source -> string[]
  let enumPending = {};   // source -> true enquanto busca
  async function loadEnumSource(source) {
    if (!source || enumOptions[source] || enumPending[source]) return;
    enumPending = { ...enumPending, [source]: true };
    try {
      const r = await fetch(BASE + "/tools/options?source=" + encodeURIComponent(source)).then((r) => r.json());
      if (r?.options?.length) enumOptions = { ...enumOptions, [source]: r.options };
    } catch { /* fonte fora do ar → segue como texto livre */ }
    finally {
      const { [source]: _, ...rest } = enumPending;
      enumPending = rest;
    }
  }
  $: if (selectedTool) {
    for (const p of selectedTool.params) if (p.enumSource) loadEnumSource(p.enumSource);
  }

  // ── Inputs (schema flow→tool) ──────────────────────────────────────────────
  function addInput() { wf.inputs = [...wf.inputs, { name: "param", type: "string", description: "", required: false }]; }
  function removeInput(i) { wf.inputs = wf.inputs.filter((_, idx) => idx !== i); }

  let showAuthorization = false, authorization = null, authorizationBusy = false, authorizationError = '';
  async function openAuthorization() {
    if (documentBus && workspaceWidgetRole !== 'canvas') { documentBus.request('authorization'); return; }
    if (!(await save({ silent: true }))) return;
    showAuthorization = true; authorization = null;
    await authorizationRequest('GET');
  }
  async function authorizationRequest(method) {
    authorizationBusy = true; authorizationError = '';
    try {
      const response = await fetch(BASE + '/workflows/' + encodeURIComponent(wf.id) + '/authorization', {
        method,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeHash: authorization?.scopeHash }) } : {}),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao atualizar autorização');
      if (method === 'DELETE') authorization = { ...authorization, active: false };
      else authorization = result.authorization;
    } catch (error) { authorizationError = error.message; }
    finally { authorizationBusy = false; }
  }

  // ── Persistência ────────────────────────────────────────────────────────────
  let saving = false;
  async function save({ silent = false } = {}) {
    if (!wf?.id) return false;
    clearTimeout(workspaceSyncTimer);
    if (documentBus && workspaceWidgetRole !== 'canvas') {
      observeDocument();
      const id = uid('save');
      return new Promise(resolve => {
        const timer = setTimeout(() => { pendingSaves.delete(id); saveError = 'Sem confirmação de gravação. Tente novamente.'; resolve(false); }, 15000);
        pendingSaves.set(id, ok => { clearTimeout(timer); resolve(ok); });
        documentBus.request('save', { id });
      });
    }
    const snapshot = snapshotFlow();
    saving = true; saveError = ''; publishDocument();
    try {
      const result = await writeSnapshot(snapshot);
      if (!alive) return true;
      // Preserve edits made while the request was in flight, including generated tokens.
      const current = snapshotFlow();
      if (result.workflow) wf = normalize(applyChanges(result.workflow, changesBetween(snapshot, current)));
      dirty = JSON.stringify(snapshot) !== JSON.stringify(current);
      if (!silent) showToast('Saved');
      return true;
    } catch (e) { saveError = e.message; dirty = true; showToast(e.message, 'error'); return false; }
    finally { saving = false; publishDocument(); }
  }

  // Duplicar: salva o rascunho atual (a cópia sai do que está em disco), cria a
  // cópia e abre o editor nela. A cópia nasce desligada — ver store.duplicateWorkflow.
  let duplicating = false;
  async function duplicateFlow() {
    if (duplicating) return;
    duplicating = true;
    try {
      if (!(await save({ silent: true }))) return;
      const res = await fetch(BASE + "/workflows/" + wf.id + "/duplicate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error || "Failed to duplicate workflow");
      if (documentBus) openWorkspace(res.workflow); else location.href = "/view/flows/Editor?id=" + res.workflow.id;
    } catch (e) {
      showToast(e.message || "Failed to duplicate workflow", "error");
    } finally { duplicating = false; }
  }

  // ── Sub-flows: abrir outro flow e voltar ──────────────────────────────────
  // Navega para outro flow salvando antes o rascunho atual; `from` permite o
  // botão voltar retornar ao flow principal em vez de ir para a lista.
  async function openSubflow(subId) {
    if (!subId) return;
    if (!(await save({ silent: true }))) return;
    if (documentBus) openWorkspace({ id: subId, name: subflowName(subId) || "Sub-flow" }); else location.href = "/view/flows/Editor?id=" + subId + "&from=" + wf.id;
  }
  async function createSubflow(node) {
    if (!(await save({ silent: true }))) return; // garante o rascunho atual salvo
    try {
      const res = await fetch(BASE + "/workflows", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: (wf.name || "Flow") + " · sub-flow" }),
      }).then((r) => r.json());
      const sub = res.workflow;
      if (!sub) throw new Error(res.error || "Failed to create sub-flow");
      node.config.workflowId = sub.id;      // referencia o novo flow no nó
      wf.nodes = wf.nodes;
      if (!(await save({ silent: true }))) return; // persiste a referência antes de abrir
      if (documentBus) openWorkspace(sub); else location.href = "/view/flows/Editor?id=" + sub.id + "&from=" + wf.id;
    } catch (e) { showToast(e.message || "Failed to create sub-flow", "error"); }
  }
  $: subflowName = (id) => (workflowList.find((w) => w.id === id) || {}).name || null;
  // ── Execução, histórico e replay ───────────────────────────────────────────
  let lastRun = null;      // run exibido no painel (último teste OU um do histórico)
  let showRun = false;     // painel de execução aberto
  let running = false;
  let runHistory = [];     // execuções passadas deste flow (persistidas)
  let runTab = "steps";    // aba do painel: steps | log | input

  // Histórico persiste em disco (data/runs.json), então o log de execuções
  // continua disponível ao reabrir o editor — antes só existia o run da sessão.
  async function loadRuns({ select = false } = {}) {
    if (!wf?.id) return;
    try {
      const r = await fetch(BASE + "/runs?workflowId=" + wf.id + "&limit=25").then((x) => x.json());
      runHistory = r.runs || [];
      if (select && !lastRun && runHistory.length) lastRun = runHistory[0];
    } catch { /* histórico é complementar — nunca bloqueia o editor */ }
  }

  function selectRun(run) {
    stopReplay();
    lastRun = run;
    expandedStep = null;
    showRun = true;
  }

  // ── Painel "Testar": payload do gatilho preenchível ────────────────────────
  //
  // O play não roda mais com payload vazio: abre este painel com os campos que o
  // flow espera. A interface vem de /flows/workflows/:id/interface — inputs
  // declarados + shape do gatilho ABSORVIDO pelo flow (persistido, sobrevive ao
  // reboot) + o que o tap observou agora.
  let showTest = false;
  let testSpec = null;          // { fields, sample, lastPayload, shape, shapeSource, triggerType, event }
  let testLoading = false;
  let testMode = "form";        // form | json
  let testValues = {};          // { [path]: valor bruto do input }
  let testRaw = "";             // payload em JSON (modo json)
  let testJsonError = null;

  async function openTest() {
    showTest = true;
    testLoading = true;
    testJsonError = null;
    if (!(await save({ silent: true }))) { testLoading = false; showTest = false; return; }
    try {
      const r = await fetch(BASE + "/workflows/" + wf.id + "/interface").then((x) => x.json());
      testSpec = r.success === false ? null : r;
    } catch { testSpec = null; }
    seedTestValues(testSpec?.lastPayload || null);
    testLoading = false;
  }

  // Semeia o formulário: último payload usado (se houver) ou vazio por campo.
  function seedTestValues(payload) {
    const vals = {};
    for (const f of testSpec?.fields || []) {
      const v = payload ? payload[f.path] : undefined;
      if (v === undefined || v === null) vals[f.path] = f.type === "boolean" ? false : "";
      else if (f.type === "boolean") vals[f.path] = !!v;
      else if (typeof v === "object") vals[f.path] = JSON.stringify(v, null, 2);
      else vals[f.path] = String(v);
    }
    testValues = vals;
    testRaw = JSON.stringify(payload || buildTestPayload(vals) || {}, null, 2);
  }

  // Monta o payload a partir do formulário. Regra: campo em branco é OMITIDO
  // (use o modo JSON para mandar valores vazios explícitos); booleano sempre vai,
  // porque o checkbox já é um estado explícito.
  function buildTestPayload(vals = testValues) {
    const out = {};
    for (const f of testSpec?.fields || []) {
      const v = vals[f.path];
      if (f.type === "boolean") { out[f.path] = !!v; continue; }
      if (v === "" || v === undefined || v === null) continue;
      if (f.type === "number") { const n = Number(v); out[f.path] = Number.isFinite(n) ? n : v; continue; }
      if (f.type === "object" || f.type.startsWith("array<")) {
        try { out[f.path] = JSON.parse(v); } catch { out[f.path] = v; }
        continue;
      }
      out[f.path] = v;
    }
    return out;
  }

  // Ao alternar form → json, leva os valores do formulário para o JSON.
  function setTestMode(m) {
    if (m === "json" && testMode === "form") testRaw = JSON.stringify(buildTestPayload(), null, 2);
    testMode = m;
    testJsonError = null;
  }

  function fillSample() {
    seedTestValues(testSpec?.sample || {});
    showToast("Fields filled with the interface example");
  }
  function clearTest() {
    seedTestValues(null);
    testRaw = "{}";
  }

  // Payload final a enviar: do formulário ou do JSON cru (que precisa ser objeto).
  function resolveTestPayload() {
    if (testMode === "form") return buildTestPayload();
    if (!testRaw.trim()) return {};
    const parsed = JSON.parse(testRaw); // erro tratado pelo chamador
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Payload must be a JSON object");
    }
    return parsed;
  }

  async function runTest() {
    let payload;
    try { payload = resolveTestPayload(); testJsonError = null; }
    catch (e) { testJsonError = e.message || "Invalid JSON"; return; }
    showTest = false;
    await runNow(payload);
  }

  async function runNow(payload = {}) {
    running = true;
    if (!(await save({ silent: true }))) { running = false; return; }
    try {
      const res = await fetch(BASE + "/workflows/" + wf.id + "/run", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}),
      }).then((r) => r.json());
      if (res.success) {
        lastRun = res.run;
        showRun = true;
        runTab = "steps";
        expandedStep = null;
        startReplay(); // anima o pulso percorrendo o grafo assim que termina
        showToast("Run: " + res.run.status, res.run.status === "ok" ? "success" : "error");
        loadRuns();
      } else {
        showToast(res.error || "Run failed", "error");
      }
    } catch (e) {
      showToast(e.message || "Failed to run workflow", "error");
    }
    running = false;
  }

  // Replay: roda de novo COM OS MESMOS PARÂMETROS do run escolhido. O payload
  // original vive em run.input (persistido pelo motor).
  let replayingRun = false;
  async function replayRun(run) {
    if (!run || run.input == null) { showToast("This run has no saved payload and cannot be replayed", "error"); return; }
    replayingRun = true;
    try {
      const res = await fetch(BASE + "/runs/" + run.id + "/replay", { method: "POST" }).then((r) => r.json());
      if (res.success) {
        lastRun = res.run;
        showRun = true;
        runTab = "steps";
        expandedStep = null;
        startReplay();
        showToast("Replay: " + res.run.status, res.run.status === "ok" ? "success" : "error");
        loadRuns();
      } else showToast(res.error || "Replay failed", "error");
    } catch (e) {
      showToast(e.message || "Replay failed", "error");
    }
    replayingRun = false;
  }

  // Reabre o painel de teste já preenchido com o payload de um run passado —
  // replay com ajuste ("mesma coisa, mas mudando um campo").
  async function editAndReplay(run) {
    if (!run || run.input == null) { showToast("This run has no saved payload", "error"); return; }
    await openTest();
    seedTestValues(run.input);
    testMode = "json";
    testRaw = JSON.stringify(run.input, null, 2);
  }

  function fmtRunTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtLogTime(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour12: false });
  }
  // ── Acompanhador de etapas (debug) ──────────────────────────────────────────
  // ids dos nós com erro no último run — para destacar no canvas.
  $: erroredNodes = new Set((lastRun?.nodes || []).filter((s) => s.status === "error").map((s) => s.id));
  $: skippedNodes = new Set((lastRun?.nodes || []).filter((s) => s.status === "skipped").map((s) => s.id));
  $: ranNodes = new Set((lastRun?.nodes || []).filter((s) => s.status === "ok").map((s) => s.id));
  $: runNodeMap = new Map((lastRun?.nodes || []).map((s) => [s.id, s]));
  // Arestas que conduziram informação (state active) — a animação percorre só elas.
  $: runActiveEdges = (lastRun?.edges || []).filter((e) => e.state === "active");
  // Ordem de execução (exclui pulados) — usada no replay guiado passo a passo.
  $: runOrder = (lastRun?.nodes || []).filter((s) => s.status !== "skipped" && s.order != null)
    .slice().sort((a, b) => a.order - b.order);

  let expandedStep = null;   // id do nó expandido na timeline
  let replaying = false;
  let replayNodeId = null;   // nó destacado no "andar" do replay
  let replayTimer = null;

  function stopReplay() { if (replayTimer) clearInterval(replayTimer); replayTimer = null; replaying = false; replayNodeId = null; }
  function startReplay() {
    stopReplay();
    if (!runOrder.length) return;
    replaying = true;
    let i = 0;
    replayNodeId = runOrder[0].id;
    focusOnNode(replayNodeId);
    replayTimer = setInterval(() => {
      i++;
      if (i >= runOrder.length) { stopReplay(); return; }
      replayNodeId = runOrder[i].id;
      focusOnNode(replayNodeId);
    }, 850);
  }
  // Centraliza suavemente o nó em foco durante o replay (sem alterar o zoom).
  function focusOnNode(id) {
    const n = wf?.nodes.find((x) => x.id === id);
    if (!n || !canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    pan = { x: r.width / 2 - (n.position.x + NODE_W / 2) * zoom, y: r.height / 2 - (n.position.y + 40) * zoom };
  }
  function fmtDur(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
  }
  function prettyJson(o) {
    if (o == null) return "";
    try { return typeof o === "string" ? o : JSON.stringify(o, null, 2); }
    catch { return String(o); }
  }
  function stepStatusClass(s) {
    if (s === "ok") return "ok";
    if (s === "error") return "error";
    if (s === "skipped") return "muted";
    return "warn";
  }
  function nodeNameOf(id) { return (wf?.nodes.find((n) => n.id === id) || {}).name || id; }
  function fmtOutput(o) {
    if (o == null) return "";
    try { const s = typeof o === "string" ? o : JSON.stringify(o); return s.length > 400 ? s.slice(0, 400) + "…" : s; }
    catch { return String(o); }
  }
  async function togglePublish() {
    if (!(await save())) return;
    const path = wf.publishAsTool ? "/unpublish" : "/publish";
    const res = await fetch(BASE + "/workflows/" + wf.id + path, { method: "POST" }).then((r) => r.json());
    if (res.success) { wf.publishAsTool = !wf.publishAsTool; showToast(wf.publishAsTool ? "Published as tool: " + (res.tool || "") : "Tool unpublished"); }
    else showToast(res.error || "Publishing failed", "error");
  }

  // ── Paleta filtrada ─────────────────────────────────────────────────────────
  $: q = paletteQuery.trim().toLowerCase();
  $: coreFiltered = CORE_NODES.filter((n) => (!wf?.local || ['trigger','set','log','delay','condition','switch','merge','script','rules','tool'].includes(n.type)) && (!q || n.label.toLowerCase().includes(q) || n.type.includes(q)));
  // Nós core agrupados por categoria (na ordem de NODE_CATS), só grupos não-vazios.
  // O gatilho é omitido: é único/permanente e já existe no flow, não se adiciona.
  $: coreGroups = NODE_CATS
    .map((c) => ({ ...c, items: coreFiltered.filter((n) => n.type !== "trigger" && (n.cat || "action") === c.key) }))
    .filter((g) => g.items.length);
  $: toolsFiltered = toolCatalog.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.package || "").toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  $: toolsByPkg = groupBy(toolsFiltered, "package");
  function groupBy(arr, key) { const m = {}; for (const it of arr) { (m[it[key] || "outros"] ||= []).push(it); } return m; }

  // ── Sistema de variáveis: o que está disponível para {{templating}} ──────────
  // Contexto de execução (ver graph-engine): trigger / vars / nodes.<id>.
  // Cada tipo de nó expõe campos de saída conhecidos.
  const NODE_OUT = {
    log: ["message"], http: ["status", "ok", "body"], emit: ["emitted"],
    delay: ["waited"], condition: ["pass"], tool: ["result"],
    script: ["output"], rules: ["output", "matched", "matchedRules", "changes"],
    agent: ["text", "output", "model"], classifier: ["choice", "confidence", "provider", "usedFallback"], merge: ["merged"], "sub-flow": ["runId", "status"],
    "session-message": ["sessionId", "persisted", "live"],
  };

  function triggerVars(w) {
    const out = [];
    // Inputs viram parâmetros da tool publicada e chegam como trigger.<nome>.
    for (const inp of w.inputs || []) {
      if (inp.name) out.push({ expr: `trigger.${inp.name}`, note: (inp.description || inp.type) + (inp.required ? " · obrigatório" : "") });
    }
    const t = w.trigger?.type;
    if (t === "webhook") {
      for (const k of ["body", "query", "headers", "method"]) out.push({ expr: `trigger.${k}`, note: "webhook" });
    } else if (t === "event") {
      const ev = (eventCatalog || []).find((e) => e.event === w.trigger.event);
      const shape = ev && ev.suggestedPayload;
      if (shape && typeof shape === "object") {
        for (const k of Object.keys(shape)) out.push({ expr: `trigger.${k}`, note: "payload do evento" });
      } else {
        out.push({ expr: "trigger", note: "payload do evento" });
      }
    } else {
      out.push({ expr: "trigger", note: t === "semantic" ? "evento casado" : "payload de entrada" });
    }
    return out;
  }

  function varsFromSet(w) {
    const out = [];
    for (const n of w.nodes || []) {
      if (n.type === "set" && n.config?.key) out.push({ expr: `vars.${n.config.key}`, note: "nó: " + n.name });
    }
    return out;
  }

  function nodeOutputVars(w, excludeId) {
    const out = [];
    for (const n of w.nodes || []) {
      if (n.id === excludeId || n.type === "trigger" || n.type === "set") continue;
      const fields = NODE_OUT[n.type];
      if (!fields) continue;
      for (const f of fields) out.push({ expr: `nodes.${n.id}.${f}`, note: n.name });
    }
    return out;
  }

  $: varGroups = wf ? [
    { title: "Trigger", items: triggerVars(wf) },
    { title: "Variables (set)", items: varsFromSet(wf) },
    { title: "Node outputs", items: nodeOutputVars(wf, selectedNodeId) },
  ].filter((g) => g.items.length) : [];

  async function copyVar(expr) {
    const tpl = `{{${expr}}}`;
    try { await navigator.clipboard.writeText(tpl); showToast("Copied: " + tpl); }
    catch { showToast(tpl, "success"); }
  }

  // Espelha publish.js (toolNameFor/slug) para prever o nome da tool na UI.
  function slug(name) {
    return (name || "flow").toString().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "flow";
  }
  $: toolNamePreview = wf ? `flow_${slug(wf.name)}_${(wf.id || "").slice(-6)}` : "";
</script>

<svelte:window on:keydown={onKey} />

<div on:input={() => tick().then(observeDocument)} on:change={() => tick().then(observeDocument)} on:click={() => tick().then(observeDocument)} class="ed" class:ed--compact={compactWorkspace} class:ed--direct-canvas={directCanvasWorkspace} class:ed--widget-canvas={workspaceWidgetRole === "canvas"} class:ed--widget-catalog={workspaceWidgetRole === "nodeCatalog"} class:ed--widget-properties={workspaceWidgetRole === "properties"} class:ed--widget-trigger={workspaceWidgetRole === "trigger"} class:ed--widget-controls={workspaceWidgetRole === "controls"} data-theme={theme}>
  {#if toast}<div class="toast toast--{toast.type}">{toast.message}</div>{/if}

  <!-- Testar: payload do gatilho preenchível antes de executar -->
  {#if showTest}
    <div class="modal" on:click|self={() => (showTest = false)}>
      <div class="testsheet">
        <div class="testsheet__head">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
          <span class="testsheet__title">Test flow</span>
          <button class="runpanel__x" on:click={() => (showTest = false)} aria-label="Close">✕</button>
        </div>

        {#if testLoading}
          <div class="testsheet__body"><p class="hint">Loading trigger interface…</p></div>
        {:else}
          <div class="testsheet__body">
            <p class="testsheet__ctx">
              Trigger <b>{testSpec?.triggerType || wf.trigger.type}</b>
              {#if testSpec?.event}· <code>{testSpec.event}</code>{/if}
              {#if testSpec?.shapeSource === "absorvido"}
                <span class="tag" title="This interface is saved with the flow and survives runtime restarts">saved interface</span>
              {:else if testSpec?.shapeSource === "absorvido+observado"}
                <span class="tag" title="Saved interface plus fields observed on the bus">saved + observed</span>
              {:else if testSpec?.shapeSource === "observado"}
                <span class="tag tag--weak" title="Observed on the bus; it is saved after the flow runs">observed now</span>
              {/if}
            </p>

            <div class="segmented segmented--sm">
              <button class="seg" class:seg--on={testMode === "form"} on:click={() => setTestMode("form")}>Fields</button>
              <button class="seg" class:seg--on={testMode === "json"} on:click={() => setTestMode("json")}>JSON</button>
            </div>

            {#if testMode === "form"}
              {#if !(testSpec?.fields || []).length}
                <p class="hint">
                  This flow has not learned the trigger interface yet. It is saved the first time the flow runs.
                  Until then, use the <b>JSON</b> tab or declare <b>inputs</b> in the inspector.
                </p>
              {:else}
                <div class="testfields">
                  {#each testSpec.fields as f (f.path)}
                    <div class="tfield">
                      <label class="tfield__lbl" for={"tf_" + f.path}>
                        <code>{f.path}</code>
                        <span class="tfield__type">{f.type}</span>
                        {#if f.required}<span class="tfield__req">required</span>{/if}
                        {#if f.source === "input"}<span class="tag tag--weak">input</span>{/if}
                      </label>
                      {#if f.description}<span class="tfield__desc">{f.description}</span>{/if}
                      {#if f.type === "boolean"}
                        <label class="tfield__check"><input id={"tf_" + f.path} type="checkbox" bind:checked={testValues[f.path]} /> <span>{testValues[f.path] ? "true" : "false"}</span></label>
                      {:else if f.type === "number"}
                        <input id={"tf_" + f.path} class="input input--sm" type="number" bind:value={testValues[f.path]} placeholder="0" />
                      {:else if f.type === "object" || f.type.startsWith("array<")}
                        <textarea id={"tf_" + f.path} class="input input--sm input--mono" rows="3" bind:value={testValues[f.path]} placeholder={f.type.startsWith("array<") ? "[]" : "{}"}></textarea>
                      {:else}
                        <input id={"tf_" + f.path} class="input input--sm" bind:value={testValues[f.path]} placeholder="(empty fields are omitted)" />
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <textarea class="input input--mono testjson" rows="12" bind:value={testRaw} placeholder={'{ "campo": "valor" }'}></textarea>
              {#if testJsonError}<p class="testsheet__err">{testJsonError}</p>{/if}
            {/if}
          </div>

          <div class="testsheet__foot">
            <button class="chip" on:click={fillSample} disabled={!testSpec?.shape}>Use example</button>
            <button class="chip" on:click={clearTest}>Clear</button>
            <div class="topbar__spacer"></div>
            <button class="btn btn--ghost btn--compact" on:click={() => (showTest = false)}>Cancel</button>
            <button class="btn btn--primary btn--compact" on:click={runTest} disabled={running}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
              <span class="btn__label">{running ? "Running…" : "Run"}</span>
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Catálogo de tools do nó agente: buscável e agrupado por pacote, em vez de
       digitar nomes de tools que ninguém memoriza. -->
  {#if toolPickOpen && selectedNode && selectedNode.type === "agent"}
    <div class="modal" on:click|self={() => (toolPickOpen = false)}>
      <div class="testsheet">
        <div class="testsheet__head">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg>
          <span class="testsheet__title">Agent tools</span>
          <span class="tag">{agentToolNames.length} selected</span>
          <button class="runpanel__x" on:click={() => (toolPickOpen = false)} aria-label="Close">✕</button>
        </div>

        <div class="testsheet__body">
          <input class="input input--sm" bind:value={toolPickQuery} placeholder="Search by name, package, or description…" />

          {#if !agentToolNames.length}
            <p class="hint">With no selection, Agent chooses relevant tools for each run based on the node goal.</p>
          {/if}

          {#if toolsLoading}
            <p class="hint">Loading catalog…</p>
          {:else if toolsError}
            <p class="hint">Catalog unavailable: {toolsError}</p>
            <button class="chip" on:click={() => loadTools(true)}>Try again</button>
          {:else if !toolPickList.length}
            <p class="hint">No tools match “{toolPickQuery}”.</p>
          {:else}
            <div class="tpick">
              {#each Object.entries(toolPickByPkg) as [pkg, list] (pkg)}
                <div class="tpick__group">
                  <div class="tpick__pkg">
                    <span>{pkg || "runtime"}</span>
                    <span class="tpick__count">{list.length}</span>
                    <button class="tpick__all" on:click={() => setAgentTools(selectedNode, [...agentToolNames, ...list.map((t) => t.name)])}>select all</button>
                  </div>
                  {#each list as t (t.package + ":" + t.name)}
                    {@const on = agentToolNames.includes(t.name)}
                    <button class="tpick__tool" class:tpick__tool--on={on} on:click={() => toggleAgentTool(selectedNode, t.name)}>
                      <span class="tpick__box" class:tpick__box--on={on}>
                        {#if on}<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                      </span>
                      <span class="tpick__body">
                        <span class="tpick__name">{t.name}</span>
                        {#if t.description}<span class="tpick__desc">{t.description}</span>{/if}
                      </span>
                      {#if t.params?.length}<span class="tpick__params">{t.params.length} params</span>{/if}
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="testsheet__foot">
          <button class="chip" on:click={() => setAgentTools(selectedNode, [])} disabled={!agentToolNames.length}>Clear (use auto-select)</button>
          <div class="topbar__spacer"></div>
          <button class="btn btn--primary btn--compact" on:click={() => (toolPickOpen = false)}>Done</button>
        </div>
      </div>
    </div>
  {/if}

  {#if documentBus && workspaceWidgetRole === 'canvas' && wf}
    <input class="document-title" bind:value={wf.name} aria-label="Nome do Flow" placeholder="Nome do Flow" on:blur={() => save({ silent: true })} on:keydown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
  {/if}
  <!-- Operational app bar -->
  {#if !directCanvasWorkspace || workspaceWidgetRole === "controls"}<header class="topbar">
    {#if documentBus}<button class="btn btn--ghost" aria-label="Voltar aos fluxos" title="Voltar aos fluxos" on:click={async () => { if (await save({ silent: true })) window.top.postMessage({ source: 'agent', type: 'open:app', detail: 'flows' }, window.location.origin); }}>←</button>{:else}
    <a class="btn btn--ghost" href={fromId ? "/view/flows/Editor?id=" + fromId : "/view/flows/Index"} title={fromId ? "Back to parent flow" : "Back to workflows"} aria-label="Back">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    {/if}
    {#if fromId}<span class="subflow-tag" title="Editing a sub-flow">sub-flow</span>{/if}
    {#if wf}
      {#if !documentBus}<input class="title-input" bind:value={wf.name} placeholder="Untitled workflow" aria-label="Workflow name" />{/if}
      <div class="control-group desktop-action" role="group" aria-label="Disponibilidade do Flow"><label class="flow-enabled"><input type="checkbox" bind:checked={wf.enabled} /> Ativo</label>
      <button disabled={wf.local} class="btn btn--compact" class:btn--on={wf.publishAsTool} on:click={togglePublish} aria-pressed={!!wf.publishAsTool} title="Publish as @register_tool">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M4 21h16"/></svg>
        <span class="btn__label">{wf.publishAsTool ? "Tool ativa" : "Usar como Tool"}</span>
      </button>
      </div>
      <span class="save-state desktop-action" role="status" aria-live="polite" class:save-state--busy={saving}>{saving ? "Salvando…" : saveError ? "Falha ao salvar" : dirty ? "Alterações pendentes" : "Salvo"}</span>
      <div class="topbar__spacer"></div>
      <button class="btn btn--compact desktop-action" on:click={openAuthorization} disabled={saving || wf.local}>Autorizações</button>
      <button class="btn btn--compact desktop-action" on:click={duplicateFlow} disabled={duplicating || saving} title="Duplicate this workflow as inactive">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span class="btn__label">{duplicating ? "Duplicando…" : "Duplicar"}</span>
      </button>
      <button class="btn btn--primary btn--compact" on:click={() => documentBus && workspaceWidgetRole === 'controls' ? documentBus.request('test') : openTest()} disabled={running} title="Test with a trigger payload">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
        <span class="btn__label">{running ? "Executando…" : "Testar"}</span>
      </button>
      <button class="btn btn--compact desktop-action" class:btn--on={showRun} on:click={() => { if (documentBus && workspaceWidgetRole === 'controls') { documentBus.request('runs'); return; } showRun = !showRun; if (showRun) loadRuns({ select: true }); }} title="Runs and logs">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        <span class="btn__label">Execuções{#if runHistory.length}<span class="btn__count">{runHistory.length}</span>{/if}</span>
      </button>
      <button class="btn btn--compact desktop-action" on:click={save} disabled={saving} title="Save workflow">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
        <span class="btn__label">{saving ? "Salvando…" : "Salvar"}</span>
      </button>
      <details class="mobile-actions">
        <summary class="btn btn--compact" aria-label="Mais ações" title="Mais ações">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
        </summary>
        <div class="mobile-actions__menu">
          <label><input type="checkbox" bind:checked={wf.enabled} /> Flow ativo</label>
          <button on:click={openAuthorization} disabled={saving || wf.local}>Autorizações</button>
          <button on:click={() => { showRun = !showRun; if (showRun) loadRuns({ select: true }); }}>Execuções</button>
          <button on:click={duplicateFlow} disabled={duplicating || saving}>Duplicar</button>
          <button on:click={save} disabled={saving}>{saving ? "Salvando…" : "Salvar agora"}</button>
        </div>
      </details>
    {/if}
  </header>{/if}

  {#if showAuthorization}<AuthorizationDialog {authorization} busy={authorizationBusy} error={authorizationError} close={() => (showAuthorization = false)} approve={() => authorizationRequest("POST")} revoke={() => authorizationRequest("DELETE")} />{/if}

  {#if saveError}<div role="alert">{saveError} <button on:click={() => save()}>Tentar salvar novamente</button></div>{/if}
  {#if loading}
    <div class="loading">Loading editor…</div>
  {:else if !wf}<div role="alert">Não foi possível carregar o fluxo. <button on:click={boot}>Tentar novamente</button></div>
  {:else if wf}
      <div class="workbench" class:mob-open={mobilePanel} class:workbench--direct-canvas={directCanvasWorkspace}>
        <!-- Backdrop dos bottom-sheets (só mobile) -->
        <div class="mob-backdrop" on:click={() => (mobilePanel = null)} aria-hidden="true"></div>

        <!-- Paleta -->
        <aside class="palette" class:drawer-open={mobilePanel === "palette"}>
          <div class="drawer-handle">
            <span class="drawer-handle__label">Add node</span>
            <button class="drawer-handle__close" on:click={() => (mobilePanel = null)} aria-label="Close">✕</button>
          </div>
          <div class="palette__search">
            <input class="input input--sm" bind:value={paletteQuery} placeholder="Search nodes and tools…" />
          </div>
          <div class="palette__scroll">
            <p class="palette__hint">Click to add beside the selected node, or drag onto the canvas.</p>
            {#each coreGroups as g (g.key)}
              <div class="pgroup">
                <span class="pgroup__title">{g.label}</span>
                {#each g.items as n}
                  <button class="pitem" draggable="true"
                          on:dragstart={(e) => onPaletteDrag(e, { kind: "core", type: n.type })}
                          on:click={() => { addNode(n.type); mobilePanel = null; }}>
                    <svg class="pitem__ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={n.icon}/></svg>
                    <span>{n.label}</span>
                  </button>
                {/each}
              </div>
            {/each}

            <div class="pgroup">
              <div class="pgroup__head">
                <span class="pgroup__title">Tools {#if toolCatalog.length}<span class="pgroup__count">{toolsFiltered.length}</span>{/if}</span>
                <button class="pgroup__reload" title="Reload tools" on:click={() => loadTools(true)} disabled={toolsLoading} aria-label="Reload tools">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class:spin={toolsLoading}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
                </button>
              </div>
              {#if toolsLoading}
                <span class="pgroup__empty">Loading tools…</span>
              {:else if toolsError}
                <div class="pgroup__error">
                  <span>Catalog unavailable: {toolsError}</span>
                  <button class="chip" on:click={() => loadTools(true)}>Try again</button>
                </div>
              {:else if toolsFiltered.length === 0}
                <span class="pgroup__empty">{toolCatalog.length ? "no tools match your search" : "no tools"}</span>
              {:else}
                {#each Object.entries(toolsByPkg) as [pkg, list]}
                  {@const open = !!q || !!expandedPkgs[pkg]}
                  <div class="pkgacc" class:pkgacc--open={open}>
                    <button class="pkgacc__head" on:click={() => togglePkg(pkg)} aria-expanded={open}>
                      {#if pkgIcons[pkg]}
                        <img class="pkgacc__icon" src={pkgIcons[pkg]} alt="" draggable="false" />
                      {:else}
                        <span class="pkgacc__ava">{pkg.charAt(0).toUpperCase()}</span>
                      {/if}
                      <span class="pkgacc__name">{pkg}</span>
                      <span class="pkgacc__count">{list.length}</span>
                      <svg class="pkgacc__chev" class:open width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                    </button>
                    {#if open}
                      <div class="pkgacc__body">
                        {#each list as t}
                          <button class="pitem pitem--tool" draggable="true"
                                  on:dragstart={(e) => onPaletteDrag(e, { kind: "tool", tool: t })}
                                  on:click={() => { addToolNode(t); mobilePanel = null; }} title={t.description}>
                            <span class="pitem__body">
                              <span class="pitem__mono">{t.name}</span>
                              {#if t.description}<span class="pitem__desc">{t.description}</span>{/if}
                            </span>
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              {/if}

              <!-- Fallback: adiciona tool por nome mesmo sem catálogo. -->
              <form class="manualtool" on:submit|preventDefault={addManualTool}>
                <input class="input input--sm input--mono" bind:value={manualTool} placeholder="package:tool or name" list="tool-names" />
                <datalist id="tool-names">{#each toolCatalog as t}<option value={(t.package ? t.package + ':' : '') + t.name}></option>{/each}</datalist>
                <button class="chip" type="submit" disabled={!manualTool.trim()}>+ node</button>
              </form>
              {#if toolsError}<p class="pgroup__hint">Enter a tool name to create a node without the catalog. Set its arguments as JSON in the inspector.</p>{/if}
            </div>
          </div>
        </aside>

        <!-- Canvas -->
        <div class="canvas" bind:this={canvasEl} on:pointerdown={onCanvasPointerDown} on:wheel={onWheel} on:dragover|preventDefault on:drop={onCanvasDrop}>
          {#if !documentBus || workspaceWidgetRole === "trigger"}<div class="canvas__triggerbar">
            <div class="tbar">
              <div class="tbar__top">
                <div class="segmented segmented--scroll">
                  <button class="seg" class:seg--on={wf.trigger.type === "event"} on:click={() => setTrigger("event")} aria-expanded={wf.trigger.type === "event" && triggerExpanded}>Event</button>
                  <button class="seg" class:seg--on={wf.trigger.type === "webhook"} on:click={() => setTrigger("webhook")} aria-expanded={wf.trigger.type === "webhook" && triggerExpanded}>Webhook</button>
                  <button class="seg" class:seg--on={wf.trigger.type === "cron"} on:click={() => setTrigger("cron")} aria-expanded={wf.trigger.type === "cron" && triggerExpanded}>Cron</button>
                  <button class="seg" class:seg--on={wf.trigger.type === "schedule"} on:click={() => setTrigger("schedule")} aria-expanded={wf.trigger.type === "schedule" && triggerExpanded}>Date</button>
                  <button class="seg" class:seg--on={wf.trigger.type === "manual"} on:click={() => setTrigger("manual")} aria-expanded={wf.trigger.type === "manual" && triggerExpanded}>Manual</button>
                  <button class="seg" class:seg--on={wf.trigger.type === "semantic"} on:click={() => setTrigger("semantic")} aria-expanded={wf.trigger.type === "semantic" && triggerExpanded}>Semantic</button>
                </div>
                <button class="tbar__info" class:on={triggerHelp} on:click={() => (triggerHelp = !triggerHelp)} title="What is this trigger?" aria-label="Trigger help">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
                </button>
              </div>

              {#if triggerHelp}
                <div class="tbar__pop">{TRIGGER_HELP[wf.trigger.type] || ""}</div>
              {/if}

              <div class="tbar__config tbar__config--advanced">
                <label class="mini-check" title="Durable runs survive a runtime restart and resume from completed nodes.">
                  <input type="checkbox" checked={wf.executionMode === "durable"} on:change={(e) => (wf.executionMode = e.currentTarget.checked ? "durable" : "best-effort")} />
                  Durable execution
                </label>
                {#if wf.executionMode === "durable"}<span class="hint">Checkpoints each completed node. Delays resume after restart.</span>{/if}
              </div>
              <div class="tbar__config tbar__config--advanced">
                <label class="mini-check" title="Automatically accepts governance permissions for fixed Tools declared in this Flow. Absolute governance blocks remain active.">
                  <input type="checkbox" bind:checked={wf.autoApprovePermissions} />
                  Aceitar permissões automaticamente
                </label>
                {#if wf.autoApprovePermissions}<span class="hint">Tools fixas deste Flow executam sem solicitar confirmação. Alterações no Flow ou no código invalidam o escopo em execução.</span>{/if}
              </div>

              {#if triggerExpanded && wf.trigger.type === "event"}
                <div class="tbar__config">
                  <input class="input input--sm input--mono tbar__grow" list="tb-events" bind:value={wf.trigger.event} placeholder="agent:tool-end or agent:*" />
                  <datalist id="tb-events">
                    {#each (eventCatalog.length ? eventCatalog : eventSuggestions) as e}<option value={e.event}></option>{/each}
                  </datalist>
                </div>
              {:else if triggerExpanded && wf.trigger.type === "semantic"}
                <div class="tbar__config">
                  <input class="input input--sm tbar__grow" bind:value={wf.trigger.text} placeholder="Whenever WhatsApp returns an error" />
                  <input class="input input--sm tbar__thr" type="number" min="0" max="1" step="0.05" bind:value={wf.trigger.threshold} title="threshold" />
                </div>
              {:else if triggerExpanded && wf.trigger.type === "webhook"}
                <div class="tbar__config"><code class="tbar__code">/flows/webhook/{wf.trigger.webhookToken || "(generated after saving)"}</code></div>
              {:else if triggerExpanded && wf.trigger.type === "cron"}
                <div class="tbar__config"><CronBuilder bind:cron={wf.trigger.cron} /></div>
              {:else if triggerExpanded && wf.trigger.type === "schedule"}
                <div class="tbar__config tbar__config--col">
                  <input class="input input--sm tbar__date" type="datetime-local" value={scheduleLocalValue} on:input={onScheduleInput} />
                  {#if schedulePast}<span class="tbar__sched-note tbar__sched-note--warn">This date is in the past. It will run on the next check, then disable.</span>{/if}
                </div>
              {/if}
            </div>
            {#if !documentBus}<span class="zoomtag">{Math.round(zoom * 100)}%</span>{/if}
          </div>{/if}

          {#if linkFrom}
            <div class="linkbanner">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>
              <span>Tap the <b>destination</b> node to connect</span>
              <button class="linkbanner__x" on:click={() => (linkFrom = null)}>cancel</button>
            </div>
          {/if}

          <!-- Painel de execução: histórico persistido + etapas + log + entrada -->
          {#if showRun}
            <div class="runpanel">
              <div class="runpanel__head">
                <span class="dot dot--{stepStatusClass(lastRun ? lastRun.status : 'skipped')}"></span>
                <!-- Seletor de execuções: o histórico vem de disco, então continua
                     aqui depois de fechar o editor ou reiniciar o runtime. -->
                <select class="runpanel__pick" value={lastRun?.id || ""}
                        on:change={(e) => { const r = runHistory.find((x) => x.id === e.target.value); if (r) selectRun(r); }}>
                  {#if lastRun && !runHistory.some((r) => r.id === lastRun.id)}
                    <option value={lastRun.id}>now · {lastRun.status}</option>
                  {/if}
                  {#each runHistory as r (r.id)}
                    <option value={r.id}>{fmtRunTime(r.startedAt)} · {r.status}{r.replayOf ? " · replay" : ""}</option>
                  {/each}
                  {#if !runHistory.length && !lastRun}<option value="">no runs</option>{/if}
                </select>
                {#if lastRun}
                  <button class="runpanel__replay" class:on={replaying} on:click={() => (replaying ? stopReplay() : startReplay())} title="Play the run step by step on the graph">
                    {#if replaying}
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> stop
                    {:else}
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg> play
                    {/if}
                  </button>
                  <!-- Repetir: reexecuta com EXATAMENTE o mesmo payload de entrada. -->
                  <button class="runpanel__replay" on:click={() => replayRun(lastRun)}
                          disabled={replayingRun || lastRun.input == null}
                          title={lastRun.input == null ? "This older run has no saved payload" : "Repeat this run with the same payload"}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
                    {replayingRun ? "…" : "repeat"}
                  </button>
                {/if}
                <button class="runpanel__x" on:click={() => { stopReplay(); showRun = false; }} aria-label="Close">✕</button>
              </div>

              {#if !lastRun}
                <div class="runpanel__empty">This flow has not run yet. Use <b>Test</b> to run it with a payload.</div>
              {:else}
              <div class="runtabs">
                <button class="runtab" class:runtab--on={runTab === "steps"} on:click={() => (runTab = "steps")}>Steps</button>
                <button class="runtab" class:runtab--on={runTab === "log"} on:click={() => (runTab = "log")}>
                  Log{#if lastRun.logs?.length}<span class="runtab__count">{lastRun.logs.length}</span>{/if}
                </button>
                <button class="runtab" class:runtab--on={runTab === "input"} on:click={() => (runTab = "input")}>Input</button>
              </div>
              {#if lastRun.error}<div class="runpanel__err">{lastRun.error}</div>{/if}

              {#if runTab === "log"}
                <div class="runlog">
                  {#if !lastRun.logs?.length}
                    <p class="runlog__empty">No log lines. Older runs did not save logs; add <b>Log</b> nodes to record messages during a run.</p>
                  {:else}
                    {#each lastRun.logs as l}
                      <div class="logline logline--{l.level || 'info'}">
                        <span class="logline__ts">{fmtLogTime(l.ts)}</span>
                        {#if l.nodeName}<span class="logline__node">{l.nodeName}</span>{/if}
                        <span class="logline__msg">{l.message}</span>
                      </div>
                    {/each}
                  {/if}
                </div>
              {:else if runTab === "input"}
                <div class="runinput">
                  {#if lastRun.input == null}
                    <p class="runlog__empty">No saved payload. This run predates input recording, or its payload exceeded the size limit. Use <b>Test</b> to create a replayable run.</p>
                  {:else}
                    <pre class="io__val">{prettyJson(lastRun.input)}</pre>
                    <div class="runinput__acts">
                      <button class="chip" on:click={() => replayRun(lastRun)} disabled={replayingRun}>Repeat</button>
                      <button class="chip" on:click={() => editAndReplay(lastRun)}>Edit and run</button>
                    </div>
                  {/if}
                </div>
              {:else}
              <div class="runpanel__steps">
                {#each lastRun.nodes as st, i}
                  {@const open = expandedStep === st.id}
                  <div class="rstep-wrap" class:rstep-wrap--active={replayNodeId === st.id}>
                    <button class="rstep" class:rstep--err={st.status === "error"} class:rstep--skip={st.status === "skipped"}
                            on:click={() => { expandedStep = open ? null : st.id; selectedNodeId = st.id; focusOnNode(st.id); }}>
                      <span class="rstep__idx">{st.order != null ? st.order + 1 : "·"}</span>
                      <span class="dot dot--{stepStatusClass(st.status)}"></span>
                      <span class="rstep__name">{st.name || nodeNameOf(st.id)}</span>
                      <span class="rstep__type">{st.type}</span>
                      {#if st.durationMs != null}<span class="rstep__dur">{fmtDur(st.durationMs)}</span>{/if}
                      <span class="rstep__status rstep__status--{stepStatusClass(st.status)}">{st.status}</span>
                      <svg class="rstep__chev" class:open width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                    </button>
                    {#if open}
                      <div class="rstep__detail">
                        {#if st.error}<div class="io io--err"><span class="io__lbl">error</span><pre class="io__val">{st.error}</pre></div>{/if}
                        {#if st.input != null}<div class="io"><span class="io__lbl">input</span><pre class="io__val">{prettyJson(st.input)}</pre></div>{/if}
                        {#if st.output != null}<div class="io"><span class="io__lbl">output</span><pre class="io__val">{prettyJson(st.output)}</pre></div>{/if}
                        {#if st.status === "skipped"}<div class="io__note">Node skipped — all incoming edges were inactive.</div>{/if}
                        {#if st.input == null && st.output == null && st.status !== "skipped" && !st.error}<div class="io__note">No recorded data.</div>{/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
              {/if}
              {/if}
            </div>
          {/if}

          <div class="world" style="transform: translate({pan.x}px, {pan.y}px) scale({zoom});">
            <svg class="edges" width="6000" height="6000">
              {#each wf.edges as e (e.id)}
                <path class="edge" class:edge--true={e.fromPort === "true"} class:edge--false={e.fromPort === "false"} class:edge--err={e.fromPort === "error"} d={edgePath(e)} on:click={() => removeEdge(e.id)} />
              {/each}
              {#if connecting}
                {@const cf = wf.nodes.find((n) => n.id === connecting.from)}
                {#if cf}<path class="edge edge--live" d={bezier(outPortPos(cf, connecting.fromPort), { x: connecting.x, y: connecting.y })} />{/if}
              {/if}
              <!-- Debug: pulso da informação percorrendo as arestas que conduziram dados -->
              {#if showRun && runActiveEdges.length}
                {#each runActiveEdges as e (e.id)}
                  {@const d = edgePath({ from: e.from, to: e.to, fromPort: e.fromPort })}
                  {#if d}
                    <path class="edge edge--run" d={d} />
                    <circle class="edge-pulse" r="4.5">
                      <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
                    </circle>
                  {/if}
                {/each}
              {/if}
            </svg>

            {#each wf.nodes as n (n.id)}
              <div role="group" aria-label={n.name || nodeDef(n.type).label} class="node" class:sel={selectedNodeId === n.id}
                   class:node--linktarget={linkFrom && linkFrom.from !== n.id}
                   class:node--linksource={linkFrom && linkFrom.from === n.id}
                   class:node--error={erroredNodes.has(n.id)}
                   class:node--ran={showRun && ranNodes.has(n.id)}
                   class:node--skipped={showRun && skippedNodes.has(n.id)}
                   class:node--replay={replayNodeId === n.id}
                   data-node={n.id}
                   style="left:{n.position.x}px; top:{n.position.y}px; width:{NODE_W}px; min-height:{HEAD_H + 24 + nodePorts(n).length * 22}px;"
                   on:pointerdown={(e) => onNodePointerDown(e, n)}
                   on:dblclick|stopPropagation={() => openNodeConfig(n)}>
                <div class="node__head node__head--{n.type}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={nodeDef(n.type).icon}/></svg>
                  <span class="node__title">{n.name}</span>
                  <button class="node__cog" on:pointerdown|stopPropagation on:click|stopPropagation={() => openNodeConfig(n)} title="Configure" aria-label="Configure">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  </button>
                  {#if n.type !== "trigger"}
                    <button class="node__x" on:pointerdown|stopPropagation on:click|stopPropagation={() => removeNode(n.id)} aria-label="Remove">✕</button>
                  {/if}
                </div>
                <div class="node__body">
                  <span class="node__type">{nodeDef(n.type).label}</span>
                </div>
                {#if n.type !== "trigger" && n.type !== "agent-tool"}
                  <button type="button" aria-label={`Conectar entrada de ${n.name}`} on:click|stopPropagation={() => completeLink(n.id)} class="port port--in" class:port--pulse={linkFrom && linkFrom.from !== n.id} data-in={n.id} style="top:{HEAD_H + 16}px;"></button>
                {:else if n.type === "agent-tool"}
                  <span class="port port--in" aria-hidden="true" style="top:{HEAD_H + 16}px;"></span>
                {/if}
                {#each nodePorts(n) as p, pi}
                  <button type="button" aria-label={`Conectar saída ${p} de ${n.name}`} on:click|stopPropagation={(e) => { if (e.detail === 0) linkFrom = { from: n.id, fromPort: p }; }} class="port port--out" class:port--err={p === "error"} class:port--armed={linkFrom && linkFrom.from === n.id && (linkFrom.fromPort || 'out') === p} style="top:{HEAD_H + 16 + pi * 22}px;" on:pointerdown={(e) => onOutPortDown(e, n, p)}>
                    {#if nodePorts(n).length > 1}<span class="port__label" class:port__label--err={p === "error"}>{p}</span>{/if}
                  </button>
                {/each}
              </div>
            {/each}
          </div>

          <!-- Controles de zoom: + / − / reenquadrar (funciona no desktop e mobile) -->
          {#if !documentBus}<div class="zoomctl" on:pointerdown|stopPropagation on:wheel|stopPropagation>
            <button class="zoomctl__btn" on:click={() => zoomStep(1)} title="Zoom in" aria-label="Zoom in">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button class="zoomctl__btn" on:click={() => zoomStep(-1)} title="Zoom out" aria-label="Zoom out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>
            </button>
            <button class="zoomctl__btn zoomctl__btn--fit" on:click={fitView} title="Fit nodes on screen" aria-label="Fit nodes">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>
            </button>
          </div>{/if}
        </div>

        <!-- Inspetor -->
        <aside class="inspector" class:drawer-open={mobilePanel === "inspector"}>
          <div class="drawer-handle">
            <span class="drawer-handle__label">{selectedNode ? nodeDef(selectedNode.type).label : "Publish / inputs"}</span>
            <button class="drawer-handle__close" on:click={() => (mobilePanel = null)} aria-label="Close">✕</button>
          </div>

          <!-- Variáveis disponíveis: referência de tudo que dá para usar em {{…}} -->
          <div class="vars">
            <button aria-expanded={showVars} class="vars__toggle" on:click={() => (showVars = !showVars)}>
              <svg class="vars__chev" class:open={showVars} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              <span>Variáveis disponíveis</span>
              <span class="vars__hint">copiar {"{{…}}"}</span>
            </button>
            {#if showVars}
              <div class="vars__body">
                {#if varGroups.length === 0}
                  <p class="hint">Nothing yet — define inputs, add a <b>set</b> node, or add nodes with outputs.</p>
                {/if}
                {#each varGroups as g}
                  <div class="vars__group">
                    <span class="vars__gtitle">{g.title}</span>
                    <div class="vars__chips">
                      {#each g.items as v}
                        <button class="vartag" title={v.note} on:click={() => copyVar(v.expr)}>
                          <code>{"{{"}{v.expr}{"}}"}</code>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          {#if !selectedNode}
            <div class="inspector__empty">
              <h3 class="panel-heading">Propriedades</h3><p>Selecione um nó para configurar.</p>
              <p class="hint">Drag from a port <span class="port port--mini"></span> to connect nodes. Scroll to zoom and drag the background to pan.</p>
              <hr />
              <div class="pub-head">
                <h4>Publish as tool</h4>
                <span class="badge" class:badge--on={wf.publishAsTool}>{wf.publishAsTool ? "published" : "draft"}</span>
              </div>
              <p class="hint">Makes this flow callable as a <b>tool</b> by agents and other flows. The inputs below become tool parameters, available as <code>{"{{trigger.<name>}}"}</code>.</p>
              <div class="pub-name">
                <span class="fl" style="margin:0">Tool name</span>
                <code class="pub-name__val">{toolNamePreview}</code>
              </div>

              <div class="fl" style="display:flex;align-items:center;justify-content:space-between">
                <span>Inputs (parameters)</span>
                <span class="pub-count">{wf.inputs.length}</span>
              </div>
              {#if wf.inputs.length === 0}
                <p class="hint">No inputs — this tool runs without parameters. Add one if the flow needs values.</p>
              {/if}
              {#each wf.inputs as inp, i}
                <div class="inp-card">
                  <div class="inp-row">
                    <input class="input input--sm" bind:value={inp.name} placeholder="name" />
                    <select class="input input--sm" bind:value={inp.type}>{#each ["string", "number", "boolean", "object", "array"] as t}<option>{t}</option>{/each}</select>
                    <label class="mini-check"><input type="checkbox" bind:checked={inp.required} />req</label>
                    <button class="btn btn--icon btn--danger" on:click={() => removeInput(i)} aria-label="Remove input">✕</button>
                  </div>
                  <input class="input input--sm" bind:value={inp.description} placeholder="description (what the agent should pass)" />
                  <button class="vartag vartag--inline" title="copy reference" on:click={() => copyVar(`trigger.${inp.name}`)}>
                    <code>{"{{"}trigger.{inp.name || "…"}{"}}"}</code>
                  </button>
                </div>
              {/each}
              <button class="chip" on:click={addInput}>+ input</button>
              <p class="hint" style="margin-top:.8rem">After defining inputs, use <b>Publish</b> in the top bar. Save the flow to persist changes.</p>
            </div>
          {:else}
            <h3 class="panel-heading">Configuração</h3>
            <div class="inspector__head">
              <input class="input input--sm" bind:value={selectedNode.name} aria-label="Nome do nó" placeholder="Nome do nó" />
              <span class="badge">{nodeDef(selectedNode.type).label}</span>
            </div>

            {#if selectedNode.type === "log"}
              <label class="fl">Message</label>
              <input class="input" bind:value={selectedNode.config.message} placeholder={"Use {{trigger.foo}} / {{nodes.<id>.campo}}"} />
            {:else if selectedNode.type === "set"}
              <label class="fl">Variable</label>
              <input class="input" bind:value={selectedNode.config.key} placeholder="name" />
              <label class="fl">Value</label>
              <input class="input" bind:value={selectedNode.config.value} placeholder="value (templates supported)" />
            {:else if selectedNode.type === "script"}
              <label class="fl">Input</label>
              <input class="input input--mono" bind:value={selectedNode.config.input} placeholder={"{{trigger}} or {{nodes.<id>.output}}"} />
              <label class="fl">JavaScript</label>
              <textarea class="input input--mono" rows="10" bind:value={selectedNode.config.code} spellcheck="false" placeholder={"return { value: input.value };"}></textarea>
              <label class="fl">Timeout (ms)</label>
              <input class="input input--sm" type="number" min="50" max="5000" bind:value={selectedNode.config.timeoutMs} />
              <p class="hint">Use <code>input</code>, <code>trigger</code>, <code>vars</code> and <code>nodes</code>. Return the node output. No filesystem, network, process, require, dynamic code or packages. Console output is added to the run log.</p>
            {:else if selectedNode.type === "rules"}
              <label class="fl">Record</label>
              <input class="input input--mono" bind:value={selectedNode.config.record} placeholder={"{{trigger}} or {{nodes.<id>.output}}"} />
              <label class="fl">Rules (JSON)</label>
              <textarea class="input input--mono" rows="12" bind:value={selectedNode._rulesRaw} spellcheck="false" placeholder={'[{"id":"adult","route":"approved","conditions":{"type":"greaterThan","field":"age","value":17},"actions":[{"type":"setField","field":"approved","value":true}]}]'}></textarea>
              <p class="hint">Conditions support and, or and not. Safe actions: <code>setField</code>, <code>log</code> and <code>throw</code>. A rule route creates an output port after saving. JavaScript expressions and hidden external effects are blocked.</p>
            {:else if selectedNode.type === "http"}
              <label class="fl">Method & URL</label>
              <div class="row">
                <select class="input input--sm" bind:value={selectedNode.config.method}>{#each HTTP_METHODS as m}<option>{m}</option>{/each}</select>
                <input class="input" bind:value={selectedNode.config.url} placeholder="https://…" />
              </div>
              <label class="fl">Headers (JSON)</label>
              <textarea class="input input--mono" rows="2" bind:value={selectedNode._headersRaw} placeholder={'{"Authorization":"Bearer …"}'}></textarea>
              <label class="fl">Body</label>
              <textarea class="input input--mono" rows="2" bind:value={selectedNode._bodyRaw} placeholder="JSON ou texto"></textarea>
            {:else if selectedNode.type === "emit"}
              <label class="fl">Event</label>
              <input class="input input--mono" bind:value={selectedNode.config.event} placeholder="flows:meu-evento" />
              <label class="fl">Payload (JSON)</label>
              <textarea class="input input--mono" rows="3" bind:value={selectedNode._payloadRaw} placeholder={'{"ok":true}'}></textarea>
            {:else if selectedNode.type === "delay"}
              <label class="fl">Wait (ms)</label>
              <input class="input input--sm" type="number" min="0" max="60000" bind:value={selectedNode.config.ms} placeholder="max 60000" />
            {:else if selectedNode.type === "condition"}
              <label class="fl">Comparison</label>
              <div class="row">
                <input class="input" bind:value={selectedNode.config.left} placeholder={"valor / {{…}}"} />
                <select class="input input--sm" bind:value={selectedNode.config.op}>{#each CONDITION_OPS as op}<option>{op}</option>{/each}</select>
                <input class="input" bind:value={selectedNode.config.right} placeholder="comparar" />
              </div>
              <p class="hint">Outputs: <b>true</b> and <b>false</b>.</p>
            {:else if selectedNode.type === "switch"}
              <label class="fl">Value to compare</label>
              <input class="input" bind:value={selectedNode.config.value} placeholder={"{{trigger.status}} / {{nodes.<id>.campo}}"} />
              <label class="fl">Cases (one output per case)</label>
              {#each (selectedNode.config.cases || []) as _, i}
                <div class="row" style="margin-bottom:.35rem">
                  <input class="input" bind:value={selectedNode.config.cases[i]} placeholder={"ex.: pago"} on:input={() => (wf.nodes = wf.nodes)} />
                  <button class="btn btn--icon btn--danger" title="Remove case" on:click={() => { selectedNode.config.cases = selectedNode.config.cases.filter((_, j) => j !== i); wf.nodes = wf.nodes; }} aria-label="Remove">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                  </button>
                </div>
              {/each}
              <button class="chip" on:click={() => { selectedNode.config.cases = [...(selectedNode.config.cases || []), ""]; wf.nodes = wf.nodes; }}>+ add case</button>
              <p class="hint">Compares text equality. Each case becomes an output; everything else uses <b>default</b>.</p>
            {:else if selectedNode.type === "iterate"}
              <label class="fl">Lista (items)</label>
              <input class="input" bind:value={selectedNode.config.items} placeholder={"{{nodes.<id>.results}} ou [\"a\",\"b\"]"} />
              <label class="fl">Sub-flow por item (opcional)</label>
              <select class="input input--sm" style="width:100%" bind:value={selectedNode.config.workflowId}>
                <option value="">— pass the list through —</option>
                {#each workflowList.filter((w) => w.id !== wf.id) as w}<option value={w.id}>{w.name}</option>{/each}
              </select>
              <p class="hint">Runs the sub-flow once per item. In the sub-flow use <code>{"{{trigger.item}}"}</code> and <code>{"{{trigger.index}}"}</code>. Maximum 500 items.</p>
            {:else if selectedNode.type === "agent"}
              {#if agentProfiles.length}
                <label class="fl">Configuração</label>
                <select class="input input--sm" style="width:100%" value={selectedNode.config.profile?.sourceRef?.id || ""} on:change={(e) => applyAgentProfile(selectedNode, agentProfiles.find((p) => p.id === e.currentTarget.value))}>
                  <option value="">Manual</option>
                  {#each agentProfiles as profile}<option value={profile.id}>{profile.name}</option>{/each}
                </select>
                {#if selectedNode.config.profile}<p class="hint">Baseado em {selectedNode.config.profile.name}, personalizado neste Flow. O snapshot não sincroniza automaticamente.</p>{/if}
              {/if}
              <label class="fl">Modo</label>
              <div class="segmented segmented--full">
                <button class="seg" class:seg--on={agentMode === "simple"} on:click={() => setAgentMode(selectedNode, "simple")}>Simple call</button>
                <button class="seg" class:seg--on={agentMode === "agent"} on:click={() => setAgentMode(selectedNode, "agent")}>Agent + tools</button>
              </div>
              <p class="hint">{agentMode === "simple" ? "One LLM call with no tools or extra turns. Direct response." : "Tool-calling loop: the LLM can use tools over multiple turns."}</p>

              <label class="fl">{agentMode === "simple" ? "Prompt" : "Goal"}</label>
              <textarea class="input" rows="3" bind:value={selectedNode.config.goal} placeholder={"O que o LLM deve fazer — {{trigger.texto}}"}></textarea>
              <label class="fl">Contexto adicional (opcional)</label>
              <textarea class="input" rows="3" bind:value={selectedNode.config.additionalPrompt} placeholder={"Dados de outro nó: {{nodes.<id>.result}}"}></textarea>
              <p class="hint">Anexa saídas de Tools ou outros nós ao prompt, identificadas como dados e não como instruções.</p>
              <label class="fl">System (opcional)</label>
              <textarea class="input" rows="2" bind:value={selectedNode.config.system} placeholder="persona / regras"></textarea>

              <label class="fl">Model routing</label>
              <div class="segmented segmented--full">
                <button class="seg" class:seg--on={agentRoute === "auto"} on:click={() => setAgentRoute(selectedNode, "auto")}>Automatic</button>
                <button class="seg" class:seg--on={agentRoute === "model"} on:click={() => setAgentRoute(selectedNode, "model")}>Model</button>
              </div>
              {#if agentRoute === "auto"}
                <p class="hint">The runtime chooses a compatible access based on capabilities and evidence.</p>
              {:else}
                <input class="input input--mono" list="llm-models" bind:value={selectedNode.config.model} placeholder="ex.: ada-flash, anthropic/claude-sonnet-4.5" />
                <datalist id="llm-models">
                  {#each llmOpts.elms as e}<option value={e.id}>{e.tier} · {e.description}</option>{/each}
                  {#each llmOpts.models as m}<option value={m}></option>{/each}
                </datalist>
                <p class="hint">Escreva qualquer id de modelo. {#if llmOpts.providers.length}Providers ativos: <b>{llmOpts.providers.join(", ")}</b>.{/if}</p>
              {/if}

              {#if agentMode === "agent"}
                <label class="fl">Max. steps</label>
                <input class="input input--sm" style="width:100%" type="number" min="1" max="50" bind:value={selectedNode.config.maxSteps} placeholder="auto (8)" />
                <label class="fl">Tools</label>
                {#if agentToolNames.length}
                  <div class="toolsel">
                    {#each agentToolNames as name (name)}
                      {@const meta = toolCatalog.find((t) => t.name === name)}
                      <button class="toolchip" title={meta?.description || name} on:click={() => toggleAgentTool(selectedNode, name)}>
                        <span class="toolchip__name">{name}</span>
                        {#if meta?.package}<span class="toolchip__pkg">{meta.package}</span>{/if}
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                      </button>
                    {/each}
                  </div>
                {/if}
                <div class="row" style="margin-top:.35rem">
                  <button class="btn btn--sm" style="flex:1" on:click={openToolPicker}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg>
                    {agentToolNames.length ? `Tool catalog (${agentToolNames.length})` : "Choose from catalog"}
                  </button>
                  {#if agentToolNames.length}
                    <button class="btn btn--sm btn--danger" title="Clear selection and use auto-select" on:click={() => setAgentTools(selectedNode, [])}>Clear</button>
                  {/if}
                </div>
                <p class="hint">
                  {#if agentToolNames.length}
                    The agent will only see these {agentToolNames.length} {agentToolNames.length === 1 ? "tool" : "tools"}.
                  {:else}
                    No tools selected: Agent chooses relevant tools for each run based on the goal, plus built-ins. Select manually only to keep the agent within a fixed set.
                  {/if}
                </p>
                <label class="fl">Output schema JSON (opcional)</label>
                <textarea class="input input--mono" rows="2" bind:value={selectedNode._outputSchemaRaw} placeholder={'{"type":"object","properties":{…}}'}></textarea>
              {/if}
            {:else if selectedNode.type === "classifier"}
              <label class="fl">Intenção a classificar</label>
              <textarea class="input" rows="3" bind:value={selectedNode.config.intent} placeholder={"{{nodes.<id>.result}}"}></textarea>
              <label class="fl">Candidatas (JSON)</label>
              <textarea class="input input--mono" rows="5" bind:value={selectedNode._candidatesRaw} placeholder={'[{"name":"desta-casa","description":"Assunto imobiliário"}]'}></textarea>
              <label class="fl">Fallback seguro</label>
              <input class="input input--mono" bind:value={selectedNode.config.fallback} placeholder="desta-casa" />
              <label class="fl">Confiança mínima (0 a 1)</label>
              <input class="input input--sm" type="number" min="0" max="1" step="0.05" bind:value={selectedNode.config.minConfidence} />
              <p class="hint">Usa Jev e, em falha, Laya quando configurados. Se não houver decisão válida, devolve o fallback. Saída: <code>{"{{nodes.&lt;id&gt;.choice}}"}</code>.</p>
            {:else if selectedNode.type === "agent-tool"}
              <label class="fl">Tool Binding</label>
              <p class="hint"><b>{selectedNode.config.toolName}</b>{selectedNode.config.package ? ` · ${selectedNode.config.package}` : ""}. A tool só roda quando o Agent solicitar.</p>
              {#if selectedBindingTool?.params?.length}
                {#each selectedBindingTool.params as p (p.key)}
                  <label class="fl">{p.key}{p.required ? " *" : ""}</label>
                  <div class="segmented segmented--full">
                    <button class="seg" class:seg--on={(selectedNode.config.argModes?.[p.key] || "ai") === "ai"} on:click={() => setBindingMode(selectedNode, p.key, "ai")}>IA</button>
                    <button class="seg" class:seg--on={selectedNode.config.argModes?.[p.key] === "fixed"} on:click={() => setBindingMode(selectedNode, p.key, "fixed")}>Fixo</button>
                  </div>
                  {#if selectedNode.config.argModes?.[p.key] === "fixed"}
                    {#if p.type === "checkbox"}
                      <label class="mini-check"><input type="checkbox" checked={selectedNode.config.args?.[p.key] === true} on:change={(e) => setBindingArg(selectedNode, p.key, e.currentTarget.checked)} /> Valor fixo</label>
                    {:else}
                      <input class="input" value={selectedNode.config.args?.[p.key] ?? ""} on:input={(e) => setBindingArg(selectedNode, p.key, p.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value)} placeholder={p.placeholder || p.key} />
                    {/if}
                  {:else}<p class="hint">A IA pode preencher este parâmetro. Parâmetros opcionais podem ficar ausentes.</p>{/if}
                {/each}
              {:else}<p class="hint">Schema indisponível. Reabra o catálogo ou remova e adicione a tool novamente.</p>{/if}
            {:else if selectedNode.type === "session-message"}
              <label class="fl">Session (sessionId)</label>
              <input class="input input--mono" bind:value={selectedNode.config.sessionId} placeholder={"default or {{trigger.sessionId}}"} />
              <label class="fl">Message</label>
              <textarea class="input" rows="3" bind:value={selectedNode.config.message} placeholder={"Text — supports {{nodes.<id>.text}}"}></textarea>
              <label class="fl">Appear as</label>
              <div class="segmented segmented--full">
                <button class="seg" class:seg--on={(selectedNode.config.role || 'assistant') === 'assistant'} on:click={() => { selectedNode.config.role = 'assistant'; wf.nodes = wf.nodes; }}>Assistant</button>
                <button class="seg" class:seg--on={selectedNode.config.role === 'user'} on:click={() => { selectedNode.config.role = 'user'; wf.nodes = wf.nodes; }}>User</button>
              </div>
              <p class="hint">Delivers to the session chat in real time and persists it. Use <code>{"{{trigger.sessionId}}"}</code> to reply in the session that triggered this flow.</p>
            {:else if selectedNode.type === "sub-flow"}
              <label class="fl">Flow to run</label>
              <select class="input input--sm" style="width:100%" bind:value={selectedNode.config.workflowId}>
                <option value="">— choose a flow —</option>
                {#each workflowList.filter((w) => w.id !== wf.id) as w}<option value={w.id}>{w.name}</option>{/each}
              </select>
              {#if selectedNode.config.workflowId}
                <button class="btn btn--sm" style="margin-top:.5rem;width:100%" on:click={() => openSubflow(selectedNode.config.workflowId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                  Open this flow
                </button>
              {/if}
              <button class="chip" style="margin-top:.5rem" on:click={() => createSubflow(selectedNode)}>+ create sub-flow</button>
              <p class="hint">Creates a flow, saves this draft, and opens the new one. The ◂ button returns here.</p>
            {:else if selectedNode.type === "tool"}
              <label class="fl">Tool</label>
              <div class="tool-tag"><code>{selectedNode.config.package}:{selectedNode.config.name}</code></div>
              {#if selectedTool}
                {#if selectedTool.description}<p class="hint">{selectedTool.description}</p>{/if}
                {#each selectedTool.params as p}
                  <label class="fl">{p.key}{#if p.required}<span class="req">*</span>{/if}</label>
                  {#if p.type === "checkbox"}
                    <label class="mini-check"><input type="checkbox" checked={!!argValue(p.key)} on:change={(e) => setArg(p.key, e.target.checked)} /> {p.description}</label>
                  {:else if p.enum || enumOptions[p.enumSource]}
                    <select class="input input--sm" value={argValue(p.key)} on:change={(e) => setArg(p.key, e.target.value)}>
                      <option value="">—</option>{#each (p.enum || enumOptions[p.enumSource]) as opt}<option>{opt}</option>{/each}
                    </select>
                  {:else if p.enumSource}
                    <input class="input" value={argValue(p.key)} on:input={(e) => setArg(p.key, e.target.value)} placeholder={p.placeholder} />
                    <p class="hint">{enumPending[p.enumSource] ? "Loading options…" : "Options are unavailable — enter a value."}</p>
                  {:else if p.type === "textarea"}
                    <textarea class="input input--mono" rows="2" value={argValue(p.key)} on:input={(e) => setArg(p.key, e.target.value)} placeholder={p.placeholder}></textarea>
                  {:else if p.type === "number"}
                    <input class="input input--sm" type="number" value={argValue(p.key)} on:input={(e) => setArg(p.key, e.target.value)} placeholder={p.placeholder} />
                  {:else}
                    <input class="input" value={argValue(p.key)} on:input={(e) => setArg(p.key, e.target.value)} placeholder={p.placeholder} />
                  {/if}
                {/each}
              {:else}
                <label class="fl">Argumentos (JSON)</label>
                <textarea class="input input--mono" rows="4" bind:value={selectedNode._argsRaw} placeholder={'{"campo":"valor / {{trigger.x}}"}'}></textarea>
                <p class="hint">Schema indisponível — passe os argumentos como JSON. Aceita <code>{"{{…}}"}</code>.</p>
              {/if}
            {/if}

            {#if selectedNode.type !== "trigger"}
              <div class="inspector__foot">
                <button class="btn btn--danger" on:click={() => removeNode(selectedNode.id)}>Remove node</button>
              </div>
            {:else}
              <div class="inspector__foot"><span class="inspector__note">The trigger starts the flow and is permanent.</span></div>
            {/if}
          {/if}
        </aside>

        <!-- Barra de ações mobile: abre paleta / inspetor como bottom-sheets -->
        <nav class="mobilebar">
          <button class="mbtn" class:mbtn--on={mobilePanel === "palette"} on:click={() => (mobilePanel = mobilePanel === "palette" ? null : "palette")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            Node
          </button>
          <button class="mbtn" class:mbtn--on={mobilePanel === "inspector"} class:mbtn--hint={selectedNode && mobilePanel !== "inspector"} on:click={() => (mobilePanel = mobilePanel === "inspector" ? null : "inspector")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            {selectedNode ? "Configure" : "Publish"}
          </button>
        </nav>
      </div>
  {/if}
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,400&family=Ubuntu+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .ed[data-theme="dark"] { --tk-bg:#111111;--tk-surface:#181818;--tk-surface-2:#1f1f1f;--tk-border:rgba(255,255,255,.09);--tk-border-hi:rgba(255,255,255,.16);--tk-text:#f5f5f5;--tk-muted:#888888;--tk-muted-2:rgba(136,136,136,.5);--tk-accent:#f5f5f5;--tk-on-accent:#111111;--tk-radius-md:8px;--tk-radius-lg:14px;--tk-font:'Ubuntu',system-ui,sans-serif;--tk-mono:'Ubuntu Mono',monospace; }
  .ed[data-theme="light"] { --tk-bg:#ffffff;--tk-surface:#f5f5f5;--tk-surface-2:#ececec;--tk-border:rgba(0,0,0,.10);--tk-border-hi:rgba(0,0,0,.18);--tk-text:#1a1a1a;--tk-muted:#666666;--tk-muted-2:rgba(0,0,0,.4);--tk-accent:#111111;--tk-on-accent:#ffffff;--tk-radius-md:8px;--tk-radius-lg:14px;--tk-font:'Ubuntu',system-ui,sans-serif;--tk-mono:'Ubuntu Mono',monospace; }
  .ed { font-family:var(--tk-font); --bg:var(--tk-bg);--surface:var(--tk-surface);--surface-2:var(--tk-surface-2);--border:var(--tk-border);--text:var(--tk-text);--muted:var(--tk-muted);--accent:var(--tk-accent);--accent-weak:var(--tk-surface-2);--danger:var(--tk-text);--success:var(--tk-text);--warn:var(--tk-muted);--shadow:0 2px 8px rgba(0,0,0,.08);--mono:var(--tk-mono); }
  :global(html), :global(body) { margin: 0; width:100%; height:100%; overflow:hidden; background: var(--tk-bg); color: var(--tk-text); font-family: var(--tk-font); -webkit-font-smoothing: antialiased; }

  .ed { width:100%; height:100dvh; min-height:0; overflow:hidden; display: flex; flex-direction: column; background:var(--bg); color:var(--text); }
  .ed--compact { min-height:0; height:100%; }
  .ed--compact .workbench { grid-template-columns:minmax(0,1fr); height:calc(100% - 53px); }
  .ed--compact .palette,.ed--compact .inspector { display:none; }
  .ed--direct-canvas { background:transparent; }
  .ed--direct-canvas .workbench { position:relative; height:100%; }
  .ed--direct-canvas .canvas { background:transparent; }
  .ed--direct-canvas .palette { display:flex; position:absolute; z-index:30; top:12px; left:12px; width:220px; max-height:calc(100% - 24px); border:1px solid var(--border); border-radius:var(--tk-radius-lg); background:var(--surface); box-shadow:var(--shadow); }
  .ed--direct-canvas .inspector { display:block; position:absolute; z-index:30; top:12px; right:12px; width:min(340px, calc(100% - 24px)); max-height:calc(100% - 24px); border:1px solid var(--border); border-radius:var(--tk-radius-lg); box-shadow:var(--shadow); }
  .ed--direct-canvas .inspector:not(:has(.inspector__head)) { display:none; }

  /* O Desktop monta estas três superfícies como widgets independentes. Cada
     iframe continua transparente fora da sua superfície e o canvas não carrega
     painéis próprios disfarçados de uma tela completa. */
  .ed--widget-canvas .workbench { display:block; height:100%; }
  .ed--widget-canvas .canvas { width:100%; height:100%; }
  .ed--widget-canvas .palette,.ed--widget-canvas .inspector,.ed--widget-canvas .mobilebar { display:none; }
  .ed--widget-catalog .workbench,.ed--widget-properties .workbench { display:block; height:100%; }
  .ed--widget-catalog .canvas,.ed--widget-catalog .inspector,.ed--widget-catalog .mobilebar { display:none; }
  .ed--widget-properties .canvas,.ed--widget-properties .palette,.ed--widget-properties .mobilebar { display:none; }
  .ed--widget-catalog .palette,.ed--widget-properties .inspector { position:static; display:flex; width:auto; max-height:none; height:100%; box-sizing:border-box; border-radius:var(--tk-radius-lg); }
  .ed--widget-properties .inspector { display:block; }

  .document-title { position:fixed; z-index:40; top:14px; left:58px; width:min(300px,calc(100vw - 80px)); height:34px; box-sizing:border-box; border:1px solid transparent; border-radius:var(--tk-radius-md); background:transparent; color:var(--tk-text); font:500 15px var(--tk-font); padding:4px 8px; }
  .document-title:hover,.document-title:focus { background:var(--tk-surface); border-color:var(--tk-border-hi); outline:none; }
  .ed--widget-trigger .palette,.ed--widget-trigger .inspector,.ed--widget-trigger .mobilebar,.ed--widget-trigger .world,.ed--widget-controls .workbench,.ed--widget-controls .mobilebar { display:none; }
  .ed--widget-trigger .workbench { display:block; height:100%; }
  .ed--widget-trigger .canvas { width:100%; height:100%; }
  .ed--widget-trigger .canvas__triggerbar { position:static; padding:4px; }
  .ed--widget-trigger .tbar { width:100%; box-sizing:border-box; }
  .ed--widget-trigger .canvas { overflow:auto; }
  .ed--widget-controls .topbar { flex-wrap:wrap; border:1px solid var(--tk-border); border-radius:var(--tk-radius-lg); }
  .topbar { display: flex; align-items: center; gap: .5rem; padding: .6rem .9rem; border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 20; }
  .mobile-actions { display:none; position:relative; }
  .control-group { display:flex; align-items:center; gap:.6rem; padding-right:.65rem; border-right:1px solid var(--border); }
  .flow-enabled { display:inline-flex; align-items:center; gap:.35rem; font-size:.78rem; white-space:nowrap; cursor:pointer; }
  .flow-enabled input { accent-color:var(--accent); }
  .panel-heading { margin:.9rem 0 .65rem; font-size:.75rem; color:var(--muted); font-weight:600; }
  .topbar .btn--primary { background:var(--tk-accent); color:var(--tk-on-accent); border-color:var(--tk-accent); }
  .topbar :is(button,input):focus-visible,.vars__toggle:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .topbar__spacer { flex: 1; }
  .save-state { color:var(--muted); font:400 .68rem var(--mono); white-space:nowrap; }
  .save-state--busy { color:var(--text); }
  .title-input { border: 1px solid transparent; background: transparent; color: var(--text); font-size: 1rem; font-weight: 600; padding: .3rem .5rem; border-radius: .4rem; min-width: 120px; }
  .title-input:hover { border-color: var(--border); }
  .title-input:focus { outline: none; border-color: var(--accent); background: var(--surface); }

  .btn { display: inline-flex; align-items: center; gap: .35rem; padding: .45rem .8rem; border: 1.5px solid var(--border); border-radius: .5rem; background: transparent; color: var(--text); font-size: .85rem; font-weight: 500; cursor: pointer; transition: all 180ms ease; white-space: nowrap; }
  .btn:hover { border-color: var(--muted); }
  .btn--primary { background: var(--surface-2); font-weight: 600; }
  .btn--primary:hover { border-color: var(--accent); }
  .btn--ghost { border-color: transparent; color: var(--muted); padding: .45rem .55rem; }
  .btn--on { color: var(--accent); border-color: var(--accent); background: var(--accent-weak); }
  .btn--danger:hover { color: var(--danger); border-color: var(--danger); }
  .btn--icon { padding: .25rem; border-color: transparent; color: var(--muted); line-height: 1; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn--compact svg { flex-shrink: 0; }

  .loading { padding: 3rem; text-align: center; color: var(--muted); }

  .workbench { flex: 1; display: grid; grid-template-columns: 232px 1fr 300px; min-height: 0; height: calc(100dvh - 53px); }

  /* Paleta */
  .palette { border-right: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
  .palette__search { padding: .6rem; border-bottom: 1px solid var(--border); }
  .palette__scroll { overflow-y: auto; padding: .5rem; flex: 1; }
  .pgroup { margin-bottom: .9rem; }
  .pgroup__title { display: block; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin: .2rem .2rem .4rem; }
  .pgroup__head { display: flex; align-items: center; justify-content: space-between; }
  .pgroup__head .pgroup__title { margin-bottom: .4rem; }
  .pgroup__count { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .62rem; background: var(--accent-weak); color: var(--accent); padding: .02rem .3rem; border-radius: .3rem; margin-left: .2rem; }
  .pgroup__reload { border: none; background: none; color: var(--muted); cursor: pointer; padding: .1rem; line-height: 0; border-radius: .3rem; }
  .pgroup__reload:hover:not(:disabled) { color: var(--accent); }
  .pgroup__reload:disabled { opacity: .5; cursor: default; }
  .pgroup__reload .spin { animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .pgroup__error { display: flex; flex-direction: column; gap: .4rem; font-size: .74rem; color: var(--danger); padding: .3rem .2rem; }
  .pgroup__sub { display: block; font-size: .68rem; color: var(--muted); font-family: var(--mono, 'Ubuntu Mono', monospace); margin: .4rem .2rem .2rem; opacity: .8; }
  .pgroup__empty { font-size: .75rem; color: var(--muted); padding: .2rem; }
  .pitem { width: 100%; display: flex; align-items: center; gap: .5rem; padding: .4rem .5rem; border: 1px solid transparent; border-radius: .45rem; background: transparent; color: var(--text); font-size: .82rem; cursor: grab; text-align: left; transition: all 150ms ease; }
  .pitem:hover { background: var(--surface-2); border-color: var(--border); }
  .pitem__mono { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pitem--ev { justify-content: space-between; }
  .pitem__ic { flex-shrink: 0; }

  .palette__hint { font-size: .7rem; color: var(--muted); margin: 0 .2rem .6rem; line-height: 1.35; }

  /* Sanfona de tools por pacote */
  .pkgacc { border-radius: .45rem; margin-bottom: .15rem; }
  .pkgacc__head { width: 100%; display: flex; align-items: center; gap: .5rem; padding: .35rem .45rem; border: 1px solid transparent; border-radius: .45rem; background: transparent; color: var(--text); cursor: pointer; text-align: left; transition: all 150ms ease; }
  .pkgacc__head:hover { background: var(--surface-2); border-color: var(--border); }
  .pkgacc--open > .pkgacc__head { background: var(--surface-2); }
  .pkgacc__icon { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
  .pkgacc__ava { width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; display: inline-grid; place-items: center; font-size: .64rem; font-weight: 700; color: var(--muted); background: var(--accent-weak); }
  .pkgacc__name { flex: 1; min-width: 0; font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .74rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkgacc__count { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .6rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); padding: .02rem .3rem; border-radius: .3rem; }
  .pkgacc__chev { color: var(--muted); flex-shrink: 0; transition: transform 160ms ease; }
  .pkgacc__chev.open { transform: rotate(90deg); }
  .pkgacc__body { padding: .1rem 0 .2rem .55rem; margin-left: .3rem; border-left: 1px solid var(--border); }
  .pitem--tool { align-items: flex-start; }
  .pitem__body { display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
  .pitem__desc { font-size: .68rem; color: var(--muted); line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .inspector__note { font-size: .74rem; color: var(--muted); font-style: italic; }
  .pill { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .64rem; background: var(--accent-weak); color: var(--accent); padding: .05rem .35rem; border-radius: .3rem; flex-shrink: 0; }

  /* Canvas */
  .canvas { position: relative; overflow: hidden; background:
      radial-gradient(circle, color-mix(in srgb, var(--muted) 22%, transparent) 1px, transparent 1px);
    background-size: 22px 22px; cursor: grab; touch-action: none; }
  .canvas:active { cursor: grabbing; }
  .canvas__triggerbar { position: absolute; top: .6rem; left: .6rem; right: .6rem; z-index: 30; display: flex; align-items: flex-start; gap: .5rem; pointer-events: none; }
  .canvas__triggerbar > :global(*) { pointer-events: auto; }
  .zoomtag { margin-left: auto; font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .7rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: .4rem; padding: .2rem .45rem; }

  /* Controles de zoom flutuantes — sutis, canto inferior direito */
  .zoomctl { position: absolute; right: .7rem; bottom: .7rem; z-index: 9; display: flex; flex-direction: column; gap: .25rem; background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid var(--border); border-radius: .6rem; padding: .25rem; box-shadow: var(--shadow); backdrop-filter: blur(6px); }
  .zoomctl__btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: .4rem; background: transparent; color: var(--muted); cursor: pointer; transition: all 150ms ease; }
  .zoomctl__btn:hover { background: var(--surface-2); color: var(--text); }
  .zoomctl__btn:active { transform: scale(.92); }
  .zoomctl__btn--fit { color: var(--accent); border-top: 1px solid var(--border); border-radius: 0 0 .4rem .4rem; margin-top: .1rem; padding-top: .1rem; }

  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
  .edge { fill: none; stroke: var(--muted); stroke-width: 2; pointer-events: stroke; cursor: pointer; opacity: .7; }
  .edge:hover { stroke: var(--danger); opacity: 1; }
  .edge--true { stroke: var(--success); }
  .edge--false { stroke: var(--warn); }
  .edge--err { stroke: var(--danger); stroke-dasharray: 4 4; }
  .danger-txt { color: var(--danger); }
  .edge--live { stroke: var(--accent); stroke-dasharray: 5 4; }
  /* Debug: aresta que conduziu dados + traço fluindo no sentido do fluxo. */
  .edge--run { stroke: var(--accent); stroke-width: 2.5; opacity: .9; stroke-dasharray: 6 6; animation: edgeflow 700ms linear infinite; pointer-events: none; }
  @keyframes edgeflow { to { stroke-dashoffset: -12; } }
  .edge-pulse { fill: var(--accent); filter: drop-shadow(0 0 4px var(--accent)); pointer-events: none; }
  @media (prefers-reduced-motion: reduce) {
    .edge--run { animation: none; }
    .edge-pulse { display: none; }
  }

  .node { position: absolute; background: var(--surface); border: 1.5px solid var(--border); border-radius: .55rem; box-shadow: var(--shadow); user-select: none; }
  .node.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak), var(--shadow); }
  .node__head { display: flex; align-items: center; gap: .4rem; padding: .45rem .55rem; border-bottom: 1px solid var(--border); cursor: grab; border-radius: .5rem .5rem 0 0; }
  .node__head--trigger { color: var(--accent); }
  .node__head--condition { color: var(--warn); }
  .node__head--tool, .node__head--agent { color: var(--accent); }
  .node__title { flex: 1; font-size: .82rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node__cog, .node__x { border: none; background: none; color: var(--muted); cursor: pointer; padding: 0 .1rem; line-height: 0; display: inline-flex; align-items: center; }
  .node__cog:hover { color: var(--accent); }
  .node__x { font-size: .8rem; padding: 0 .15rem; }
  .node__x:hover { color: var(--danger); }
  .node__body { padding: .4rem .55rem .55rem; }
  .node__type { font-size: .7rem; color: var(--muted); }
  /* Modo "tocar p/ ligar" */
  .node--linktarget { cursor: pointer; border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
  .node--linktarget:hover { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak), var(--shadow); }
  .node--linksource { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .node--error { border-color: var(--danger); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 22%, transparent), var(--shadow); }
  .node--ran { border-color: color-mix(in srgb, var(--success) 55%, var(--border)); }
  .node--skipped { opacity: .5; }
  .node--replay { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak), 0 0 16px color-mix(in srgb, var(--accent) 45%, transparent); animation: replaypulse 850ms ease-in-out infinite; }
  @keyframes replaypulse { 0%,100% { box-shadow: 0 0 0 3px var(--accent-weak), 0 0 12px color-mix(in srgb, var(--accent) 35%, transparent); } 50% { box-shadow: 0 0 0 3px var(--accent-weak), 0 0 22px color-mix(in srgb, var(--accent) 60%, transparent); } }

  .port { padding:0; position: absolute; width: 13px; height: 13px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); cursor: crosshair; z-index: 3; }
  .port--in { left: -7px; }
  .port--out { right: -7px; }
  .port--out:hover, .port--in:hover { background: var(--accent); }
  .port--armed { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-weak); }
  .port--pulse { background: var(--accent); animation: portpulse 1.2s ease-in-out infinite; }
  .port--err { border-color: var(--danger); }
  .port--err:hover { background: var(--danger); }
  .port__label--err { color: var(--danger); }
  @keyframes portpulse { 0%,100% { box-shadow: 0 0 0 0 var(--accent-weak); } 50% { box-shadow: 0 0 0 6px transparent; } }
  .port__label { position: absolute; left: 16px; top: -3px; font-size: .6rem; color: var(--muted); font-family: var(--mono, 'Ubuntu Mono', monospace); }
  .port--mini { display: inline-block; position: static; width: 9px; height: 9px; vertical-align: middle; }

  /* Banner do modo ligar */
  .linkbanner { position: absolute; top: 3.2rem; left: 50%; transform: translateX(-50%); z-index: 9; display: flex; align-items: center; gap: .5rem; background: var(--accent); color: var(--tk-on-accent); padding: .4rem .7rem; border-radius: 999px; font-size: .8rem; font-weight: 600; box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 45%, transparent); }
  .linkbanner b { font-weight: 800; }
  .linkbanner__x { border: none; background: rgba(255,255,255,.22); color: #fff; border-radius: 999px; padding: .12rem .5rem; font-size: .72rem; cursor: pointer; font-weight: 600; }
  .linkbanner__x:hover { background: rgba(255,255,255,.35); }

  /* Entrada manual de tool (fallback) */
  .manualtool { display: flex; gap: .35rem; margin-top: .5rem; }
  .manualtool .input { flex: 1; min-width: 0; }
  .pgroup__hint { font-size: .7rem; color: var(--muted); margin: .35rem .2rem 0; line-height: 1.35; }

  /* Painel de execução / debug */
  .dot { width: .6rem; height: .6rem; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
  .dot--ok { background: var(--success); }
  .dot--error { background: var(--danger); }
  .dot--warn { background: var(--warn); }
  .dot--muted { background: var(--muted); }
  .runpanel { position: absolute; right: .7rem; bottom: .7rem; z-index: 10; width: min(360px, calc(100% - 1.4rem)); max-height: 46dvh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: .6rem; box-shadow: 0 10px 34px rgba(0,0,0,.28); overflow: hidden; }
  .runpanel__head { flex-shrink: 0; display: flex; align-items: center; gap: .45rem; padding: .5rem .6rem; border-bottom: 1px solid var(--border); font-size: .82rem; font-weight: 600; }
  .runpanel__title { flex: 1; }
  .runpanel__x { border: none; background: none; color: var(--muted); cursor: pointer; font-size: .8rem; }
  .runpanel__x:hover { color: var(--text); }
  .runpanel__err { flex-shrink: 0; padding: .45rem .6rem; font-size: .76rem; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  .runpanel__steps { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .3rem; display: flex; flex-direction: column; gap: .2rem; }
  .runpanel__replay { display: inline-flex; align-items: center; gap: .25rem; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: .35rem; padding: .18rem .4rem; font: inherit; font-size: .7rem; font-weight: 600; cursor: pointer; }
  .runpanel__replay:hover { border-color: var(--accent); }
  .runpanel__replay.on { color: var(--accent); border-color: var(--accent); }
  .runpanel__replay:disabled { opacity: .45; cursor: not-allowed; }
  /* Seletor de execuções passadas — ocupa o lugar do antigo título fixo. */
  .runpanel__pick { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: .35rem; padding: .18rem .3rem; font: inherit; font-size: .72rem; font-weight: 600; }
  .runpanel__empty { padding: .7rem .6rem; font-size: .76rem; color: var(--muted); }

  .runtabs { flex-shrink: 0; display: flex; gap: .15rem; padding: .3rem .35rem 0; border-bottom: 1px solid var(--border); }
  .runtab { border: none; background: none; color: var(--muted); font: inherit; font-size: .74rem; font-weight: 600; padding: .3rem .5rem; border-bottom: 2px solid transparent; cursor: pointer; }
  .runtab:hover { color: var(--text); }
  .runtab--on { color: var(--text); border-bottom-color: var(--accent); }
  .runtab__count { margin-left: .25rem; font-size: .62rem; color: var(--muted); }

  /* Log do run: linha do tempo textual (mensagens do nó Log, erros, início/fim). */
  .runlog { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .35rem; display: flex; flex-direction: column; gap: .1rem; font-family: var(--mono); font-size: .7rem; }
  .runlog__empty { margin: .5rem .3rem; font-family: inherit; font-size: .74rem; color: var(--muted); }
  .logline { display: flex; gap: .4rem; padding: .18rem .3rem; border-radius: .3rem; overflow-wrap: anywhere; }
  .logline:hover { background: var(--surface-2); }
  .logline__ts { color: var(--muted); flex-shrink: 0; }
  .logline__node { color: var(--accent); flex-shrink: 0; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logline__msg { flex: 1; min-width: 0; white-space: pre-wrap; }
  .logline--error { color: var(--danger); background: color-mix(in srgb, var(--danger) 7%, transparent); }
  .logline--warn { color: var(--warn); }

  .runinput { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .45rem; display: flex; flex-direction: column; gap: .4rem; }
  .runinput__acts { display: flex; gap: .35rem; flex-wrap: wrap; }

  /* Painel Testar (modal): payload do gatilho preenchível antes de executar. */
  .modal { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.45); }
  .testsheet { width: min(520px, 100%); max-height: min(80dvh, 640px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: .7rem; box-shadow: 0 18px 50px rgba(0,0,0,.35); overflow: hidden; }
  .testsheet__head { display: flex; align-items: center; gap: .45rem; padding: .6rem .7rem; border-bottom: 1px solid var(--border); font-size: .85rem; font-weight: 700; }
  .testsheet__title { flex: 1; }
  .testsheet__body { overflow-y: auto; padding: .7rem; display: flex; flex-direction: column; gap: .6rem; }
  .testsheet__ctx { margin: 0; font-size: .76rem; color: var(--muted); display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
  .testsheet__ctx code { font-family: var(--mono); color: var(--text); }
  .testsheet__err { margin: 0; font-size: .74rem; color: var(--danger); }
  .testsheet__foot { display: flex; align-items: center; gap: .4rem; padding: .55rem .7rem; border-top: 1px solid var(--border); background: var(--surface-2); }
  .testjson { width: 100%; resize: vertical; }
  .testfields { display: flex; flex-direction: column; gap: .55rem; }
  .tfield { display: flex; flex-direction: column; gap: .2rem; }
  .tfield__lbl { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; font-size: .74rem; }
  .tfield__lbl code { font-family: var(--mono); font-weight: 700; color: var(--text); }
  .tfield__type { font-size: .64rem; color: var(--muted); font-family: var(--mono); }
  .tfield__req { font-size: .62rem; color: var(--warn); font-weight: 700; }
  .tfield__desc { font-size: .7rem; color: var(--muted); }
  .tfield__check { display: inline-flex; align-items: center; gap: .35rem; font-size: .76rem; font-family: var(--mono); color: var(--muted); }
  .tag { font-size: .62rem; font-weight: 700; padding: .1rem .35rem; border-radius: .3rem; background: var(--accent-weak); color: var(--text); }
  .tag--weak { background: var(--surface-2); color: var(--muted); font-weight: 600; }
  .btn__count { margin-left: .25rem; font-size: .62rem; opacity: .7; }
  .segmented--sm .seg { font-size: .72rem; padding: .22rem .55rem; }

  .rstep-wrap { border-radius: .4rem; border: 1px solid transparent; transition: box-shadow 160ms ease; }
  .rstep-wrap--active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .rstep { display: flex; align-items: center; gap: .4rem; width: 100%; padding: .35rem .45rem; border: none; border-radius: .4rem; background: transparent; color: var(--text); cursor: pointer; text-align: left; font-size: .78rem; }
  .rstep:hover { background: var(--surface-2); }
  .rstep--err { background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .rstep--skip { opacity: .55; }
  .rstep__idx { flex-shrink: 0; width: 1.15rem; height: 1.15rem; display: inline-grid; place-items: center; font-family: var(--mono); font-size: .64rem; color: var(--muted); background: var(--surface-2); border-radius: .3rem; }
  .rstep__name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .rstep__type { font-family: var(--mono); font-size: .64rem; color: var(--muted); flex-shrink: 0; }
  .rstep__dur { font-family: var(--mono); font-size: .64rem; color: var(--muted); flex-shrink: 0; }
  .rstep__status { font-family: var(--mono); font-size: .64rem; color: var(--muted); flex-shrink: 0; }
  .rstep__status--ok { color: var(--success); }
  .rstep__status--error { color: var(--danger); }
  .rstep__chev { color: var(--muted); flex-shrink: 0; transition: transform 160ms ease; }
  .rstep__chev.open { transform: rotate(90deg); }
  .rstep__detail { padding: .1rem .5rem .4rem; display: flex; flex-direction: column; gap: .35rem; }
  .io { display: flex; flex-direction: column; gap: .15rem; }
  .io__lbl { font-size: .62rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  .io__val { margin: 0; font-family: var(--mono); font-size: .68rem; color: var(--text); background: var(--surface-2); padding: .3rem .4rem; border-radius: .35rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9em; overflow-y: auto; }
  .io--err .io__val { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .io__note { font-size: .72rem; color: var(--muted); font-style: italic; }

  /* Inspetor */
  .inspector { border-left: 1px solid var(--border); background: var(--surface); overflow-y: auto; overflow-x: hidden; padding: .8rem; min-width: 0; overscroll-behavior: contain; }
  .inspector * { min-width: 0; }
  .inspector__empty { color: var(--muted); font-size: .85rem; }
  .inspector__head { display: flex; align-items: center; gap: .5rem; margin-bottom: .7rem; }
  .inspector__foot { margin-top: 1rem; padding-top: .8rem; border-top: 1px solid var(--border); }
  .fl { display: block; font-size: .72rem; font-weight: 600; color: var(--muted); margin: .6rem 0 .25rem; word-break: break-word; }
  .req { color: var(--danger); margin-left: 2px; }
  .tool-tag { max-width: 100%; overflow: hidden; }
  .tool-tag code { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .76rem; overflow-wrap: anywhere; word-break: break-all; }

  .input { width: 100%; box-sizing: border-box; padding: .45rem .6rem; border: 1px solid var(--border); border-radius: .45rem; background: var(--surface); color: var(--text); font-size: .84rem; outline: none; font-family: inherit; transition: border-color 160ms ease; }
  .input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .input--sm { width: auto; }
  .input--mono { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .78rem; }
  textarea.input { resize: vertical; width: 100%; }
  .row { display: flex; gap: .4rem; }
  .row .input { flex: 1; min-width: 0; }
  .hint { font-size: .74rem; color: var(--muted); margin: .3rem 0; }
  code { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .78em; background: var(--surface-2); padding: .05rem .3rem; border-radius: .25rem; }
  .badge { font-size: .66rem; font-weight: 600; padding: .1rem .4rem; border-radius: .3rem; font-family: var(--mono, 'Ubuntu Mono', monospace); background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); flex-shrink: 0; }
  .chip { padding: .3rem .65rem; border: 1px dashed var(--border); border-radius: 999px; background: transparent; color: var(--muted); font-size: .76rem; cursor: pointer; }
  .chip:hover { border-color: var(--accent); color: var(--accent); border-style: solid; }
  .mini-check { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; color: var(--muted); }

  /* Tools escolhidas no nó agente: chips removíveis (clique = tirar da lista). */
  .toolsel { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .1rem; }
  .toolchip { display: inline-flex; align-items: center; gap: .3rem; max-width: 100%; padding: .18rem .4rem; border: 1px solid var(--border);
              border-radius: 999px; background: var(--surface-2); color: var(--text); font: inherit; font-size: .72rem; cursor: pointer; }
  .toolchip:hover { border-color: var(--danger); color: var(--danger); }
  .toolchip__name { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolchip__pkg { font-size: .62rem; color: var(--muted); flex-shrink: 0; }

  /* Catálogo de tools (modal): agrupado por pacote, com marcação por clique. */
  .tpick { display: flex; flex-direction: column; gap: .6rem; }
  .tpick__group { display: flex; flex-direction: column; gap: .12rem; }
  .tpick__pkg { display: flex; align-items: center; gap: .4rem; padding: .2rem .1rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .tpick__count { font-family: var(--mono); font-size: .64rem; font-weight: 600; text-transform: none; letter-spacing: 0; }
  .tpick__all { margin-left: auto; border: none; background: none; color: var(--accent); font: inherit; font-size: .68rem; font-weight: 600; text-transform: none; letter-spacing: 0; cursor: pointer; text-decoration: underline; }
  .tpick__tool { display: flex; align-items: flex-start; gap: .5rem; width: 100%; padding: .35rem .4rem; border: 1px solid transparent; border-radius: .4rem;
                 background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .tpick__tool:hover { background: var(--surface-2); }
  .tpick__tool--on { border-color: var(--accent); background: var(--accent-weak); }
  .tpick__box { flex-shrink: 0; width: 1rem; height: 1rem; margin-top: .1rem; display: grid; place-items: center; border: 1.5px solid var(--border); border-radius: .25rem; }
  .tpick__box--on { border-color: var(--accent); color: var(--accent); }
  .tpick__body { display: flex; flex-direction: column; gap: .1rem; min-width: 0; flex: 1; }
  .tpick__name { font-family: var(--mono); font-size: .76rem; font-weight: 600; overflow-wrap: anywhere; }
  .tpick__desc { font-size: .7rem; color: var(--muted); line-height: 1.35; }
  .tpick__params { flex-shrink: 0; font-family: var(--mono); font-size: .62rem; color: var(--muted); }
  .inp-row { display: flex; gap: .35rem; align-items: center; }
  hr { border: none; border-top: 1px solid var(--border); margin: 1rem 0 .6rem; }
  h4 { margin: .2rem 0 .3rem; font-size: .85rem; }

  /* Publicar como tool */
  .pub-head { display: flex; align-items: center; justify-content: space-between; }
  .badge--on { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); border-color: transparent; }
  .pub-name { display: flex; flex-direction: column; gap: .2rem; background: var(--surface-2); border: 1px solid var(--border); border-radius: .45rem; padding: .5rem .6rem; margin: .5rem 0 .3rem; }
  .pub-name__val { font-family: var(--mono); font-size: .78rem; color: var(--accent); overflow-wrap: anywhere; background: none; padding: 0; }
  .pub-count { font-family: var(--mono); font-size: .64rem; background: var(--accent-weak); color: var(--accent); padding: .02rem .35rem; border-radius: .3rem; }
  .inp-card { display: flex; flex-direction: column; gap: .35rem; padding: .55rem; margin-top: .5rem; border: 1px solid var(--border); border-radius: .5rem; background: var(--surface-2); }

  /* Painel de variáveis disponíveis */
  .vars { border: 1px solid var(--border); border-radius: .5rem; margin: .8rem 0; background: var(--surface-2); overflow: hidden; }
  .vars__toggle { width: 100%; display: flex; align-items: center; gap: .4rem; padding: .5rem .6rem; background: none; border: none; color: var(--text); cursor: pointer; font-size: .8rem; font-weight: 600; }
  .vars__chev { transition: transform 160ms ease; flex-shrink: 0; color: var(--muted); }
  .vars__chev.open { transform: rotate(90deg); }
  .vars__hint { margin-left: auto; font-size: .66rem; font-weight: 500; color: var(--muted); font-family: var(--mono); }
  .vars__body { padding: .2rem .6rem .6rem; border-top: 1px solid var(--border); }
  .vars__group { margin-top: .55rem; }
  .vars__gtitle { display: block; font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin-bottom: .3rem; }
  .vars__chips { display: flex; flex-wrap: wrap; gap: .3rem; }
  .vartag { border: 1px solid var(--border); background: var(--surface); border-radius: .35rem; padding: .18rem .4rem; cursor: pointer; line-height: 1; transition: all 140ms ease; }
  .vartag:hover { border-color: var(--accent); background: var(--accent-weak); }
  .vartag code { font-family: var(--mono); font-size: .72rem; background: none; padding: 0; color: var(--text); }
  .vartag:hover code { color: var(--accent); }
  .vartag--inline { align-self: flex-start; }

  .toast { pointer-events:none; position: fixed; top: 1rem; right: 1rem; z-index: 500; padding: .65rem 1rem; border-radius: .5rem; font-size: .85rem; font-weight: 500; border: 1px solid var(--border); background: var(--surface); box-shadow: 0 4px 24px rgba(0,0,0,.15); }
  .toast--success { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
  .toast--error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

  /* Barra de gatilho */
  /* Trigger bar: layout empilhado e adaptável — segmentos em cima (rolam no
     estreito), configuração embaixo (ocupa a largura). Serve a todos os tipos,
     inclusive o form do cron, sem quebrar. */
  .tbar { display: flex; flex-direction: column; gap: .4rem; background: var(--surface); border: 1px solid var(--border); border-radius: .5rem; padding: .35rem .45rem; box-shadow: var(--shadow); flex: 1; min-width: 0; max-width: min(600px, 100%); }
  .tbar__top { display: flex; align-items: center; gap: .35rem; }
  .tbar__info { flex-shrink: 0; display: inline-grid; place-items: center; width: 1.7rem; height: 1.7rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--surface); color: var(--muted); cursor: pointer; }
  .tbar__info:hover, .tbar__info.on { color: var(--accent); border-color: var(--accent); }
  .tbar__pop { font-size: .78rem; line-height: 1.45; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: .4rem; padding: .45rem .55rem; }
  .tbar__config { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .tbar__config--col { flex-direction: column; align-items: stretch; }
  .tbar__grow { flex: 1; min-width: 120px; }
  .tbar__thr { width: 4.5rem; }
  .tbar__code { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .74rem; overflow-wrap: anywhere; }
  .tbar__date { font: inherit; font-size: .82rem; padding: .34rem .5rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--surface); color: var(--text); }
  .tbar__sched-note { font-size: .72rem; color: var(--muted); }
  .tbar__sched-note--warn { color: var(--warn, #d97706); }
  .segmented { display: inline-flex; gap: .15rem; background: var(--surface-2); border-radius: .45rem; padding: .15rem; }
  .segmented--scroll { flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .segmented--scroll::-webkit-scrollbar { display: none; }
  .segmented--scroll .seg { white-space: nowrap; }
  .seg { padding: .3rem .55rem; border: none; border-radius: .35rem; background: transparent; color: var(--muted); font-size: .76rem; font-weight: 500; cursor: pointer; }
  .seg--on { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .segmented--full { display: flex; width: 100%; }
  .segmented--full .seg { flex: 1; text-align: center; }
  .btn--sm { padding: .4rem .6rem; font-size: .8rem; justify-content: center; }
  .subflow-tag { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); background: var(--accent-weak); padding: .12rem .4rem; border-radius: .3rem; }

  /* Elementos exclusivos do mobile — inertes no desktop */
  .mob-backdrop { display: none; }
  .mobilebar { display: none; }
  .drawer-handle { display: none; }

  /* Mobile-first: canvas ocupa a tela; paleta e inspetor viram bottom-sheets. */
  @media (max-width: 900px) {
    .workbench { grid-template-columns: 1fr; grid-template-rows: 1fr; height:auto; flex:1; min-height:0; position: relative; }
    .canvas { grid-column: 1; grid-row: 1; }

    /* Painéis como bottom-sheets deslizantes */
    .palette, .inspector {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
      max-height: 78dvh; border: none; border-top: 1px solid var(--border);
      border-radius: 18px 18px 0 0; box-shadow: 0 -10px 34px rgba(0,0,0,.30);
      transform: translateY(105%); transition: transform 260ms cubic-bezier(.32,.72,0,1);
      display: flex; flex-direction: column;
    }
    .palette.drawer-open, .inspector.drawer-open { transform: translateY(0); }
    .inspector { padding: 0 .9rem calc(1rem + env(safe-area-inset-bottom)); overflow-y: auto; }
    .palette__scroll { max-height: none; }

    /* Puxador + fechar do sheet */
    .drawer-handle {
      display: flex; align-items: center; justify-content: space-between;
      padding: .55rem .9rem .4rem; position: sticky; top: 0; z-index: 2;
      background: var(--surface); flex-shrink: 0;
    }
    .drawer-handle::before {
      content: ""; position: absolute; top: .35rem; left: 50%; transform: translateX(-50%);
      width: 38px; height: 4px; border-radius: 999px; background: var(--border);
    }
    .drawer-handle__label { font-size: .78rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-top: .3rem; }
    .drawer-handle__close { border: none; background: none; color: var(--muted); font-size: .95rem; cursor: pointer; padding: .2rem .3rem; margin-top: .2rem; }

    /* Backdrop */
    .mob-backdrop {
      display: block; position: fixed; inset: 0; z-index: 35;
      background: rgba(0,0,0,.42); opacity: 0; pointer-events: none;
      transition: opacity 220ms ease;
    }
    .workbench.mob-open .mob-backdrop { opacity: 1; pointer-events: auto; }

    /* Barra de ações inferior */
    .mobilebar {
      display: flex; gap: .55rem; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      padding: .5rem .7rem calc(.5rem + env(safe-area-inset-bottom));
      background: var(--surface); border-top: 1px solid var(--border);
    }
    .mbtn {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
      min-height: 46px; padding: .6rem; border: 1.5px solid var(--border); border-radius: .7rem;
      background: var(--surface); color: var(--text); font-size: .9rem; font-weight: 600; cursor: pointer;
    }
    .mbtn--on { color: var(--accent); border-color: var(--accent); background: var(--accent-weak); }
    .mbtn--hint { border-color: var(--accent); color: var(--accent); }

    /* Barra de gatilho continua flutuando no topo do canvas, sem esconder */
    .canvas__triggerbar { top: .5rem; left: .5rem; right: .5rem; }
    .tbar { font-size: .84rem; }

    /* Sobe os controles de zoom para não ficarem atrás da barra inferior mobile */
    .zoomctl { bottom: calc(70px + env(safe-area-inset-bottom)); right: .6rem; }
    .zoomctl__btn { width: 34px; height: 34px; }

    /* Painel de execução ocupa a largura, acima da barra inferior */
    .runpanel { left: .6rem; right: .6rem; width: auto; bottom: calc(70px + env(safe-area-inset-bottom)); max-height: 50dvh; }

    /* Topbar não quebra: botões viram só ícone; título encolhe */
    .topbar { flex:none; gap: .3rem; min-width:0; padding:.45rem .5rem; }
    .btn__label { display: none; }
    .btn--compact { padding: .45rem .55rem; }
    .title-input { flex:1; width:0; min-width:0; padding:.35rem .4rem; font-size:.9rem; text-overflow:ellipsis; }
    .topbar__spacer { display:none; }
    .desktop-action { display:none !important; }
    .mobile-actions { display:block; }
    .mobile-actions summary { list-style:none; }
    .mobile-actions summary::-webkit-details-marker { display:none; }
    .mobile-actions[open] { position:relative; z-index:100; }
    .mobile-actions__menu { position:absolute; z-index:110; right:0; top:2.5rem; width:190px; padding:.35rem; border:1px solid var(--border); border-radius:.7rem; background:var(--surface); box-shadow:0 14px 40px rgba(0,0,0,.35); }
    .mobile-actions__menu button, .mobile-actions__menu label { display:flex; box-sizing:border-box; width:100%; gap:.45rem; align-items:center; padding:.65rem; border:0; border-radius:.45rem; background:transparent; color:var(--text); font:500 .8rem var(--tk-font); text-align:left; }
    .mobile-actions__menu button:hover { background:var(--surface-2); }
    .tbar__config--advanced { display:none; }

    /* Inspetor: mais alto e com rolagem garantida quando o nó tem muita coisa */
    .inspector { max-height: 86dvh; }
    .inspector__foot { position: sticky; bottom: 0; background: var(--surface); }

    /* Portas maiores para toque; afastadas para não colar no dedo */
    .port { width: 18px; height: 18px; }
    .port--in { left: -10px; }
    .port--out { right: -10px; }
    .port__label { left: 21px; }
  }

  .ed--widget-canvas,.ed--widget-catalog,.ed--widget-properties { height:100dvh; min-height:0; overflow:hidden; }
  .ed--widget-canvas .workbench { flex:1; min-height:0; height:auto; }
  .flow-enabled { display:flex; align-items:center; gap:4px; font-size:12px; }
  .ed--widget-canvas .topbar { flex-wrap:wrap; }
  .ed--widget-canvas .title-input { flex:1 1 160px; min-width:120px; }
  .ed--widget-canvas .runpanel { left:50%; right:auto; transform:translateX(-50%); width:min(520px,calc(100% - 680px)); }
  .ed--widget-catalog .drawer-handle,.ed--widget-properties .drawer-handle { display:none; }
  .ed--widget-properties .inspector { display:block !important; transform:none !important; visibility:visible; }
  .ed--widget-catalog .palette { transform:none !important; visibility:visible; }
  :global(body:has(.ed--direct-canvas)) { background:transparent; }
  @media(max-width:900px) { .ed--widget-canvas .runpanel { width:calc(100% - 20px); } }
  @media(max-width:767px) {
    .ed--widget-canvas .mobilebar { display:flex; }
    .ed--widget-canvas .palette.drawer-open,.ed--widget-canvas .inspector.drawer-open { display:block; }
    .ed--widget-canvas .palette:not(.drawer-open),.ed--widget-canvas .inspector:not(.drawer-open) { display:none; }
  }

  /* Match Desktop scrollbars inside standalone views and floating panels. */
  .ed, .ed :global(*) { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--tk-text) 22%, transparent) transparent; }
  .ed::-webkit-scrollbar, .ed :global(*::-webkit-scrollbar) { width: 6px; height: 6px; }
  .ed::-webkit-scrollbar-track, .ed :global(*::-webkit-scrollbar-track) { background: transparent; }
  .ed::-webkit-scrollbar-thumb, .ed :global(*::-webkit-scrollbar-thumb) { background: color-mix(in srgb, var(--tk-text) 22%, transparent); border-radius: 999px; }
  .ed::-webkit-scrollbar-thumb:hover, .ed :global(*::-webkit-scrollbar-thumb:hover) { background: color-mix(in srgb, var(--tk-text) 38%, transparent); }
  .ed::-webkit-scrollbar-corner, .ed :global(*::-webkit-scrollbar-corner) { background: transparent; }
</style>
