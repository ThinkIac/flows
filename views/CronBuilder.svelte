<script>
  // CronBuilder — monta uma expressão cron de 5 campos sem o usuário decorar
  // "* * * * *". Frequência em linguagem natural + preview humano + próximos
  // disparos. O campo cru fica escondido atrás de "Avançado".
  //
  // Contrato: bind:cron={...}. O componente parseia o cron recebido para popular
  // os controles e reescreve o cron sempre que um controle muda.

  export let cron = "0 9 * * *";

  const DOW = [
    { v: 1, label: "seg" }, { v: 2, label: "ter" }, { v: 3, label: "qua" },
    { v: 4, label: "qui" }, { v: 5, label: "sex" }, { v: 6, label: "sáb" }, { v: 0, label: "dom" },
  ];

  // Estado do builder
  let freq = "day";      // minute | hour | day | week | month
  let everyN = 5;        // p/ freq=minute (a cada N minutos)
  let hour = 9;
  let minute = 0;
  let dows = [1];        // dias da semana selecionados (freq=week)
  let dom = 1;           // dia do mês (freq=month)
  let advanced = false;
  let rawCron = cron;
  let syncing = false;   // evita loop parse<->build

  // ── Parse: cron -> controles (best-effort para os padrões que geramos) ──────
  function parse(expr) {
    const p = (expr || "").trim().split(/\s+/);
    if (p.length !== 5) return;
    const [mi, ho, dm, mo, dw] = p;
    const num = (x) => (/^\d+$/.test(x) ? parseInt(x, 10) : null);
    if (/^\*\/\d+$/.test(mi) && ho === "*" && dm === "*" && mo === "*" && dw === "*") {
      freq = "minute"; everyN = parseInt(mi.split("/")[1], 10); return;
    }
    if (num(mi) != null && ho === "*" && dm === "*" && mo === "*" && dw === "*") {
      freq = "hour"; minute = num(mi); return;
    }
    if (num(mi) != null && num(ho) != null && dm === "*" && mo === "*" && dw !== "*") {
      freq = "week"; minute = num(mi); hour = num(ho);
      dows = dw.split(",").map((x) => parseInt(x, 10)).filter((n) => !isNaN(n)); return;
    }
    if (num(mi) != null && num(ho) != null && num(dm) != null && mo === "*" && dw === "*") {
      freq = "month"; minute = num(mi); hour = num(ho); dom = num(dm); return;
    }
    if (num(mi) != null && num(ho) != null && dm === "*" && mo === "*" && dw === "*") {
      freq = "day"; minute = num(mi); hour = num(ho); return;
    }
    // Padrão não reconhecido: cai direto no modo avançado.
    advanced = true;
  }

  // ── Build: controles -> cron ────────────────────────────────────────────────
  function build() {
    const mm = Math.min(59, Math.max(0, minute | 0));
    const hh = Math.min(23, Math.max(0, hour | 0));
    switch (freq) {
      case "minute": return `*/${Math.min(59, Math.max(1, everyN | 0))} * * * *`;
      case "hour": return `${mm} * * * *`;
      case "day": return `${mm} ${hh} * * *`;
      case "week": {
        const days = (dows.length ? [...dows] : [1]).sort((a, b) => a - b).join(",");
        return `${mm} ${hh} * * ${days}`;
      }
      case "month": return `${mm} ${hh} ${Math.min(31, Math.max(1, dom | 0))} * *`;
      default: return cron;
    }
  }

  function commit() {
    if (advanced) return; // no modo avançado o cru manda
    syncing = true;
    cron = build();
    rawCron = cron;
    queueMicrotask(() => (syncing = false));
  }

  function commitRaw() {
    cron = rawCron.trim();
    parse(cron); // tenta trazer de volta para os controles
  }

  function toggleDow(v) {
    dows = dows.includes(v) ? dows.filter((x) => x !== v) : [...dows, v];
    commit();
  }

  // Parse inicial + reparse quando o cron muda por fora (troca de trigger).
  $: if (!syncing && cron !== rawCron) { rawCron = cron; parse(cron); }

  // ── Validação, descrição humana e próximos disparos ─────────────────────────
  const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  function isValid(expr) {
    const p = (expr || "").trim().split(/\s+/);
    if (p.length !== 5) return false;
    for (let i = 0; i < 5; i++) {
      if (p[i] === "*") continue;
      for (const seg of p[i].split(",")) {
        if (/^\*\/\d+$/.test(seg)) { if (parseInt(seg.split("/")[1], 10) < 1) return false; continue; }
        if (/^\d+-\d+$/.test(seg)) {
          const [a, b] = seg.split("-").map(Number);
          if (a < RANGES[i][0] || b > RANGES[i][1] || a > b) return false; continue;
        }
        const v = parseInt(seg, 10);
        if (isNaN(v) || v < RANGES[i][0] || v > RANGES[i][1]) return false;
      }
    }
    return true;
  }
  function matchField(val, field) {
    if (field === "*") return true;
    for (const seg of field.split(",")) {
      if (/^\*\/\d+$/.test(seg)) { if (val % parseInt(seg.split("/")[1], 10) === 0) return true; continue; }
      if (/^\d+-\d+$/.test(seg)) { const [a, b] = seg.split("-").map(Number); if (val >= a && val <= b) return true; continue; }
      if (parseInt(seg, 10) === val) return true;
    }
    return false;
  }
  function matches(expr, d) {
    const p = expr.trim().split(/\s+/);
    const dw = d.getDay();
    const dwOk = matchField(dw, p[4]) || (dw === 0 && matchField(7, p[4]));
    return matchField(d.getMinutes(), p[0]) && matchField(d.getHours(), p[1]) &&
      matchField(d.getDate(), p[2]) && matchField(d.getMonth() + 1, p[3]) && dwOk;
  }
  function nextRuns(expr, n = 3) {
    if (!isValid(expr)) return [];
    const out = [];
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 130000 && out.length < n; i++) { // ~90 dias
      if (matches(expr, d)) out.push(new Date(d));
      d.setMinutes(d.getMinutes() + 1);
    }
    return out;
  }

  const NAMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  function describe(expr) {
    if (!isValid(expr)) return "expressão inválida";
    const p = expr.trim().split(/\s+/);
    const [mi, ho] = p;
    const at = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    if (/^\*\/\d+$/.test(mi) && ho === "*") return `A cada ${mi.split("/")[1]} minutos`;
    if (/^\d+$/.test(mi) && ho === "*") return `Todo minuto ${mi} de cada hora`;
    if (/^\d+$/.test(mi) && /^\d+$/.test(ho)) {
      if (p[4] !== "*") {
        const days = p[4].split(",").map((x) => NAMES[parseInt(x, 10) % 7]).join(", ");
        return `Toda ${days} às ${at(ho, mi)}`;
      }
      if (p[2] !== "*") return `Dia ${p[2]} de cada mês às ${at(ho, mi)}`;
      return `Todo dia às ${at(ho, mi)}`;
    }
    return "agendamento personalizado";
  }

  const fmt = (d) => d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  $: valid = isValid(cron);
  $: upcoming = nextRuns(cron, 3);
  $: humanText = describe(cron);
