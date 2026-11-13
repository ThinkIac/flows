'use strict';

// Incorpora o protocolo do scriba-rule-engine 1.0.9, mas mantém no Flow apenas
// operações declarativas. A implementação publicada aceitava Function() em
// expressions, callFunction e callWebhook; essas superfícies não atravessam
// esta fronteira. Efeitos externos continuam sendo nós governáveis do grafo.

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONDITION_TYPES = new Set([
  'greaterThan', 'lessThan', 'equals', 'notEquals', 'fieldExists', 'fieldNull',
  'inList', 'notInList', 'beforeDate', 'afterDate', 'startsWith',
  'endsWith', 'contains', 'allInList', 'anyInList',
]);
const ACTION_TYPES = new Set(['setField', 'log', 'throw']);

function parts(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('campo da regra é obrigatório');
  const out = path.split('.');
  if (out.some((part) => !part || FORBIDDEN_KEYS.has(part))) throw new Error(`campo inseguro bloqueado: "${path}"`);
  return out;
}

function get(record, path) {
  return parts(path).reduce((value, key) => value == null ? undefined : value[key], record);
}

function set(record, path, value) {
  const keys = parts(path);
  let target = record;
  for (let i = 0; i < keys.length - 1; i++) {
    const current = target[keys[i]];
    if (current == null) target[keys[i]] = {};
    else if (typeof current !== 'object' || Array.isArray(current)) throw new Error(`não é possível escrever dentro de "${keys.slice(0, i + 1).join('.')}"`);
    target = target[keys[i]];
  }
  target[keys.at(-1)] = structuredClone(value);
}

function interpolate(value, record) {
  if (typeof value !== 'string') return structuredClone(value);
  const whole = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (whole) return structuredClone(get(record, whole[1]));
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    const found = get(record, path);
    return found == null ? '' : typeof found === 'object' ? JSON.stringify(found) : String(found);
  });
}

function evaluateCondition(condition, record, depth = 0) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('condição inválida');
  if (depth > 20) throw new Error('condição excede 20 níveis');
  if (condition.expression != null) throw new Error('expressões JavaScript não são permitidas no nó Rules');
  if (condition.and) return arrayConditions(condition.and, 'and').every((item) => evaluateCondition(item, record, depth + 1));
  if (condition.or) return arrayConditions(condition.or, 'or').some((item) => evaluateCondition(item, record, depth + 1));
  if (condition.not) return !evaluateCondition(condition.not, record, depth + 1);
  if (!CONDITION_TYPES.has(condition.type)) throw new Error(`condição não permitida: "${condition.type || ''}"`);
  const actual = get(record, condition.field);
  const expected = condition.value;
  switch (condition.type) {
    case 'greaterThan': return actual > expected;
    case 'lessThan': return actual < expected;
    case 'equals': return actual === expected;
    case 'notEquals': return actual !== expected;
    case 'fieldExists': return actual !== undefined;
    case 'fieldNull': return actual == null;
    case 'inList': return Array.isArray(expected) && expected.includes(actual);
    case 'notInList': return Array.isArray(expected) && !expected.includes(actual);
    case 'beforeDate': return new Date(actual) < new Date(expected);
    case 'afterDate': return new Date(actual) > new Date(expected);
    case 'startsWith': return typeof actual === 'string' && actual.startsWith(expected);
    case 'endsWith': return typeof actual === 'string' && actual.endsWith(expected);
    case 'contains': return typeof actual === 'string' && actual.includes(expected);
    case 'allInList': return Array.isArray(actual) && Array.isArray(expected) && expected.every((value) => actual.includes(value));
    case 'anyInList': return Array.isArray(actual) && Array.isArray(expected) && expected.some((value) => actual.includes(value));
    default: return false;
  }
}

function arrayConditions(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`operador ${name} requer de 1 a 100 condições`);
  return value;
}

async function applyRules(input, rules, { log } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('record do nó Rules precisa ser um objeto');
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('rules precisa ser uma lista com até 100 regras');
  const record = structuredClone(input);
  const matchedRules = [];
  const changes = [];
  const ports = [];
  const sorted = rules.map((rule, index) => ({ rule, index })).sort((a, b) => (Number(b.rule.priority) || 0) - (Number(a.rule.priority) || 0));
  for (const { rule, index } of sorted) {
    if (!rule || typeof rule !== 'object') throw new Error(`regra ${index} inválida`);
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [rule.conditions];
    if (!conditions.every((condition) => evaluateCondition(condition, record))) continue;
    const id = String(rule.id || rule.name || index);
    matchedRules.push(id);
    if (rule.route) ports.push(String(rule.route));
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    if (actions.length > 100) throw new Error(`regra ${id} excede 100 ações`);
    for (const action of actions) {
      if (!action || !ACTION_TYPES.has(action.type)) throw new Error(`ação não permitida: "${action?.type || ''}"`);
      if (action.type === 'setField') {
        const value = action.valueFrom ? get(record, action.valueFrom) : interpolate(action.value, record);
        set(record, action.field, value);
        changes.push({ rule: id, field: action.field, value: structuredClone(value) });
      } else if (action.type === 'log') {
        log?.(String(interpolate(action.message || 'Rule matched', record)).slice(0, 1000));
      } else {
        throw new Error(String(interpolate(action.message || 'Rule violated', record)).slice(0, 1000));
      }
    }
  }
  const matched = matchedRules.length > 0;
  return { output: record, matched, matchedRules, changes, __ports: [...new Set([matched ? 'matched' : 'unmatched', ...ports])] };
}

module.exports = { applyRules, evaluateCondition, CONDITION_TYPES, ACTION_TYPES };
