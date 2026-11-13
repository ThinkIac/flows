import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import store from './store.js';

const root = dirname(fileURLToPath(import.meta.url));
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const literal = value => typeof value === 'string' && /^[\w-]+$/.test(value);

// Fingerprint implementation files, including helper modules, without reading
// runtime data, uploads or credentials. Changes require another explicit grant.
function fingerprintPackage(name) {
  if (!literal(name)) throw new Error('Pacote inválido');
  const files = [];
  function walk(dir, relative = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', 'data', 'uploads', 'secrets', 'test', 'tests', 'views'].includes(entry.name)) continue;
      const rel = join(relative, entry.name), path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile() && (/\.(?:[cm]?js|ts)$/.test(entry.name) || entry.name === 'package.json')) files.push([rel, readFileSync(path, 'utf8')]);
    }
  }
  walk(join(root, '..', '..', name));
  if (!files.length) throw new Error('Implementação da ferramenta indisponível');
  return hash(files);
}

export function createAuthorizationStore({ file, getWorkflow, fingerprintPackage }) {
  function read() {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  function write(data) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  }
  function scope(wf) {
    if (!wf) throw new Error('Flow não encontrado');
    const actions = (wf.nodes || []).flatMap(n => {
      if (n.type === 'tool' && literal(n.config?.package) && literal(n.config?.name)) return [{
        nodeId: n.id, package: n.config.package, tool: n.config.name, args: n.config.args || {}, codeHash: fingerprintPackage(n.config.package),
      }];
      // Um nó Agent também é uma ação de custo. Incluí-lo no escopo torna a
      // autorização explícita e permite que execuções agendadas não parem no
      // gate de governança a cada rodada.
      if (n.type === 'agent' && (n.config?.goal || n.config?.prompt)) {
        const boundTools = (wf.nodes || []).filter(binding => binding.type === 'agent-tool' && binding.ownerAgentId === n.id).map(binding => binding.config?.toolName).filter(literal);
        const nestedTools = boundTools.length ? boundTools : (Array.isArray(n.config?.toolNames) ? n.config.toolNames.filter(literal) : []);
        return [{
        nodeId: n.id, package: 'agent', tool: n.config?.mode === 'simple' ? 'call_llm' : 'call_llm_agent',
        args: { goal: n.config.goal || n.config.prompt || '', model: n.config.model || '', toolNames: nestedTools }, codeHash: fingerprintPackage('agent'),
        // Tools do agente são autorizadas individualmente pelo nome. Não há
        // coringa: autoTools/allTools continuam exigindo confirmação, pois a
        // identidade delas só aparece durante a execução.
        nestedTools,
      }];
      }
      return [];
    });
    const trigger = { ...wf.trigger }; delete trigger.shape;
    const definition = { id: wf.id, trigger, executionMode: wf.executionMode || 'best-effort',
      autoApprovePermissions: wf.autoApprovePermissions === true, inputs: wf.inputs || [],
      nodes: (wf.nodes || []).map(n => ({ id: n.id, type: n.type, config: n.config || {} })),
      edges: (wf.edges || []).map(e => ({ from: e.from, fromPort: e.fromPort || 'out', to: e.to })), actions };
    return { scopeHash: hash(definition), actions };
  }
  function preview(id) {
    const current = scope(getWorkflow(id)), grant = read()[id];
    const automatic = getWorkflow(id)?.autoApprovePermissions === true;
    const explicitActive = !!grant && !grant.revokedAt && grant.scopeHash === current.scopeHash;
    return { ...current, active: automatic || explicitActive, automatic, explicitActive, grantedAt: grant?.grantedAt || null, revokedAt: grant?.revokedAt || null };
  }
  function approve(id, expectedHash) {
    const current = scope(getWorkflow(id));
    if (!expectedHash || expectedHash !== current.scopeHash) throw new Error('Flow alterado. Revise o escopo novamente.');
    if (!current.actions.length) throw new Error('Nenhuma ferramenta com pacote e nome fixos para autorizar.');
    const all = read();
    all[id] = { id: randomUUID(), scopeHash: current.scopeHash, grantedAt: new Date().toISOString() };
    write(all);
    return preview(id);
  }
  function revoke(id) {
    const all = read();
    if (all[id]) { all[id].revokedAt = new Date().toISOString(); write(all); }
    return { active: false };
  }
  function match(context, pkg, tool) {
    try {
      if (!context?.workflow?.id || !context.nodeId) return null;
      const wf = getWorkflow(context.workflow.id), grant = read()[context.workflow.id];
      if (!wf) return null;
      const current = scope(wf);
      // A definição em execução precisa ser exatamente a salva. Isso também
      // protege retomadas duráveis contra uma permissão habilitada depois que o
      // run começou e contra snapshots antigos após qualquer edição.
      if (scope(context.workflow).scopeHash !== current.scopeHash) return null;
      const action = current.actions.find(a => a.nodeId === context.nodeId && a.package === pkg && a.tool === tool);
      // Uma tool chamada pelo loop interno da Agent não tem package fixo na
      // definição (a API da LLM seleciona por nome). Só passa quando o nome foi
      // revisado e salvo no nó agent; `allTools` e `autoTools` não herdam isso.
      const nested = !pkg && current.actions.some(a => a.nodeId === context.nodeId && a.package === 'agent' && a.tool === 'call_llm_agent' && a.nestedTools?.includes(tool));
      if (!action && !nested) return null;
      if (wf.autoApprovePermissions === true) {
        return { id: `auto:${current.scopeHash}`, workflowId: wf.id, nodeId: context.nodeId, source: 'flow:auto-approve' };
      }
      if (!grant || grant.revokedAt || grant.scopeHash !== current.scopeHash) return null;
      return { id: grant.id, workflowId: wf.id, nodeId: context.nodeId };
    } catch { return null; } // Unreadable or stale authority must fail closed.
  }
  return { preview, approve, revoke, match, scopeHash: wf => scope(wf).scopeHash };
}

export const authorizations = createAuthorizationStore({ file: join(root, '..', 'data', 'authorizations.json'), getWorkflow: store.getWorkflow, fingerprintPackage });
