'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const CHILD = path.join(__dirname, 'script-sandbox-child.js');
const MAX_OUTPUT = 1024 * 1024;

function runScript(code, context, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 1000, 50), 5000);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${CHILD}`, '--disable-proto=delete',
      '--max-old-space-size=64', CHILD,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: {} });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => finish(new Error(`script excedeu ${timeoutMs}ms`), true), timeoutMs);
    const finish = (error, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) child.kill('SIGKILL');
      if (error) reject(error); else {
        try {
          const response = JSON.parse(stdout);
          if (!response.ok) reject(new Error(response.error || 'script falhou'));
          else resolve({ output: response.result, logs: response.logs || [] });
        } catch { reject(new Error(`resposta inválida do sandbox${stderr ? `: ${stderr.slice(0, 300)}` : ''}`)); }
      }
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) finish(new Error('saída do script excede 1 MiB'), true); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8192) finish(new Error('erro do sandbox excede o limite'), true); });
    child.on('error', (error) => finish(error));
    child.on('close', () => finish());
    try {
      child.stdin.end(JSON.stringify({ code, ...context, syncTimeoutMs: Math.min(timeoutMs, 1000) }));
    } catch (error) { finish(error, true); }
  });
}

module.exports = { runScript };
