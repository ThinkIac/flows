<script>
  import { onMount } from "svelte";

  const BASE = "/flows";

  let workflows = [];
  let runs = [];
  let loading = true;
  let theme = "dark";

  let selectedRunId = null;  // run expandida no painel de execuções
  let mobileView = "workflows";

  // Navegar para o Editor recarrega a página inteira (é uma view separada) e isso
  // demora — sem feedback o clique parecia travado. Mostramos um overlay curto.
  let navigating = false;
  // Ações por-linha em voo (toggle/executar) para dar feedback no card certo.
  let busy = {};  // { [wfId]: 'toggle' | 'run' }

  // Confirmação de exclusão (modal in-app — window.confirm não funciona no
  // WebView do app: retorna false/undefined e o delete nunca dispara).
  let pendingDelete = null;  // workflow aguardando confirmação
  let deleting = false;

  // Toast
  let toast = null;
  let toastTimer;

  /* ── Templates ────────────────────────────────────────────────────────────
   * Flows prontos entregues pelos próprios pacotes (`*.flow.json`). Escolher um
   * abre o formulário das VARIÁVEIS SOLTAS dele (nós "definir variável" sem
   * conexão) — é assim que o mesmo template serve a contextos diferentes sem
   * ninguém precisar abrir o grafo.
   */
  let templates = [];
  let templatesOpen = false;
  let loadingTemplates = false;
  let pickedTemplate = null;
  let templateName = "";
  let templateValues = {};
  let creatingFromTemplate = false;

  async function openTemplates() {
    templatesOpen = true;
    pickedTemplate = null;
    loadingTemplates = true;
    try {
      const data = await fetch(BASE + "/templates").then((x) => x.json());
      templates = data.templates || [];
    } catch {
      showToast("Failed to load templates", "error");
      templates = [];
    }
    loadingTemplates = false;
  }

  function pickTemplate(template) {
    pickedTemplate = template;
    templateName = template.name;
    templateValues = Object.fromEntries(
      (template.variables || []).map((v) => [v.key, v.default ?? ""]),
    );
  }

  async function createFromTemplate() {
    if (!pickedTemplate || creatingFromTemplate) return;
    creatingFromTemplate = true;
    try {
      const res = await fetch(BASE + "/templates/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: pickedTemplate.id,
          name: templateName,
          values: templateValues,
        }),
      }).then((x) => x.json());
      if (!res.success) throw new Error(res.error || "Failed to create workflow");
      templatesOpen = false;
      // Nasce desligado: leva direto ao editor para revisar antes de ativar.
      navigating = true;
      location.href = "/view/flows/Editor?id=" + res.workflow.id;
    } catch (err) {
      showToast(err.message, "error");
    }
    creatingFromTemplate = false;
  }

  function applyTheme(value) {
    theme = value === "light" ? "light" : "dark";
  }

  onMount(() => {
    try { applyTheme(localStorage.getItem("think:theme")); } catch {}
    window.addEventListener("storage", onThemeStorage);
    load();
    return () => window.removeEventListener("storage", onThemeStorage);
  });

  function onThemeStorage(event) {
    if (event.key === "think:theme") applyTheme(event.newValue);
  }

  async function load() {
    loading = true;
    try {
      const [w, r] = await Promise.all([
        fetch(BASE + "/workflows").then((x) => x.json()),
        fetch(BASE + "/runs?limit=40").then((x) => x.json()),
      ]);
      workflows = w.workflows || [];
      runs = r.runs || [];
    } catch (err) {
      showToast("Failed to load", "error");
    }
    loading = false;
  }

  function showToast(message, type = "success") {
    toast = { message, type };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2600);
  }

  // ── Navegação para o editor de grafo (única fonte de edição) ────────────────
  function newWorkflow() {
    navigating = true;
    location.href = "/view/flows/Editor";
  }

  function editWorkflow(wf) {
    navigating = true;
    location.href = "/view/flows/Editor?id=" + wf.id;
  }

  async function toggle(wf) {
    busy = { ...busy, [wf.id]: "toggle" };
    try {
      await fetch(BASE + "/workflows/" + wf.id + "/toggle", { method: "PATCH" });
      await load();
    } finally {
      const { [wf.id]: _, ...rest } = busy; busy = rest;
    }
  }

  // Duplicar: a cópia nasce desligada e sem publicar (ver store.duplicateWorkflow).
  async function duplicate(wf) {
    busy = { ...busy, [wf.id]: "copy" };
    try {
      const res = await fetch(BASE + "/workflows/" + wf.id + "/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((x) => x.json());
      if (!res.success) throw new Error(res.error || "Failed to duplicate workflow");
      showToast("Copy created: " + res.workflow.name);
      await load();
    } catch (err) {
      showToast(err.message || "Failed to duplicate workflow", "error");
    } finally {
      const { [wf.id]: _, ...rest } = busy; busy = rest;
    }
  }

  function askRemove(wf) {
    pendingDelete = wf;
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    const wf = pendingDelete;
    deleting = true;
    try {
      const res = await fetch(BASE + "/workflows/" + wf.id, { method: "DELETE" }).then((x) => x.json());
      if (!res.success) throw new Error(res.error || "erro");
      showToast("Workflow deleted");
      pendingDelete = null;
      await load();
    } catch (err) {
      showToast(err.message || "Failed to delete workflow", "error");
    }
    deleting = false;
  }

  async function runNow(wf) {
    busy = { ...busy, [wf.id]: "run" };
    showToast("Running…");
    try {
      const res = await fetch(BASE + "/workflows/" + wf.id + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((x) => x.json());
      if (res.success) showToast("Run: " + res.run.status, res.run.status === "ok" ? "success" : "error");
      else showToast(res.error || "Error", "error");
      await load();
    } finally {
      const { [wf.id]: _, ...rest } = busy; busy = rest;
    }
  }

  // Replay: repete uma execução passada com EXATAMENTE o mesmo payload de
  // entrada (guardado em run.input pelo motor). Runs anteriores a este recurso
  // não têm input — o botão fica desabilitado com o motivo no title.
  let replayingId = null;
  async function replay(run) {
    replayingId = run.id;
    try {
      const res = await fetch(BASE + "/runs/" + run.id + "/replay", { method: "POST" }).then((x) => x.json());
      if (res.success) {
        showToast("Replay: " + res.run.status, res.run.status === "ok" ? "success" : "error");
        await load();
        selectedRunId = res.run.id;
      } else showToast(res.error || "Replay failed", "error");
    } catch (err) {
      showToast(err.message || "Replay failed", "error");
    }
    replayingId = null;
  }

  function fmtLogTime(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour12: false });
  }

  async function copyUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("URL copied");
    } catch {
      showToast("Copy manually: " + url, "error");
    }
  }

  // ── Derivados ───────────────────────────────────────────────────────────────
  $: activeCount = workflows.filter((w) => w.enabled).length;
  $: scheduledCount = workflows.filter((w) => w.trigger?.type === "cron" || w.trigger?.type === "schedule").length;
  $: totalRuns = runs.length;

  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Descrição curta de um cron para o card (cobre os padrões do builder).
  function cronLabel(expr) {
    const p = (expr || "").trim().split(/\s+/);
    if (p.length !== 5) return "cron";
    const [mi, ho] = p;
    const at = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    if (/^\*\/\d+$/.test(mi) && ho === "*") return `every ${mi.split("/")[1]} min`;
    if (/^\d+$/.test(mi) && ho === "*") return `hourly at :${mi.padStart(2, "0")}`;
    if (/^\d+$/.test(mi) && /^\d+$/.test(ho)) {
      if (p[4] !== "*") return `${p[4].split(",").map((x) => DOW_NAMES[parseInt(x, 10) % 7]).join("/")} ${at(ho, mi)}`;
      if (p[2] !== "*") return `day ${p[2]} · ${at(ho, mi)}`;
      return `daily ${at(ho, mi)}`;
    }
    return "cron";
  }

  function triggerLabel(t) {
    if (!t) return "manual";
    if (t.type === "event") return t.event || "event";
    if (t.type === "webhook") return "webhook";
    if (t.type === "semantic") return "semantic";
    if (t.type === "cron") return cronLabel(t.cron);
    if (t.type === "schedule") return t.at ? "date · " + fmtTime(t.at) : "date";
    return "manual";
  }

  function statusClass(s) {
    if (s === "ok") return "ok";
    if (s === "error" || s === "aborted") return "error";
    if (s === "stopped") return "warn";
    return "muted";
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
</script>

<div class="flows" data-theme={theme}>
  {#if toast}
    <div class="toast toast--{toast.type}">{toast.message}</div>
  {/if}

  {#if navigating}
    <div class="navover">
      <div class="spinner"></div>
      <span>Opening editor…</span>
    </div>
  {/if}

  {#if pendingDelete}
    <div class="modal-backdrop" on:click={() => !deleting && (pendingDelete = null)}>
      <div class="modal" on:click|stopPropagation>
        <h3 class="modal__title">Delete workflow</h3>
        <p class="modal__body">Are you sure you want to delete <b>“{pendingDelete.name}”</b>? This action cannot be undone.</p>
        <div class="modal__actions">
          <button class="btn" on:click={() => (pendingDelete = null)} disabled={deleting}>Cancel</button>
          <button class="btn btn--solid-danger" on:click={confirmRemove} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if templatesOpen}
    <div class="modal-backdrop" on:click={() => !creatingFromTemplate && (templatesOpen = false)}>
      <div class="modal modal--wide" on:click|stopPropagation>
        {#if !pickedTemplate}
          <h3 class="modal__title">Create from template</h3>
          <p class="modal__body">Ready-to-use flows published by packages (<code>*.flow.json</code> files).</p>
          {#if loadingTemplates}
            <p class="modal__body">Looking for templates…</p>
          {:else if !templates.length}
            <p class="modal__body">No templates found. A package can publish one by adding a <code>*.flow.json</code> file.</p>
          {:else}
            <div class="tpl-list">
              {#each templates as template (template.id)}
                <button class="tpl" on:click={() => pickTemplate(template)}>
                  <span class="tpl__name">{template.name}</span>
                  {#if template.description}<span class="tpl__desc">{template.description}</span>{/if}
                  <span class="tpl__meta">
                    <em>{template.package}</em>
                    <em>{template.nodeCount} nodes</em>
                    {#if template.variables.length}<em>{template.variables.length} variables</em>{/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
          <div class="modal__actions">
            <button class="btn" on:click={() => (templatesOpen = false)}>Close</button>
          </div>
        {:else}
          <h3 class="modal__title">{pickedTemplate.name}</h3>
          {#if pickedTemplate.description}<p class="modal__body">{pickedTemplate.description}</p>{/if}

          <div class="tpl-form">
            <label class="tpl-field">
              <span>Workflow name</span>
              <input type="text" bind:value={templateName} />
            </label>

            <!-- Formulário dinâmico: uma entrada por variável solta do template. -->
            {#each pickedTemplate.variables as variable (variable.nodeId)}
              <label class="tpl-field">
                <span>{variable.label}</span>
                <input type="text" bind:value={templateValues[variable.key]} placeholder={variable.default ?? ""} />
                {#if variable.description}<small>{variable.description}</small>{/if}
              </label>
            {/each}

            {#if !pickedTemplate.variables.length}
              <p class="modal__body">This template has no variables to configure.</p>
            {/if}
          </div>

          <div class="modal__actions">
            <button class="btn" on:click={() => (pickedTemplate = null)} disabled={creatingFromTemplate}>Back</button>
            <button class="btn btn--primary" on:click={createFromTemplate} disabled={creatingFromTemplate}>
              {creatingFromTemplate ? "Creating…" : "Create workflow"}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <header class="header">
    <div class="header__actions">
      <button class="btn btn--ghost" on:click={load} aria-label="Reload">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button class="btn btn--template" on:click={openTemplates} aria-label="Create from template" title="Create from template">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg>
        <span class="btn__label btn__label--template">From template</span>
      </button>
      <button class="btn btn--primary" on:click={newWorkflow}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <span class="btn__label">New <span class="btn__label--workflow">workflow</span></span>
      </button>
    </div>
  </header>

  <section class="stats" aria-label="Summary">
    <div class="stat"><span class="stat__value">{workflows.length}</span><span class="stat__label">workflows</span></div>
    <div class="stat"><span class="stat__value">{activeCount}</span><span class="stat__label">active</span></div>
    <div class="stat stat--wide"><span class="stat__value">{scheduledCount}</span><span class="stat__label">scheduled</span></div>
    <div class="stat stat--wide"><span class="stat__value">{totalRuns}</span><span class="stat__label">recent runs</span></div>
  </section>

  <nav class="mobile-tabs" aria-label="Flow sections">
    <button class:active={mobileView === "workflows"} on:click={() => (mobileView = "workflows")}>Flows <span>{workflows.length}</span></button>
    <button class:active={mobileView === "activity"} on:click={() => (mobileView = "activity")}>Activity <span>{totalRuns}</span></button>
  </nav>

  <div class="split">
    <!-- Coluna de workflows -->
    <section class:mobile-hidden={mobileView !== "workflows"}>
      <div class="section-heading"><h2 class="section-title">Workflows</h2>{#if !loading && workflows.length}<span>{workflows.length}</span>{/if}</div>
      {#if loading}
        <div class="skeleton"></div><div class="skeleton"></div>
      {:else if workflows.length === 0}
        <div class="empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <p>No workflows yet.</p>
          <button class="btn btn--primary" on:click={newWorkflow}>Create your first</button>
        </div>
      {:else}
        <div class="wf-list">
          {#each workflows as wf (wf.id)}
            <div class="wf" class:wf--off={!wf.enabled}>
              <div class="wf__main">
                <div class="wf__title-row">
                  <span class="wf__name">{wf.name}</span>
                  <span class="badge badge--{wf.trigger?.type || 'manual'}">{triggerLabel(wf.trigger)}</span>
                </div>
                {#if wf.description}<p class="wf__desc">{wf.description}</p>{/if}
                <div class="wf__meta">
                  <span>{(wf.nodes || []).length} nodes</span>
                  {#if wf.webhookUrl}
                    <button class="link" on:click={() => copyUrl(wf.webhookUrl)}>copy webhook</button>
                  {/if}
                </div>
              </div>
              <div class="wf__actions">
                <button class="btn btn--icon" title="Run" on:click={() => runNow(wf)} disabled={!!busy[wf.id]} aria-label="Run">
                  {#if busy[wf.id] === "run"}
                    <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>
                  {/if}
                </button>
                <button class="btn btn--icon" title="Edit" on:click={() => editWorkflow(wf)} disabled={navigating} aria-label="Edit">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                </button>
                <details class="wf__more">
                  <summary class="btn btn--icon" aria-label="More actions" title="More actions">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                  </summary>
                  <div class="wf__menu">
                    <button on:click={() => duplicate(wf)} disabled={!!busy[wf.id]}>Duplicate</button>
                    <button on:click={() => toggle(wf)} disabled={!!busy[wf.id]}>{wf.enabled ? "Disable" : "Enable"}</button>
                    <button on:click={() => askRemove(wf)}>Delete</button>
                  </div>
                </details>
                <div class="wf__desktop-actions">
                <button class="btn btn--icon" title="Duplicate" on:click={() => duplicate(wf)} disabled={!!busy[wf.id]} aria-label="Duplicate">
                  {#if busy[wf.id] === "copy"}
                    <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  {/if}
                </button>
                <button class="btn btn--icon" class:on={wf.enabled} title="Enable/disable" on:click={() => toggle(wf)} disabled={!!busy[wf.id]} aria-label="Enable/disable">
                  {#if busy[wf.id] === "toggle"}
                    <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>
                  {/if}
                </button>
                <button class="btn btn--icon btn--danger" title="Delete" on:click={() => askRemove(wf)} aria-label="Delete">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Coluna de execuções -->
    <section class="runs-col" class:mobile-hidden={mobileView !== "activity"}>
      <div class="section-heading"><h2 class="section-title">Recent activity</h2></div>
      {#if runs.length === 0}
        <div class="empty empty--sm"><p>No runs yet.</p></div>
      {:else}
        <div class="runs">
          {#each runs as run (run.id)}
            <div class="run">
              <button class="run__head" on:click={() => (selectedRunId = selectedRunId === run.id ? null : run.id)}>
                <span class="dot dot--{statusClass(run.status)}"></span>
                <span class="run__name">{run.workflowName}</span>
                {#if run.replayOf}<span class="run__tag" title="This run replays another run">replay</span>{/if}
                <span class="run__status">{run.status}</span>
                <span class="run__time">{fmtTime(run.startedAt)}</span>
              </button>
              {#if selectedRunId === run.id}
                <div class="run__detail">
                  {#if run.error}<p class="run__error">{run.error}</p>{/if}
                  {#each (run.nodes || run.steps || []) as st}
                    <div class="run__step">
                      <span class="dot dot--{statusClass(st.status)}"></span>
                      <span class="run__step-name">{st.name}</span>
                      {#if st.durationMs != null}<span class="run__step-dur">{st.durationMs < 1000 ? st.durationMs + "ms" : (st.durationMs/1000).toFixed(1) + "s"}</span>{/if}
                      {#if st.error}<span class="run__step-err">{st.error}</span>{/if}
                    </div>
                  {/each}

                  {#if run.logs?.length}
                    <div class="run__log">
                      {#each run.logs as l}
                        <div class="run__logline run__logline--{l.level || 'info'}">
                          <span class="run__logts">{fmtLogTime(l.ts)}</span>
                          {#if l.nodeName}<span class="run__lognode">{l.nodeName}</span>{/if}
                          <span>{l.message}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}

                  <div class="run__acts">
                    {#if run.input != null}
                      <code class="run__input" title="Payload that triggered this run">{JSON.stringify(run.input).slice(0, 120)}</code>
                    {/if}
                    <button class="run__replay" on:click={() => replay(run)}
                            disabled={replayingId === run.id || run.input == null}
                            title={run.input == null ? "Older run: the input payload was not stored" : "Repeat with the same parameters"}>
                      {replayingId === run.id ? "replaying…" : "replay"}
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,400&family=Ubuntu+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .flows[data-theme="dark"] { --tk-bg:#111111;--tk-surface:#181818;--tk-surface-2:#1f1f1f;--tk-border:rgba(255,255,255,.09);--tk-border-hi:rgba(255,255,255,.16);--tk-text:#f5f5f5;--tk-muted:#888;--tk-muted-2:rgba(136,136,136,.5);--tk-accent:#f5f5f5;--tk-on-accent:#111;--tk-radius-md:8px;--tk-radius-lg:14px;--tk-font:'Ubuntu',system-ui,sans-serif;--tk-mono:'Ubuntu Mono',monospace;--flow-accent:#635bff;--bg:var(--tk-bg);--surface:var(--tk-surface);--surface-2:var(--tk-surface-2);--border:var(--tk-border);--text:var(--tk-text);--muted:var(--tk-muted);--accent:var(--tk-accent);--accent-weak:var(--tk-surface-2);--mono:var(--tk-mono);--danger:var(--tk-text);--success:var(--tk-text);--warn:var(--tk-muted); }
  .flows[data-theme="light"] { --tk-bg:#fff;--tk-surface:#f5f5f5;--tk-surface-2:#ececec;--tk-border:rgba(0,0,0,.10);--tk-border-hi:rgba(0,0,0,.18);--tk-text:#1a1a1a;--tk-muted:#666;--tk-muted-2:rgba(0,0,0,.4);--tk-accent:#111;--tk-on-accent:#fff;--tk-radius-md:8px;--tk-radius-lg:14px;--tk-font:'Ubuntu',system-ui,sans-serif;--tk-mono:'Ubuntu Mono',monospace;--flow-accent:#5147c9;--bg:var(--tk-bg);--surface:var(--tk-surface);--surface-2:var(--tk-surface-2);--border:var(--tk-border);--text:var(--tk-text);--muted:var(--tk-muted);--accent:var(--tk-accent);--accent-weak:var(--tk-surface-2);--mono:var(--tk-mono);--danger:var(--tk-text);--success:var(--tk-text);--warn:var(--tk-muted); }
  :global(html), :global(body) {
    margin: 0;
    max-width: 100%;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }

  .flows { min-height:100dvh; box-sizing:border-box; max-width:760px; margin:0 auto; padding:1.25rem 1rem 2rem; background:var(--tk-bg); color:var(--tk-text); font-family:var(--tk-font); }

  .header {display:flex;justify-content:flex-end;align-items:center;gap:.75rem;margin-bottom:1.25rem}.header__actions{display:flex;gap:.4rem}

  .btn{display:inline-flex;align-items:center;gap:.4rem;padding:.55rem .7rem;border:1px solid var(--tk-border);border-radius:var(--tk-radius-md);background:var(--tk-surface);color:var(--tk-text);font:500 .8rem var(--tk-font);cursor:pointer;transition:transform 200ms ease-out,opacity 200ms ease-out;white-space:nowrap}.btn:hover{border-color:var(--tk-border-hi)}.btn:active{transform:scale(.98)}.btn--primary{background:var(--tk-accent);color:var(--tk-on-accent);border-color:var(--tk-accent);font-weight:600}.btn--ghost{padding:.55rem;border-color:transparent;background:transparent;color:var(--tk-muted)}.btn--icon{padding:.4rem;line-height:1;border-color:transparent;background:transparent;color:var(--tk-muted)}.btn--icon.on{color:var(--tk-text)}.btn--icon:hover{background:var(--tk-surface-2);color:var(--tk-text)}.btn--danger:hover{color:var(--tk-text)}.btn:disabled{opacity:.35;cursor:not-allowed}
  .btn:disabled { opacity: .35; cursor: not-allowed; }

  .stats{display:flex;gap:0;margin:0 -1rem 1.5rem;padding:0 1rem;overflow-x:auto;border-block:1px solid var(--tk-border)}.stat{display:flex;flex:none;flex-direction:column;min-width:4.7rem;padding:.7rem .85rem;border-right:1px solid var(--tk-border)}.stat__value{font:700 1rem var(--tk-mono)}.stat__label{margin-top:.15rem;color:var(--tk-muted);font-size:.68rem}.stat--wide{display:none}

  .split{display:flex;flex-direction:column;gap:1.75rem}.split>section{min-width:0}.section-heading{display:flex;gap:.4rem;align-items:baseline;margin-bottom:.7rem}.section-heading>span{color:var(--tk-muted);font:normal .75rem var(--tk-mono)}.section-title{margin:0;font-size:.85rem;font-weight:600}

  .wf-list{display:flex;flex-direction:column;gap:.55rem}.wf{position:relative;display:flex;gap:.75rem;justify-content:space-between;background:var(--tk-surface);border:1px solid var(--tk-border);border-radius:var(--tk-radius-lg);padding:.85rem;transition:transform 200ms ease-out}.wf:hover{border-color:var(--tk-border-hi)}.wf:active{transform:scale(.995)}
  .wf--off{opacity:.58}
  .wf__main { min-width: 0; }
  .wf__title-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .wf__name{font-weight:600;font-size:.9rem}.wf__desc{margin:.25rem 0 0;font-size:.77rem;color:var(--tk-muted)}.wf__meta{display:flex;gap:.75rem;align-items:center;margin-top:.4rem;font-size:.72rem;color:var(--tk-muted)}
  .wf__actions, .wf__desktop-actions { display: flex; gap: .1rem; flex-shrink: 0; align-items: flex-start; }
  .wf__more, .mobile-tabs { display: none; }

  .badge{font:500 .65rem var(--tk-mono);padding:.12rem .38rem;border-radius:4px;background:var(--tk-surface-2);color:var(--tk-muted);border:1px solid var(--tk-border)}.badge--event,.badge--cron,.badge--schedule{color:var(--tk-text)}

  .link{background:none;border:0;padding:0;color:var(--tk-text);font-size:.72rem;cursor:pointer;text-decoration:underline}

  /* A lista de execuções cresce sem teto (40 runs, cada uma expansível com
     etapas + log). Solta na página ela empurrava tudo e estourava o layout —
     então a coluna vira um painel fixo na viewport com rolagem própria. */
  .runs-col { position: sticky; top: 1rem; display: flex; flex-direction: column; min-height: 0; max-height: calc(100dvh - 3rem); }
  .runs { display: flex; flex-direction: column; gap: .4rem; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: .2rem; }
  .run { border: 1px solid var(--border); border-radius: .5rem; background: var(--surface); overflow: hidden; flex-shrink: 0; }
  .run__head { width: 100%; display: flex; align-items: center; gap: .5rem; padding: .6rem .75rem; background: none; border: none; cursor: pointer; color: var(--text); text-align: left; font-size: .82rem; }
  .run__name { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run__status { font-family: var(--mono, 'Ubuntu Mono', monospace); font-size: .72rem; color: var(--muted); }
  .run__time { font-size: .7rem; color: var(--muted); flex-shrink: 0; }
  .run__detail { padding: .25rem .75rem .6rem; border-top: 1px solid var(--border); max-height: 46dvh; overflow-y: auto; }
  .run__error { margin: .4rem 0; font-size: .78rem; color: var(--danger); }
  .run__step { display: flex; align-items: center; gap: .4rem; font-size: .78rem; padding: .15rem 0; }
  .run__step-name { color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run__step-err { color: var(--danger); font-size: .72rem; }
  .run__tag { font-size: .6rem; font-weight: 700; padding: .05rem .3rem; border-radius: .3rem; background: var(--accent-weak); color: var(--text); }
  /* Log da execução (mensagens do nó Log, erros, início/fim) */
  .run__log { margin-top: .4rem; padding: .3rem; border-radius: .35rem; background: var(--surface-2); font-family: var(--mono); font-size: .68rem; display: flex; flex-direction: column; gap: .1rem; max-height: 12em; overflow-y: auto; }
  .run__logline { display: flex; gap: .35rem; overflow-wrap: anywhere; }
  .run__logline--error { color: var(--danger); }
  .run__logline--warn { color: var(--warn); }
  .run__logts { color: var(--muted); flex-shrink: 0; }
  .run__lognode { color: var(--accent); flex-shrink: 0; }
  .run__acts { display: flex; align-items: center; gap: .4rem; margin-top: .45rem; }
  .run__input { flex: 1; min-width: 0; font-family: var(--mono); font-size: .66rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run__replay { flex-shrink: 0; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: .35rem; padding: .2rem .5rem; font: inherit; font-size: .7rem; font-weight: 600; cursor: pointer; }
  .run__replay:hover:not(:disabled) { border-color: var(--accent); }
  .run__replay:disabled { opacity: .45; cursor: not-allowed; }
  .run__step-dur { margin-left: auto; font-family: var(--mono); font-size: .68rem; color: var(--muted); }

  .dot { width: .6rem; height: .6rem; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
  .dot--ok { background: var(--success); }
  .dot--error { background: var(--danger); }
  .dot--warn { background: var(--warn); }
  .dot--muted { background: var(--muted); }

  .empty { text-align: center; padding: 2.5rem 1rem; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: .75rem; border: 1px dashed var(--border); border-radius: .5rem; }
  .empty--sm { padding: 1.5rem 1rem; }
  .skeleton { height: 68px; border-radius: .5rem; margin-bottom: .6rem; background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface) 37%, var(--surface-2) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

  /* Modal de confirmação */
  .modal-backdrop { position: fixed; inset: 0; z-index: 600; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 1rem; animation: fadeIn 160ms ease; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: .75rem; padding: 1.4rem; max-width: 24rem; width: 100%; box-shadow: 0 12px 48px rgba(0,0,0,.28); animation: popIn 180ms cubic-bezier(.32,.72,0,1); }
  .modal__title { margin: 0 0 .5rem; font-size: 1.05rem; font-weight: 700; }
  .modal__body { margin: 0 0 1.2rem; font-size: .88rem; color: var(--muted); line-height: 1.45; }
  .modal__actions { display: flex; justify-content: flex-end; gap: .5rem; }
  .modal--wide { max-width: 34rem; max-height: 86dvh; overflow-y: auto; }

  /* Templates */
  .tpl-list { display: flex; flex-direction: column; gap: .5rem; margin-bottom: 1.2rem; }
  .tpl { display: flex; flex-direction: column; gap: .25rem; text-align: left; cursor: pointer;
         background: var(--surface); border: 1px solid var(--border); border-radius: .6rem; padding: .7rem .85rem; color: inherit; font: inherit; }
  .tpl:hover { border-color: var(--accent, var(--border)); }
  .tpl__name { font-weight: 600; font-size: .92rem; }
  .tpl__desc { font-size: .82rem; color: var(--muted); line-height: 1.4; }
  .tpl__meta { display: flex; flex-wrap: wrap; gap: .4rem; }
  .tpl__meta em { font-style: normal; font-size: .7rem; color: var(--muted); border: 1px solid var(--border); border-radius: .3rem; padding: .05rem .35rem; }

  .tpl-form { display: flex; flex-direction: column; gap: .75rem; margin-bottom: 1.2rem; }
  .tpl-field { display: flex; flex-direction: column; gap: .3rem; }
  .tpl-field span { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .tpl-field input { font: inherit; font-size: .88rem; color: inherit; background: var(--surface);
                     border: 1px solid var(--border); border-radius: .45rem; padding: .5rem .6rem; outline: none; }
  .tpl-field input:focus { border-color: var(--accent, var(--border)); }
  .tpl-field small { font-size: .75rem; color: var(--muted); }
  .btn--solid-danger { background: var(--tk-accent); border-color: var(--tk-accent); color: var(--tk-on-accent); font-weight: 600; }
  .btn--solid-danger:hover { filter: brightness(1.05); border-color: var(--danger); }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes popIn { from { transform: scale(.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }

  /* Overlay curto ao abrir o Editor (navegação recarrega a página). */
  .navover { position: fixed; inset: 0; z-index: 700; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .8rem; background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(2px); color: var(--muted); font-size: .85rem; font-weight: 500; animation: fadeIn 120ms ease; }
  .spinner { width: 30px; height: 30px; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--text); animation: spin 720ms linear infinite; }
  .spin { animation: spin 720ms linear infinite; transform-origin: center; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .toast { position: fixed; top: 1.25rem; right: 1.25rem; z-index: 500; padding: .7rem 1rem; border-radius: .5rem; font-size: .85rem; font-weight: 500; border: 1px solid var(--border); background: var(--surface); box-shadow: 0 4px 24px rgba(0,0,0,.15); animation: slideIn 260ms ease-out; }
  .toast--success { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
  .toast--error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
  @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  /* ── Responsivo (prioridade) ─────────────────────────────────────────── */
  @media (max-width: 900px) {
    .split { grid-template-columns: 1fr; }
    /* Empilhado, grudar a coluna no topo esconderia os workflows: volta ao
       fluxo normal, mas ainda com teto de altura e rolagem própria. */
    .runs-col { position: static; max-height: none; }
    .runs { max-height: 62dvh; }
  }
  @media (max-width: 620px) {
    .flows { width: 100%; min-height: 100dvh; padding: .75rem; overflow-x: hidden; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .header { gap: .5rem; margin-bottom: .75rem; }
    .header__subtitle, .btn--ghost .btn__label { display:none; }
    .header__actions { width: auto; }
    .btn--template { padding: .55rem; }
    .btn__label--template, .btn__label--workflow { display: none; }
    .stats { margin-bottom: .85rem; }
    .stat { min-width:0; flex:1; padding:.55rem .65rem; }
    .mobile-tabs { display:flex; padding:.2rem; margin-bottom:.75rem; border-radius:10px; background:var(--tk-surface); }
    .mobile-tabs button { flex:1; border:0; border-radius:8px; padding:.5rem; background:transparent; color:var(--tk-muted); font:600 .78rem var(--tk-font); }
    .mobile-tabs button.active { background:var(--tk-surface-2); color:var(--tk-text); }
    .mobile-tabs span { margin-left:.25rem; font:400 .68rem var(--tk-mono); }
    .mobile-hidden { display:none !important; }
    .split { gap:0; }
    .wf { align-items:center; padding:.75rem; }
    .wf__main { flex:1; }
    .wf__desktop-actions { display:none; }
    .wf__more { display:block; position:relative; z-index:1; }
    .wf__more[open] { z-index:100; }
    .wf__more summary { list-style:none; }
    .wf__more summary::-webkit-details-marker { display:none; }
    .wf__menu { position:absolute; z-index:20; right:0; top:2.25rem; min-width:170px; padding:.3rem; border:1px solid var(--tk-border-hi); border-radius:10px; background:var(--tk-surface); box-shadow:0 12px 36px rgba(0,0,0,.28); }
    .wf__menu button { display:block; width:100%; padding:.55rem .65rem; border:0; border-radius:7px; background:transparent; color:var(--tk-text); text-align:left; font:500 .78rem var(--tk-font); }
    .wf__menu button:hover { background:var(--tk-surface-2); }
    .runs { max-height:calc(100dvh - 190px); }
  }

  /* Match Desktop scrollbars inside standalone views and floating panels. */
  .flows, .flows :global(*) { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--tk-text) 22%, transparent) transparent; }
  .flows::-webkit-scrollbar, .flows :global(*::-webkit-scrollbar) { width: 6px; height: 6px; }
  .flows::-webkit-scrollbar-track, .flows :global(*::-webkit-scrollbar-track) { background: transparent; }
  .flows::-webkit-scrollbar-thumb, .flows :global(*::-webkit-scrollbar-thumb) { background: color-mix(in srgb, var(--tk-text) 22%, transparent); border-radius: 999px; }
  .flows::-webkit-scrollbar-thumb:hover, .flows :global(*::-webkit-scrollbar-thumb:hover) { background: color-mix(in srgb, var(--tk-text) 38%, transparent); }
  .flows::-webkit-scrollbar-corner, .flows :global(*::-webkit-scrollbar-corner) { background: transparent; }
</style>
