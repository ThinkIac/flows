'use strict';

const vm = require('node:vm');

const MAX_INPUT = 1024 * 1024;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
  if (raw.length > MAX_INPUT) fail('entrada excede 1 MiB');
});
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(raw);
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    // Nunca injete objetos ou funções do processo host no contexto. Objetos de
    // outra realm preservam seu constructor e permitem escapar do vm. O JSON é
    // recriado dentro da própria realm isolada e o console também é local.
    const payloadJson = JSON.stringify({ input: request.input, trigger: request.trigger, vars: request.vars, nodes: request.nodes });
    const source = `'use strict'; (async () => {
      const { input, trigger, vars, nodes } = JSON.parse(${JSON.stringify(payloadJson)});
      const __logs = [];
      const __format = (value) => typeof value === 'string' ? value : JSON.stringify(value);
      const console = Object.freeze({
        log: (...args) => __logs.push(args.map(__format).join(' ').slice(0, 1000)),
        warn: (...args) => __logs.push(args.map(__format).join(' ').slice(0, 1000)),
        error: (...args) => __logs.push(args.map(__format).join(' ').slice(0, 1000))
      });
      const __result = await (async () => {\n${String(request.code || '')}\n})();
      return { result: __result, logs: __logs };
    })()`;
    const script = new vm.Script(source, { filename: 'flow-script.js' });
    const value = await script.runInContext(context, { timeout: request.syncTimeoutMs || 500 });
    process.stdout.write(JSON.stringify({ ok: true, result: value.result, logs: value.logs }));
  } catch (error) { fail(error?.message || String(error)); }
});

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(message).slice(0, 2000) }));
  process.exitCode = 1;
}
