// packages/flows/lib/tap.js — grampo (tap) do event bus do Lógos.
//
// Por quê: handlers do bus recebem (payload, ctx) mas NUNCA o nome do evento, e
// não existe log central. A única forma de descobrir eventos e amostrar seus
// formatos é envolver (monkeypatch) os três pontos de dispatch do bus singleton:
// emit / pipeline / veto. `arguments[0]` é o nome do evento.
//
// Política de captura (decisão do usuário): apenas o FORMATO (chaves → tipos),
// nunca os valores. Em memória. Além disso, cada (nome, payload) é enfileirado
// para o matcher semântico consumir fora do caminho de dispatch.
//
// Segurança: o registro é O(1), envolto em try/catch — observação jamais pode
// quebrar ou atrasar o dispatch. O wrapper é instalado na instância singleton do
// bus (criada 1x em container.ts), então sobrevive a hot-reload de pacotes; um
// guard em globalThis impede duplo-wrapping quando o próprio flows recarrega.

'use strict';

// shapeOf/mergeShape vivem em lib/shape.js: o catálogo do tap é volátil (some no
// reboot), então os workflows PERSISTEM o shape do evento que os dispara usando
// exatamente as mesmas funções — ver store.absorbTriggerShape.
const { shapeOf, mergeShape } = require('./shape');

// Namespaces ignorados por padrão no catálogo (ruído/alta frequência/reservados).
const DEFAULT_DENY = [
  'llm:', 'http:', 'runtime:', 'package:', 'reload:', 'db:', 'views:',
  'proc:', 'route:', 'auth:', 'bag:', 'save:',
];

const MAX_EVENTS = 500;       // limite de nomes distintos no catálogo
const QUEUE_MAX = 200;        // fila para o matcher semântico

// Estado global (sobrevive ao reload do módulo flows).
const TAP = (globalThis.__flowsEventTap = globalThis.__flowsEventTap || {
  installed: false,
  catalog: new Map(),         // eventName -> { count, lastSeen, shape }
  deny: DEFAULT_DENY.slice(),
  queue: [],                  // [{ event, payload }] p/ consumo assíncrono
  consumer: null,             // fn(event, payload) registrada pelo semantic.js
});

function isDenied(event) {
  return TAP.deny.some((p) => event.startsWith(p));
}

function record(event, payload) {
  if (isDenied(event)) return;
  let e = TAP.catalog.get(event);
  const shape = payload === undefined ? 'undefined' : shapeOf(payload);
  if (!e) {
    if (TAP.catalog.size >= MAX_EVENTS) return; // não cresce sem limite
    e = { count: 0, lastSeen: null, shape };
    TAP.catalog.set(event, e);
  } else {
    e.shape = mergeShape(e.shape, shape);
  }
  e.count++;
  e.lastSeen = Date.now();

  // enfileira para o matcher semântico (não bloqueia o dispatch)
  if (TAP.consumer) {
    TAP.queue.push({ event, payload });
    if (TAP.queue.length > QUEUE_MAX) TAP.queue.shift();
    drain();
  }
}

let draining = false;
async function drain() {
  if (draining || !TAP.consumer) return;
  draining = true;
  try {
    while (TAP.queue.length) {
      const { event, payload } = TAP.queue.shift();
      try { await TAP.consumer(event, payload); } catch { /* nunca propaga */ }
    }
  } finally {
    draining = false;
  }
}

// ── API pública ────────────────────────────────────────────────────────────────

// Instala o wrapper no bus singleton. `bus` = getDefaultContainer().bus.
function install(bus) {
  if (!bus || TAP.installed) return TAP.installed;
  for (const m of ['emit', 'pipeline', 'veto']) {
    if (typeof bus[m] !== 'function') continue;
    const orig = bus[m].bind(bus);
    bus[m] = function (event, payload, ctx) {
      try { record(event, payload); } catch { /* observação nunca quebra o bus */ }
      return orig(event, payload, ctx);
    };
  }
  TAP.installed = true;
  return true;
}

// Registra o consumidor da fila (o matcher semântico).
function onEvent(consumer) {
  TAP.consumer = consumer;
  drain();
}

// Catálogo para a UI: nomes reais + payload sugerido (derivado do shape).
function catalog() {
  const out = [];
  for (const [event, e] of TAP.catalog.entries()) {
    out.push({
      event,
      count: e.count,
      lastSeen: e.lastSeen,
      suggestedPayload: e.shape,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// Shape observado de UM evento (null se o tap ainda não viu tráfego dele — o
// que é o normal logo após um reboot, já que o catálogo é só memória).
function shapeFor(event) {
  const e = event ? TAP.catalog.get(event) : null;
  return e && e.shape && typeof e.shape === 'object' ? e.shape : null;
}

function setDeny(list) {
  if (Array.isArray(list)) TAP.deny = list.slice();
}

module.exports = { install, onEvent, catalog, shapeFor, setDeny, shapeOf };
