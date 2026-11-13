// flows/lib/templates.js — templates de flow distribuídos pelos pacotes.
//
// Qualquer pacote pode entregar flows prontos: basta um arquivo `*.flow.json`
// dentro dele (por convenção em `<pacote>/flows/`). Este módulo varre
// packages/ atrás desses arquivos e os oferece como modelos — o usuário cria um
// workflow "a partir de" um template em vez de montar o grafo do zero.
//
// Configuração externa: as variáveis SOLTAS do template (nós `set` sem nenhuma
// conexão — ver a declaração antecipada em graph-engine) viram o formulário
// dinâmico exibido na criação. É por elas que o mesmo template atende a
// contextos diferentes sem edição do grafo.

'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGES_DIR = path.join(__dirname, '..', '..');
// Profundidade curta: `<pacote>/x.flow.json` e `<pacote>/flows/x.flow.json`
// bastam para a convenção — varrer a árvore inteira arrastaria node_modules.
const MAX_DEPTH = 2;
const IGNORED = new Set(['node_modules', '.git', 'uploads', 'generated', 'data', 'views', 'public', '.database']);

const CACHE = { at: 0, list: [] };
const TTL_MS = 30_000;

function scanDir(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH || IGNORED.has(entry.name)) continue;
      scanDir(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.flow.json')) {
      out.push(full);
    }
  }
}

// Um `set` solto = declarado, nunca conectado. É exatamente o que o motor
// executa antes de tudo, e o que o formulário de criação precisa preencher.
function looseVariables(wf) {
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  const connected = new Set();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  return nodes
    .filter((n) => n.type === 'set' && !connected.has(n.id))
    .map((n) => ({
      nodeId: n.id,
      key: (n.config && n.config.key) || n.name || 'value',
      label: n.name || (n.config && n.config.key) || 'Variável',
      description: (n.config && n.config.description) || null,
      default: n.config ? n.config.value : undefined,
    }));
}

function readTemplate(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;

  const rel = path.relative(PACKAGES_DIR, file);
  const pkg = rel.split(path.sep)[0];
  return {
    // O id é o caminho relativo: estável entre reinícios e sem estado extra.
    id: rel.split(path.sep).join('/'),
    package: pkg,
    name: raw.name || path.basename(file, '.flow.json'),
    description: raw.description || '',
    nodeCount: raw.nodes.length,
    trigger: raw.trigger || { type: 'manual' },
    variables: looseVariables(raw),
    file,
  };
}

function list({ force = false } = {}) {
  if (!force && Date.now() - CACHE.at < TTL_MS) return CACHE.list;
  const files = [];
  scanDir(PACKAGES_DIR, 0, files);
  const list = files.map(readTemplate).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  CACHE.at = Date.now();
  CACHE.list = list;
  return list;
}

function get(templateId) {
  return list().find((t) => t.id === templateId) || null;
}

/* Monta o payload de criação a partir do template, aplicando os valores que o
 * usuário informou no formulário. Só os nós `set` soltos recebem valor — o
 * resto do grafo vem do arquivo, intacto.
 */
function instantiate(templateId, { name, values = {} } = {}) {
  const template = get(templateId);
  if (!template) return null;

  let raw;
  try { raw = JSON.parse(fs.readFileSync(template.file, 'utf8')); } catch { return null; }

  const byNode = new Map(template.variables.map((v) => [v.nodeId, v]));
  const nodes = (raw.nodes || []).map((node) => {
    const variable = byNode.get(node.id);
    if (!variable) return node;
    // Aceita o valor por nodeId ou pela chave da variável (o formulário usa a
    // chave, que é o nome com que o resto do grafo a referencia).
    const provided = values[node.id] !== undefined ? values[node.id] : values[variable.key];
    if (provided === undefined || provided === '') return node;
    return { ...node, config: { ...(node.config || {}), value: provided } };
  });

  return {
    name: name || raw.name || template.name,
    description: raw.description || '',
    trigger: raw.trigger || { type: 'manual' },
    executionMode: raw.executionMode === 'durable' ? 'durable' : 'best-effort',
    nodes,
    edges: raw.edges || [],
    inputs: raw.inputs || [],
    // Um flow criado a partir de template nasce desligado: o usuário revisa o
    // grafo (e o gatilho) antes de deixá-lo disparar sozinho.
    enabled: false,
    fromTemplate: template.id,
  };
}

module.exports = { list, get, instantiate, looseVariables };
