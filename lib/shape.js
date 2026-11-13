// packages/flows/lib/shape.js — "shape" de um payload: mapa chave→tipo.
//
// Por quê existe separado do tap: o catálogo do tap vive em MEMÓRIA e some a cada
// reboot do runtime. Um flow com gatilho `event` precisa LEMBRAR a interface do
// evento que o dispara para oferecer um formulário de teste preenchível mesmo
// depois de reiniciar — então o shape é absorvido pelo workflow e persistido
// (store.absorbTriggerShape). Estas funções são compartilhadas pelos dois lados.
//
// Política: apenas FORMATO (chaves → tipos), nunca valores.

'use strict';

// Deriva o shape de um valor. Recursivo raso: 1 nível de objetos aninhados.
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const inner = value.length ? shapeOf(value[0], depth + 1) : 'any';
    return `array<${typeof inner === 'string' ? inner : 'object'}>`;
  }
  const t = typeof value;
  if (t !== 'object') return t; // string | number | boolean | undefined | function
  if (depth >= 1) return 'object';
  const out = {};
  for (const k of Object.keys(value).slice(0, 40)) {
    out[k] = shapeOf(value[k], depth + 1);
  }
  return out;
}

// Une dois shapes de objeto (união de chaves) para estabilizar a sugestão: um
// evento pode chegar com campos opcionais ausentes numa amostra e presentes noutra.
function mergeShape(prev, next) {
  if (typeof prev !== 'object' || typeof next !== 'object' || !prev || !next) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    out[k] = k in out && typeof out[k] === 'object' && typeof v === 'object'
      ? mergeShape(out[k], v)
      : v;
  }
  return out;
}

// Valor default para um tipo do shape — semente do formulário de teste.
function sampleForType(type) {
  if (typeof type === 'object' && type) return {};
  const t = String(type || '');
  if (t.startsWith('array<')) return [];
  switch (t) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'object': return {};
    case 'null': case 'undefined': case 'any': return null;
    default: return '';
  }
}

// Converte um shape em um payload de exemplo vazio (todas as chaves, valores neutros).
function sampleFromShape(shape) {
  if (!shape || typeof shape !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(shape)) out[k] = sampleForType(v);
  return out;
}

// Achata um shape em campos preenchíveis pela UI: [{ path, type }]. Objetos
// aninhados viram um campo único de tipo `object` (editado como JSON).
function fieldsFromShape(shape, prefix = '') {
  const out = [];
  if (!shape || typeof shape !== 'object') return out;
  for (const [k, v] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push({ path, type: 'object' });
    else out.push({ path, type: String(v) });
  }
  return out;
}

module.exports = { shapeOf, mergeShape, sampleForType, sampleFromShape, fieldsFromShape };
