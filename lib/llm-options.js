// packages/flows/lib/llm-options.js — catálogo de opções de LLM para o nó Agente.
//
// Expõe, para a UI do editor, o que dá para escolher no roteamento do LLM:
//   • elms      — modelos de fachada (ada-thin/flash/…), ids selecionáveis de verdade
//   • providers — providers ativos (derivados dos slots configurados)
//   • accesses  — combinações modelo@acesso do catálogo global
//
// Fonte da verdade é agent/llm (ESM). Importamos via import() dinâmico — mesmo
// padrão de lib/tools.js — porque flows é CJS. Cacheado por TTL curto.

'use strict';

const path = require('path');

const LLM_DIR = path.join(__dirname, '..', '..', 'agent', 'llm');
const CONFIG = path.join(__dirname, '..', '..', 'agent', 'utils', 'config.js');

async function mods() {
  const [elm, keys, registry, cfg] = await Promise.all([
    import(path.join(LLM_DIR, 'elm.js')),
    import(path.join(LLM_DIR, 'llm_keys.js')),
    import(path.join(LLM_DIR, 'model_registry.js')),
    import(CONFIG),
  ]);
  return { elm, keys, registry, cfg };
}

let _cache = null;
let _cacheAt = 0;
const TTL = 30000;

async function options({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < TTL) return _cache;

  const { elm, keys, registry, cfg } = await mods();

  // getConfig pode lançar se agent.config.json não existir (ex.: worktree sem o
  // arquivo untracked). Degrada para uma lista vazia.
  let config = null;
  try { config = cfg.getConfig(); } catch { /* segue sem config */ }

  // ELMs — ids de modelo de fachada selecionáveis (ada-thin etc.).
  let elms = [];
  try {
    elms = elm.listElms(config || undefined).map((e) => ({
      id: e.id, tier: e.tier, description: e.description || '',
      members: Array.isArray(e.members) ? e.members : [],
    }));
  } catch { /* elm map pode não estar configurado */ }

  // Providers ativos + ids de modelo concretos vistos nos slots.
  let providers = [];
  let models = [];
  let accesses = [];
  try {
    const slots = keys.buildSlots(config || undefined);
    providers = [...new Set(slots.map((s) => s.provider).filter(Boolean))];
    models = [...new Set(slots.map((s) => s.model).filter(Boolean))];
    accesses = registry.getGlobalModelCatalog().accesses;
  } catch { /* sem pools configurados */ }

  _cache = { accesses, elms, providers, models };
  _cacheAt = now;
  return _cache;
}

function invalidate() { _cache = null; _cacheAt = 0; }

module.exports = { options, invalidate };
