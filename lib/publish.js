// packages/flows/lib/publish.js — publica um flow como tool @register_tool.
//
// Gera flows/generated/<id>.js (CJS, trivial e não-lançante no load): a função
// tem o JSDoc @register_tool com @param derivados de wf.inputs; o corpo delega a
// runner.runById, rodando o flow com os args como `trigger`.
//
// O runtime descobre o arquivo automaticamente (cache por mtime + stabilizer).
// Mitigações: gravação atômica; require pesado só DENTRO da função (load barato);
// publish é explícito por flow (flag publishAsTool) para evitar churn do stabilizer.

'use strict';

const fs = require('fs');
const path = require('path');

const GEN_DIR = path.join(__dirname, '..', 'generated');

function ensureGenDir() {
  if (!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR, { recursive: true });
}

function slug(name) {
  return (name || 'flow').toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'flow';
}

function toolNameFor(wf) { return `flow_${slug(wf.name)}_${wf.id.slice(-6)}`; }
function fileFor(wf) { return path.join(GEN_DIR, `${wf.id}.js`); }

function jsdocParams(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return '';
  return inputs.map((i) => {
    const t = i.required ? i.type : `${i.type}?`;
    const desc = (i.description || i.name).replace(/\n/g, ' ');
    return `   * @param {${t}} ${i.name} - ${desc}`;
  }).join('\n') + '\n';
}

function template(wf) {
  const toolName = toolNameFor(wf);
  const desc = (wf.description || wf.name || 'Executa um flow do Flows')
    .replace(/\*\//g, '* /').replace(/\n/g, ' ').slice(0, 200);
  const params = jsdocParams(wf.inputs);
  return `// AUTO-GERADO pelo pacote flows — NÃO EDITE. Regenere pelo editor/publish.
// Flow: ${wf.name} (${wf.id})
'use strict';
const path = require('path');

async function ${toolName}(args = {}) {
  /**
   * @register_tool ${toolName}
   * @description ${desc}
${params}   */
  try {
    const { runById } = require(path.join(__dirname, '..', 'lib', 'runner.js'));
    const run = await runById('${wf.id}', args || {}, { source: 'published-tool' });
    return {
      success: run.status !== 'error' && run.status !== 'aborted',
      status: run.status,
      runId: run.id,
      error: run.error || null,
      nodes: run.nodes,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { ${toolName} };
`;
}

// Escreve/atualiza o arquivo gerado. Retorna { tool, file }.
function publish(wf) {
  ensureGenDir();
  const file = fileFor(wf);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, template(wf), 'utf8');
  fs.renameSync(tmp, file);
  return { tool: toolNameFor(wf), file: path.relative(path.join(__dirname, '..'), file) };
}

// Remove o arquivo gerado (se existir).
function unpublish(wf) {
  const file = fileFor(wf);
  if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
  return false;
}

function isPublished(wf) { return fs.existsSync(fileFor(wf)); }

module.exports = { publish, unpublish, isPublished, toolNameFor, GEN_DIR };
