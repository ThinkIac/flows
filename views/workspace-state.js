const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Graph collections merge by identity; other arrays (inputs/cases) are fields.
export function changesBetween(before, after, path = []) {
  if (equal(before, after)) return [];
  if (path.length === 1 && ['nodes', 'edges'].includes(path[0])) {
    const a = before || [], b = after || [];
    return [
      ...a.filter(x => !b.some(y => y.id === x.id)).map(x => ({ path: [...path, { id: x.id }], remove: true })),
      ...b.flatMap(x => {
        const old = a.find(y => y.id === x.id);
        return old ? changesBetween(old, x, [...path, { id: x.id }]) : [{ path: [...path, { id: x.id }], value: clone(x), add: true }];
      }),
    ];
  }
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changesBetween(before[key], after[key], [...path, key]));
  return [{ path, value: clone(after), remove: after === undefined }];
}
export function applyChanges(value, changes) {
  const next = clone(value);
  for (const change of changes) {
    if (!Array.isArray(change.path) || !change.path.length) continue;
    let target = next;
    for (let i = 0; i < change.path.length; i++) {
      const part = change.path[i], last = i === change.path.length - 1;
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(part)) break;
      const key = object(part) ? (Array.isArray(target) ? target.findIndex(x => x.id === part.id) : -1) : part;
      if (key === -1) { if (last && change.add && Array.isArray(target)) target.push(clone(change.value)); break; }
      if (last) {
        if (change.remove) { if (Array.isArray(target)) target.splice(key, 1); else delete target[key]; }
        else target[key] = clone(change.value);
      } else { if (!target[key] && typeof change.path[i + 1] === 'string') target[key] = {}; target = target[key]; }
    }
  }
  return next;
}
export function saveQueue(write) {
  let tail = Promise.resolve();
  return value => { const snapshot = clone(value); const result = tail.then(() => write(snapshot)); tail = result.catch(() => {}); return result; };
}
