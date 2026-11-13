'use strict';

// Adaptador estreito entre o Flow e o decisor cognitivo. O Flow mantém as
// rotas permitidas e o fallback; Jev/Laya só podem escolher uma delas.
const cognitive = require('../../classification/decision-engine.js');

function candidatesOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => ({
    name: String(candidate?.name || '').trim().slice(0, 120),
    description: String(candidate?.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  })).filter((candidate) => candidate.name);
}

function deterministicChoice(intent, rules, allowed) {
  const text = String(intent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const choice = String(rule?.choice || '').trim();
    if (!allowed.some((candidate) => candidate.name === choice)) continue;
    const terms = (Array.isArray(rule?.terms) ? rule.terms : [])
      .map((term) => String(term || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim())
      .filter((term) => term.length >= 2);
    if (terms.some((term) => text.includes(term))) return choice;
  }
  return null;
}

async function classify({ intent, candidates, fallback, minConfidence = 0, deterministicRules, decide = cognitive.decide } = {}) {
  const allowed = candidatesOf(candidates);
  const defaultChoice = String(fallback || allowed[0]?.name || '').trim();
  if (!allowed.some((candidate) => candidate.name === defaultChoice)) throw new Error('nó classifier: fallback deve ser uma candidata');
  if (!allowed.length) throw new Error('nó classifier: informe ao menos uma candidata');

  const ruleChoice = deterministicChoice(intent, deterministicRules, allowed);
  if (ruleChoice) {
    return { choice: ruleChoice, confidence: 1, provider: 'deterministic-rule', available: true, usedFallback: false };
  }

  try {
    const result = await decide({
      intent: String(intent || '').slice(0, 2000),
      candidates: allowed,
      kind: 'flow',
      timeoutMs: 1500,
    });
    const recommendation = result?.recommendation;
    const confidence = Number(recommendation?.confidence);
    if (recommendation && allowed.some((candidate) => candidate.name === recommendation.choice)
      && Number.isFinite(confidence) && confidence >= minConfidence) {
      return {
        choice: recommendation.choice,
        confidence,
        provider: recommendation.rawProvider || null,
        available: Boolean(result.available),
        usedFallback: false,
      };
    }
    return { choice: defaultChoice, confidence: null, provider: null, available: Boolean(result?.available), usedFallback: true, error: result?.error || null };
  } catch (error) {
    // Falha de classificador nunca pode encaminhar uma conversa para um agente
    // fora da rota declarada pelo Flow.
    return { choice: defaultChoice, confidence: null, provider: null, available: false, usedFallback: true, error: String(error?.message || 'classificador indisponível').slice(0, 240) };
  }
}

module.exports = { classify, candidatesOf, deterministicChoice };
