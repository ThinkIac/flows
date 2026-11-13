// packages/flows/lib/embedder.js — embeddings para o gatilho semântico.
//
// Estratégia (decisão do usuário): Ollama LOCAL primeiro; se indisponível,
// tenta o embedding da agent (API OpenAI-compat); se nada funcionar, retorna
// null — o gatilho semântico degrada e a UI sinaliza "embeddings indisponíveis".
//
// Config por env:
//   FLOWS_OLLAMA_URL   (default http://localhost:11434)
//   FLOWS_EMBED_MODEL  (default nomic-embed-text)

'use strict';

const path = require('path');

const OLLAMA_URL = (process.env.FLOWS_OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.FLOWS_EMBED_MODEL || 'nomic-embed-text';

let _backend = null; // 'ollama' | 'agent' | 'none' | null(=desconhecido)

async function tryOllama(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.embedding)) throw new Error('ollama: sem embedding');
  return json.embedding;
}

async function tryAgent(text) {
  const mod = await import(path.join(__dirname, '..', '..', 'agent', 'llm', 'llm.js'));
  if (typeof mod.getEmbedding !== 'function') throw new Error('agent: getEmbedding ausente');
  return mod.getEmbedding(text);
}

// Retorna number[] ou null (nunca lança).
async function embed(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // ordem preferida, com memória do backend que funcionou
  const order = _backend === 'agent' ? [tryAgent, tryOllama] : [tryOllama, tryAgent];
  const names = _backend === 'agent' ? ['agent', 'ollama'] : ['ollama', 'agent'];

  for (let i = 0; i < order.length; i++) {
    try {
      const vec = await order[i](t);
      if (Array.isArray(vec) && vec.length) {
        _backend = names[i];
        return vec;
      }
    } catch { /* tenta o próximo */ }
  }
  _backend = 'none';
  return null;
}

// Similaridade de cosseno. Retorna -1 em entrada inválida.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Estado para a UI: qual backend está ativo (ou desconhecido/none).
function status() {
  return { backend: _backend, model: EMBED_MODEL, ollamaUrl: OLLAMA_URL };
}

// Força uma sondagem para descobrir o backend disponível.
async function probe() {
  const v = await embed('ping');
  return { available: v !== null, ...status() };
}

module.exports = { embed, cosine, status, probe };
