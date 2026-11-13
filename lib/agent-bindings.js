'use strict';

function bindingNodes(agent, workflow) {
  const edges = workflow?.edges || [];
  return (workflow?.nodes || []).filter((node) => node.type === 'agent-tool' && (node.ownerAgentId === agent.id || edges.some((edge) => edge.kind === 'agent-tool' && edge.from === agent.id && edge.to === node.id)));
}

function omitFixed(schema, fixedNames) {
  const copy = JSON.parse(JSON.stringify(schema || { type: 'object', properties: {} }));
  if (copy.properties) for (const name of fixedNames) delete copy.properties[name];
  if (Array.isArray(copy.required)) copy.required = copy.required.filter((name) => !fixedNames.includes(name));
  return copy;
}

function compileAgentBindings(agent, workflow) {
  const bindings = bindingNodes(agent, workflow).map((node) => {
    const cfg = node.config || {}, modes = cfg.argModes || {};
    const fixedArgNames = Object.keys(modes).filter((name) => modes[name] === 'fixed');
    const fixedArgs = {};
    for (const name of fixedArgNames) if (Object.prototype.hasOwnProperty.call(cfg.args || {}, name)) fixedArgs[name] = cfg.args[name];
    return { id: node.id, name: cfg.toolName, package: cfg.package || null, inputSchemaForModel: omitFixed(cfg.schemaSnapshot, fixedArgNames), schema: cfg.schemaSnapshot || null, fixedArgs, fixedArgNames };
  }).filter((binding) => binding.name);
  const seen = new Set();
  for (const binding of bindings) { if (seen.has(binding.name)) throw new Error(`tool duplicada no Agent: ${binding.name}`); seen.add(binding.name); }
  return bindings;
}

module.exports = { bindingNodes, compileAgentBindings, omitFixed };
