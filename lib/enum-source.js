// packages/flows/lib/enum-source.js — resolve `x-enumSource` de um @param.
//
// O Lógos declara a fonte no JSDoc (`@enumSource …`) e ela viaja no schema como
// metadado `x-enumSource`, porque o JSON Schema é estático e a fonte é viva.
// Quem resolve é o consumidor — aqui.
//
// Esquemas suportados:
//   tool:<pacote>/<tool>[#campo]      chama outra @register_tool e lê o campo
//   scriba:<tenant>/<entidade>[#campo] lista uma coleção do Scriba
//   https://…                         GET externo (exige allowlist de host)
//
// Regras de ouro:
//   - fonte fora do ar nunca trava o inspetor: devolve null e a UI cai pra texto
//   - fonte externa é request feita pelo servidor: só hosts da allowlist
//     (FLOWS_ENUM_SOURCE_HOSTS, csv). Vazio = fonte externa desligada.

'use strict';

const TTL = 15000;
const MAX_OPTIONS = 200;
const FETCH_TIMEOUT = 4000;

const _cache = new Map(); // source -> { at, options }

function allowedHosts() {
  return (process.env.FLOWS_ENUM_SOURCE_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

// Um item pode ser string ou objeto. Com `#campo` lemos aquele campo; sem ele,
// tentamos as chaves convencionais antes de desistir do item.
function toOption(item, field) {
  if (item == null) return null;
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item !== 'object') return null;
  const value = field ? item[field] : (item.value ?? item.id ?? item.name ?? item.key);
  return value == null ? null : String(value);
}

function normalize(raw, field) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.options) ? raw.options
    : Array.isArray(raw?.data) ? raw.data
    : null;
  if (!list) return null;
  const options = [];
  for (const item of list) {
    const opt = toOption(item, field);
    if (opt !== null && !options.includes(opt)) options.push(opt);
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}

// "esquema:resto#campo" — o campo é opcional e sempre o último trecho.
function parseSource(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const [locator, field = null] = source.trim().split('#');
  if (/^https?:\/\//i.test(locator)) return { kind: 'http', locator, field };
  const sep = locator.indexOf(':');
  if (sep === -1) return null;
  const kind = locator.slice(0, sep);
  const target = locator.slice(sep + 1);
  if (!target) return null;
  if (kind === 'tool' || kind === 'scriba') return { kind, target, field };
  return null;
}

async function fromTool(target) {
  const [pkg, tool] = target.includes('/') ? target.split('/') : [null, target];
  if (!tool) return null;
  const { runTool } = require('./tools');
  return runTool(pkg, tool, {});
}

async function fromScriba(target) {
  const [tenant, entity] = target.split('/');
  if (!tenant || !entity) return null;
  const { getProxy } = require('logos/dist/src/modules/db');
  const db = getProxy(tenant);
  return db[entity].findMany({ take: MAX_OPTIONS });
}

async function fromHttp(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (!allowedHosts().includes(host)) {
    throw new Error(`host "${host}" fora da allowlist (FLOWS_ENUM_SOURCE_HOSTS)`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    // redirect:'manual' — um 302 poderia levar a request do servidor pra um
    // host que não está na allowlist.
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve uma fonte em uma lista de opções.
 * Devolve `null` quando a fonte não resolve — o chamador cai pra texto livre.
 */
async function resolve(source, { force = false } = {}) {
  const parsed = parseSource(source);
  if (!parsed) return null;

  const now = Date.now();
  const hit = _cache.get(source);
  if (!force && hit && now - hit.at < TTL) return hit.options;

  let raw;
  try {
    if (parsed.kind === 'tool') raw = await fromTool(parsed.target);
    else if (parsed.kind === 'scriba') raw = await fromScriba(parsed.target);
    else raw = await fromHttp(parsed.locator);
  } catch {
    return null;
  }

  const options = normalize(raw, parsed.field);
  if (!options) return null;
  _cache.set(source, { at: now, options });
  return options;
}

function invalidate() { _cache.clear(); }

module.exports = { resolve, invalidate, parseSource, normalize };
