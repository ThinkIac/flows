// packages/flows/lib/session-msg.js — entrega uma mensagem a uma sessão do chat.
//
// Casca CommonJS sobre o canal canônico do Agent
// (agent/core/session_channel.js), que é ESM — daí o import() dinâmico. A
// lógica de entrega (persistir no histórico + render ao vivo) mora lá, e é a
// mesma usada pelas tools MCP say_to_user/ask_user: um Flow e um subprocesso
// do Claude falam na sessão exatamente do mesmo jeito.
//
// API preservada de propósito: lib/runner.js e o nó `session-message` do
// graph-engine já dependem desta assinatura.

'use strict';

const path = require('path');

const SESSION_CHANNEL = path.join(__dirname, '..', '..', 'agent', 'core', 'session_channel.js');

// Entrega `content` na sessão `sessionId` como `role` (assistant|user).
// Best-effort: nunca lança para não derrubar o run — retorna { persisted, live }.
async function sendSessionMessage(sessionId, content, role = 'assistant') {
  try {
    const channel = await import(SESSION_CHANNEL);
    return await channel.sendToSession(sessionId, content, role);
  } catch {
    return { persisted: false, live: false };
  }
}

module.exports = { sendSessionMessage };
