// packages/flows/lib/semantic.js — gatilho semântico por embeddings.
//
// Regras vivem como triggers do tipo `semantic` nos workflows:
//   trigger = { type:'semantic', text:'sempre que der erro no WhatsApp', threshold:0.6 }
//
// Para cada evento observado pelo tap, montamos um descritor textual
// (nome do evento + chaves/valores curtos do payload), embedamos e comparamos
// por cosseno com o embedding de cada regra. Acima do threshold, roda o flow.
//
// Custo controlado: cache de embeddings por descritor e por texto de regra;
// roda fora do caminho de dispatch (consumidor da fila do tap).

'use strict';

const store = require('./store');
const { embed, cosine, status: embStatus } = require('./embedder');

const DESC_CACHE_MAX = 300;
const descCache = new Map(); // descriptor -> embedding | null
const ruleCache = new Map(); // ruleText -> embedding | null

let runner = null; // fn(workflow, payload, meta)

function init({ runFlow }) { runner = runFlow; }

// descritor textual de um evento (transitório — não é persistido)
function describe(eventName, payload) {
  const parts = [eventName.replace(/[:._-]+/g, ' ')];
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload).slice(0, 12)) {
      if (k.startsWith('_flow')) continue;
      if (v == null) { parts.push(k); continue; }
      const t = typeof v;
      if (t === 'string') parts.push(`${k} ${v.slice(0, 60)}`);
      else if (t === 'number' || t === 'boolean') parts.push(`${k} ${v}`);
      else parts.push(k);
    }
  }
  return parts.join(' ').toLowerCase().slice(0, 400);
}

async function embedCached(cache, key) {
  if (cache.has(key)) return cache.get(key);
  const vec = await embed(key);
  if (cache.size >= DESC_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, vec);
  return vec;
}

// regras semânticas ativas (dos workflows)
function rules() {
  return store.listWorkflows()
    .filter((w) => w.enabled && w.trigger?.type === 'semantic' && (w.trigger.text || '').trim())
    .map((w) => ({ workflow: w, text: w.trigger.text.trim(), threshold: w.trigger.threshold ?? 0.6 }));
}

// chamado pelo tap para cada (evento, payload)
async function handle(eventName, payload) {
  if (!runner) return;
  const rs = rules();
  if (!rs.length) return;

  const descEmb = await embedCached(descCache, describe(eventName, payload));
  if (!descEmb) return; // embeddings indisponíveis → degrada silenciosamente

  for (const r of rs) {
    const ruleEmb = await embedCached(ruleCache, r.text.toLowerCase());
    if (!ruleEmb) continue;
    const score = cosine(descEmb, ruleEmb);
    if (score >= r.threshold) {
      try {
        await runner(r.workflow, { event: eventName, payload, _semanticScore: score }, { source: `semantic:${eventName}` });
      } catch { /* nunca propaga para o bus */ }
    }
  }
}

// invalida caches de regras quando um workflow muda
function invalidateRules() { ruleCache.clear(); }

// diagnóstico para a UI
async function health() {
  const rs = rules();
  const probe = await embed('teste');
  return {
    available: probe !== null,
    ...embStatus(),
    rules: rs.length,
  };
}

module.exports = { init, handle, invalidateRules, health, describe };