</script>

<div class="cb">
  {#if !advanced}
    <div class="cb__row">
      <label class="cb__field">
        <span class="cb__lbl">Frequência</span>
        <select bind:value={freq} on:change={commit}>
          <option value="minute">A cada N minutos</option>
          <option value="hour">Toda hora</option>
          <option value="day">Todo dia</option>
          <option value="week">Toda semana</option>
          <option value="month">Todo mês</option>
        </select>
      </label>

      {#if freq === "minute"}
        <label class="cb__field cb__field--sm">
          <span class="cb__lbl">A cada</span>
          <div class="cb__inline"><input type="number" min="1" max="59" bind:value={everyN} on:input={commit} /><span class="cb__unit">min</span></div>
        </label>
      {/if}

      {#if freq === "hour"}
        <label class="cb__field cb__field--sm">
          <span class="cb__lbl">No minuto</span>
          <input type="number" min="0" max="59" bind:value={minute} on:input={commit} />
        </label>
      {/if}

      {#if freq === "day" || freq === "week" || freq === "month"}
        <label class="cb__field cb__field--sm">
          <span class="cb__lbl">Horário</span>
          <div class="cb__inline">
            <input type="number" min="0" max="23" bind:value={hour} on:input={commit} />
            <span class="cb__unit">:</span>
            <input type="number" min="0" max="59" bind:value={minute} on:input={commit} />
          </div>
        </label>
      {/if}

      {#if freq === "month"}
        <label class="cb__field cb__field--sm">
          <span class="cb__lbl">Dia do mês</span>
          <input type="number" min="1" max="31" bind:value={dom} on:input={commit} />
        </label>
      {/if}
    </div>

    {#if freq === "week"}
      <div class="cb__dows">
        {#each DOW as d}
          <button type="button" class="cb__dow" class:cb__dow--on={dows.includes(d.v)} on:click={() => toggleDow(d.v)}>{d.label}</button>
        {/each}
      </div>
    {/if}
  {:else}
    <label class="cb__field">
      <span class="cb__lbl">Expressão cron (min hora dia mês semana)</span>
      <input class="cb__raw" class:cb__raw--bad={!valid} bind:value={rawCron} on:input={commitRaw} placeholder="0 9 * * *" />
    </label>
  {/if}

  <div class="cb__preview">
    <div class="cb__human">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      <b>{humanText}</b>
      <button type="button" class="cb__adv" on:click={() => (advanced = !advanced)}>{advanced ? "simples" : "avançado"}</button>
    </div>
    {#if valid && upcoming.length}
      <div class="cb__next">
        <span class="cb__next-lbl">Próximos:</span>
        {#each upcoming as r}<span class="cb__chip">{fmt(r)}</span>{/each}
      </div>
    {:else if !valid}
      <div class="cb__bad">Expressão inválida — ajuste os campos.</div>
    {/if}
  </div>
</div>

<style>
  .cb { display: flex; flex-direction: column; gap: .5rem; width: 100%; }
  .cb__row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-end; }
  .cb__field { display: flex; flex-direction: column; gap: .2rem; }
  .cb__field--sm { max-width: 8rem; }
  .cb__lbl { font-size: .66rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--muted, #888); }
  .cb select, .cb input { font: inherit; font-size: .82rem; padding: .34rem .5rem; border: 1px solid var(--border, #e0e0e0); border-radius: .4rem; background: var(--surface, #fff); color: var(--text, #111); }
  .cb__inline { display: flex; align-items: center; gap: .25rem; }
  .cb__inline input { width: 3.2rem; text-align: center; }
  .cb__unit { color: var(--muted, #888); font-size: .82rem; }
  .cb__raw { font-family: var(--mono, monospace); width: 100%; box-sizing: border-box; }
  .cb__raw--bad { border-color: var(--danger, #dc2626); }

  .cb__dows { display: flex; gap: .3rem; flex-wrap: wrap; }
  .cb__dow { font: inherit; font-size: .74rem; font-weight: 600; padding: .28rem .55rem; border-radius: .4rem; border: 1px solid var(--border, #e0e0e0); background: var(--surface, #fff); color: var(--muted, #888); cursor: pointer; text-transform: capitalize; transition: all 160ms ease; }
  .cb__dow--on { background: var(--accent, #5b5bd6); border-color: var(--accent, #5b5bd6); color: #fff; }

  .cb__preview { display: flex; flex-direction: column; gap: .35rem; padding: .5rem .6rem; border-radius: .5rem; background: var(--surface-2, #f5f5f5); border: 1px solid var(--border, #e8e8e8); }
  .cb__human { display: flex; align-items: center; gap: .4rem; font-size: .84rem; color: var(--text, #111); }
  .cb__human b { font-weight: 600; }
  .cb__adv { margin-left: auto; font: inherit; font-size: .72rem; background: none; border: none; color: var(--accent, #5b5bd6); cursor: pointer; text-decoration: underline; }
  .cb__next { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; font-size: .74rem; }
  .cb__next-lbl { color: var(--muted, #888); font-weight: 600; }
  .cb__chip { font-family: var(--mono, monospace); font-size: .72rem; padding: .12rem .4rem; border-radius: .3rem; background: var(--surface, #fff); border: 1px solid var(--border, #e8e8e8); color: var(--muted, #666); text-transform: capitalize; }
  .cb__bad { font-size: .76rem; color: var(--danger, #dc2626); }
</style>
