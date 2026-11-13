// packages/flows/lib/cron.js — motor de tempo do Flows (sem dependência externa).
//
// Suporta gatilho `cron` (expressão de 5 campos "min hora dom mês dow") e
// `schedule` (data única ISO). A lógica de validação/match espelha a que já
// existia no pacote scheduler (que está sendo descontinuado) — trazida para
// dentro do Flows para que um flow seja auto-suficiente e não dependa dele.

'use strict';

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function isValidCron(expr) {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    if (field === '*') continue;
    for (const seg of field.split(',')) {
      if (/^\*\/\d+$/.test(seg)) { if (parseInt(seg.split('/')[1], 10) < 1) return false; continue; }
      if (/^\d+-\d+$/.test(seg)) {
        const [a, b] = seg.split('-').map(Number);
        if (a < RANGES[i][0] || b > RANGES[i][1] || a > b) return false;
        continue;
      }
      const val = parseInt(seg, 10);
      if (isNaN(val) || val < RANGES[i][0] || val > RANGES[i][1]) return false;
    }
  }
  return true;
}

function matchField(val, field) {
  if (field === '*') return true;
  for (const seg of field.split(',')) {
    if (/^\*\/\d+$/.test(seg)) { if (val % parseInt(seg.split('/')[1], 10) === 0) return true; continue; }
    if (/^\d+-\d+$/.test(seg)) {
      const [a, b] = seg.split('-').map(Number);
      if (val >= a && val <= b) return true;
      continue;
    }
    if (parseInt(seg, 10) === val) return true;
  }
  return false;
}

function matchesCron(expr, date) {
  if (!isValidCron(expr)) return false;
  const p = expr.trim().split(/\s+/);
  // dow: cron aceita 0 e 7 como domingo; getDay() usa 0=domingo.
  const dow = date.getDay();
  const dowMatch = matchField(dow, p[4]) || (dow === 0 && matchField(7, p[4]));
  return (
    matchField(date.getMinutes(), p[0]) &&
    matchField(date.getHours(), p[1]) &&
    matchField(date.getDate(), p[2]) &&
    matchField(date.getMonth() + 1, p[3]) &&
    dowMatch
  );
}

// True se `a` e `b` caem no mesmo minuto de calendário (guarda de dedupe).
function sameMinute(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() && a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
}

module.exports = { isValidCron, matchesCron, sameMinute };
