// Templates distribuídos pelos pacotes são conteúdo instalável, não estado do
// usuário. Esta suíte garante descoberta e que a instanciação preserva o grafo
// enquanto aplica apenas as variáveis soltas configuradas no formulário.
// Rodar: node --test packages/flows/test/package-templates.test.js

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const templates = require('../lib/templates');
const store = require('../lib/store');
const { runWorkflow } = require('../lib/graph-engine');

// O motor persiste cada run; templates são testados em memória para não alterar
// o histórico real do usuário.
store.appendRun = () => {};
store.updateRun = () => {};

const EXPECTED = [
  'licitacoes/flows/radar-completo.flow.json',
  'system-monitor/flows/disk-usage-alert.flow.json',
  'tasks/flows/due-task-notification.flow.json',
  'wallet/flows/scheduled-transactions-notification.flow.json',
];

test('descobre os templates distribuídos pelos pacotes', () => {
  const ids = templates.list({ force: true }).map((template) => template.id);
  for (const id of EXPECTED) assert.ok(ids.includes(id), `template ausente: ${id}`);
});

test('instancia o alerta de disco desligado e aplica somente variáveis soltas', () => {
  const workflow = templates.instantiate('system-monitor/flows/disk-usage-alert.flow.json', {
    values: { channel: 'operacoes', thresholdPct: 92 },
  });

  assert.equal(workflow.enabled, false);
  assert.equal(workflow.fromTemplate, 'system-monitor/flows/disk-usage-alert.flow.json');
  assert.equal(workflow.trigger.type, 'cron');
  assert.equal(workflow.nodes.find((node) => node.id === 'channel').config.value, 'operacoes');
  assert.equal(workflow.nodes.find((node) => node.id === 'thresholdPct').config.value, 92);
  assert.deepEqual(workflow.nodes.find((node) => node.id === 'readStats').config.args, {});
});

test('templates de tarefas e wallet usam os eventos públicos corretos', () => {
  const due = templates.instantiate('tasks/flows/due-task-notification.flow.json');
  const scheduled = templates.instantiate('wallet/flows/scheduled-transactions-notification.flow.json');

  assert.equal(due.trigger.event, 'tasks:due');
  assert.equal(scheduled.trigger.event, 'wallet:scheduled_materialized');
  assert.equal(due.nodes.find((node) => node.type === 'tool').config.name, 'sendNtfyNotification');
  assert.equal(scheduled.nodes.find((node) => node.type === 'tool').config.package, 'ntfy');
});

test('templates publish a readable canvas layout', () => {
  for (const id of EXPECTED) {
    const workflow = templates.instantiate(id);
    const occupied = new Set();

    for (const node of workflow.nodes) {
      assert.ok(Number.isFinite(node.position?.x), `${id}: ${node.id} must have an x position`);
      assert.ok(Number.isFinite(node.position?.y), `${id}: ${node.id} must have a y position`);
      const key = `${node.position.x}:${node.position.y}`;
      assert.ok(!occupied.has(key), `${id}: ${node.id} overlaps another node at ${key}`);
      occupied.add(key);
    }
  }
});

test('radar completo preserva os portões humanos e nunca expõe tool de lance', () => {
  const workflow = templates.instantiate('licitacoes/flows/radar-completo.flow.json');
  const approvals = workflow.nodes.filter((node) => node.type === 'human_approval');
  const toolNames = workflow.nodes.flatMap((node) => [node.config?.name, ...(node.config?.toolNames || [])]).filter(Boolean);

  assert.equal(workflow.executionMode, 'durable');
  assert.equal(approvals.length, 4);
  assert.ok(toolNames.includes('licitacoes_preparar_disputa'));
  assert.ok(!toolNames.includes('licitacoes_armar_disputa'));
  assert.ok(!toolNames.includes('licitacoes_executar_lance'));
});

test('alerta de disco só notifica ao atingir o limite', async () => {
  const workflow = templates.instantiate('system-monitor/flows/disk-usage-alert.flow.json', {
    values: { thresholdPct: 85 },
  });
  const notifications = [];
  const deps = {
    runTool: async (pkg, name) => {
      if (pkg === 'system-monitor' && name === 'getSystemStats') {
        return { disk: { pct: 90, usedGB: 90, totalGB: 100 } };
      }
      notifications.push({ pkg, name });
      return { success: true };
    },
  };

  const alerted = await runWorkflow(workflow, {}, {}, deps);
  assert.equal(alerted.status, 'ok');
  assert.deepEqual(notifications, [{ pkg: 'ntfy', name: 'sendNtfyNotification' }]);

  notifications.length = 0;
  deps.runTool = async (pkg, name) => {
    if (pkg === 'system-monitor' && name === 'getSystemStats') return { disk: { pct: 84 } };
    notifications.push({ pkg, name });
    return { success: true };
  };
  const quiet = await runWorkflow(workflow, {}, {}, deps);
  assert.equal(quiet.status, 'ok');
  assert.deepEqual(notifications, []);
});
