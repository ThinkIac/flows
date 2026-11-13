const BASE = '/flows';

export const NODE_TYPES = [
  ['log', 'Log'], ['set', 'Set variable'], ['agent', 'Agent (LLM)'], ['session-message', 'Session message'],
  ['http', 'HTTP'], ['condition', 'Condition'], ['switch', 'Switch'], ['iterate', 'Iterate'], ['merge', 'Merge'],
  ['delay', 'Delay'], ['emit', 'Emit event'], ['sub-flow', 'Sub-flow'],
];

export function context() {
  return contextFromSearch(window.location.search);
}

/**
 * The workspace host is allowed to add its own query parameters.  Keep the
 * domain id independent from those parameters so every Flow component reads
 * precisely the same context.
 */
export function contextFromSearch(search = '') {
  const query = new URLSearchParams(search);
  return {
    workspaceId: query.get('workspaceId') || '', documentId: query.get('documentId') || '',
    flowId: query.get('id') || query.get('itemId') || '', componentId: query.get('widgetId') || '',
    role: query.get('widgetRole') || '',
  };
}

export function normalize(flow) {
  const value = flow || {};
  value.nodes = Array.isArray(value.nodes) ? value.nodes.map((node) => ({ ...node, config: node.config || {}, position: node.position || { x: 100, y: 100 } })) : [];
  value.edges = Array.isArray(value.edges) ? value.edges : [];
  value.trigger = value.trigger || { type: 'manual' };
  // Trigger is a real graph node.  Its position deliberately clears the
  // canvas chrome, so a newly-created Flow never appears empty.
  if (!value.nodes.some((node) => node.type === 'trigger')) value.nodes.unshift({ id: `nd_trigger_${value.id || 'new'}`, type: 'trigger', name: 'Trigger', config: {}, position: { x: 360, y: 160 } });
  return value;
}

export async function loadFlow(flowId) {
  if (!flowId) return null;
  const response = await fetch(`${BASE}/workflows/${encodeURIComponent(flowId)}`);
  const data = await response.json();
  if (!response.ok || !data?.workflow) return null;
  return normalize(data.workflow);
}

export async function saveFlow(flow) {
  if (!flow?.id) return false;
  const body = { name: flow.name, description: flow.description, enabled: flow.enabled, trigger: flow.trigger, executionMode: flow.executionMode, autoApprovePermissions: flow.autoApprovePermissions === true, inputs: flow.inputs, publishAsTool: flow.publishAsTool, nodes: flow.nodes, edges: flow.edges };
  const response = await fetch(`${BASE}/workflows/${encodeURIComponent(flow.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return response.ok;
}

export function documentMessage(documentId, kind, payload = {}) {
  return { source: 'canvas-document', version: 2, documentId, kind, ...payload };
}

// The neutral Desktop host relays only same-document envelopes. This helper is
// intentionally domain-free so a Breadboard can use the exact same transport.
export function channel(contextValue, onMessage) {
  if (!contextValue?.documentId || typeof window === 'undefined' || window.parent === window) return { ready() {}, event() {}, state() {}, request() {}, close() {} };
  const receive = (event) => {
    const value = event.data;
    if (event.source !== window.parent || event.origin !== window.location.origin || value?.source !== 'canvas-document' || value?.version !== 2 || value.documentId !== contextValue.documentId) return;
    onMessage(value);
  };
  window.addEventListener('message', receive);
  const send = (kind, payload) => window.parent.postMessage(documentMessage(contextValue.documentId, kind, payload), window.location.origin);
  return {
    ready: () => send('ready', { componentId: contextValue.componentId, role: contextValue.role }),
    event: (type, detail = {}) => send('event', { event: { type, detail } }),
    state: (state) => send('state', { state }),
    request: (type, detail = {}) => send('request', { request: { type, detail } }),
    close: () => window.removeEventListener('message', receive),
  };
}

export function nodeLabel(type) { return NODE_TYPES.find(([key]) => key === type)?.[1] || type; }

export function openWorkspace(workflow = null) {
  const message = { source: 'agent', type: 'canvas-document:open', detail: { appId: 'flows', item: workflow?.id ? { id: workflow.id, name: workflow.name || 'Flow' } : null } };
  window.top.postMessage(message, window.location.origin);
}
