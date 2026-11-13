// packages/flows/lib/tools.js — catálogo e invocação de tools @register_tool.
//
// Fonte da verdade: agent/core/runtime_bridge.js (ESM), que agrega todas as
// tools de todos os pacotes com seus JSON-schemas e já cacheia por mtime.
// Importamos via import() dinâmico (mesmo padrão do scheduler), pois flows é CJS.

'use strict';

const path = require('path');
const enumSource = require('./enum-source');

const BRIDGE = path.join(__dirname, '..', '..', 'agent', 'core', 'runtime_bridge.js');

async function bridge() {
  return import(BRIDGE);
}

// mapeia o tipo do schema para um controle de UI (espelha o scheduler).
// Enum (estático ou de fonte viva) manda no controle: vira select.
function mapParamType(type, schema = {}) {
  if (schema.enum || schema['x-enumSource']) return 'select';
  switch (type) {
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'checkbox';
    case 'object':
    case 'array': return 'textarea';
    default: return 'text';
  }
}

// converte parameters JSON-schema -> campos de formulário para o inspetor do editor
function paramFields(tool) {
  const props = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];
  return Object.entries(props).map(([key, schema]) => ({
    key,
    type: mapParamType(schema.type, schema),
    schemaType: schema.type || 'string',
    description: schema.description || key,
    required: required.includes(key),
    enum: schema.enum || null,
    // fonte viva declarada no JSDoc (@enumSource) — resolvida sob demanda
    // pela rota tools/options, nunca aqui (o catálogo precisa ser barato).
    enumSource: schema['x-enumSource'] || null,
    default: schema.default ?? '',
    placeholder: schema.example || schema.description || key,
  }));
}

let _cache = null;
let _cacheAt = 0;
const TTL = 15000;

// Catálogo de tools normalizado para a UI. Cacheado por TTL curto (a descoberta
// já é cacheada por mtime no bridge; este TTL só evita chamadas repetidas).
async function catalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < TTL) return _cache;
  const { discoverRuntimeTools } = await bridge();
  const tools = await discoverRuntimeTools();
  _cache = tools.map((t) => ({
    package: t.package,
    name: t.name,
    description: t.description || '',
    params: paramFields(t),
  }));
  _cacheAt = now;
  return _cache;
}

// Executa uma tool por nome (opcionalmente com o package explícito p/ evitar
// ambiguidade). Retorna o resultado bruto da tool.
async function runTool(packageName, toolName, args = {}, governance = null) {
  const { invokeRuntimeTool } = await bridge();
  // The graph supplies this context outside tool arguments. Never accept a grant
  // from a trigger payload or from an agent node's generated tool calls.
  let options = governance;
  if (governance?.flowContext) {
    const { authorizations } = await import('./authorization.mjs');
    options = { ...governance, authorize: (call = null) => authorizations.match(
      governance.flowContext,
      // Os nós Agent invocam as ferramentas do pacote `agent` sem informar o
      // pacote, para manter compatibilidade com o catálogo global. O escopo de
      // autorização, por outro lado, registra esse pacote explicitamente. Sem
      // esta normalização a permissão automática nunca correspondia e todo
      // Agent de um Flow parava no preset Read only.
      call?.nested ? null : (packageName || (toolName === 'call_llm' || toolName === 'call_llm_agent' ? 'agent' : null)),
      call?.nested ? call.name : toolName,
    ) };
  }
  return invokeRuntimeTool(packageName || null, toolName, args || {}, options);
}

// Resolve as opções de um parâmetro com fonte viva (@enumSource).
// `source` chega do cliente, então só resolvemos fontes que algum parâmetro do
// catálogo realmente declara — sem esse filtro a rota viraria "chame qualquer
// tool via querystring". Devolve null quando não resolve: a UI cai pra texto.
async function resolveOptions(source, { force = false } = {}) {
  const tools = await catalog();
  const declared = tools.some((t) => t.params.some((p) => p.enumSource === source));
  if (!declared) return null;
  return enumSource.resolve(source, { force });
}

function invalidate() {
  _cache = null;
  _cacheAt = 0;
  enumSource.invalidate();
}

module.exports = { catalog, runTool, paramFields, resolveOptions, invalidate };
