import { createHash } from 'node:crypto';
import {getProxy} from 'logos';
import { accessDenied, subjectContext } from '../../auth/local-context.js';
import { resourceAccess } from '../../auth/local-resources.js';
import { restrictedApps } from '../../auth/local-app-actions.js';
import store from './store.js';

const safeTypes = new Set(['trigger','set','log','delay','condition','switch','merge','tool']);
const operationApps = [...restrictedApps,{id:'cnpj-scraper',actions:['search.execute']}];
const eventApps = {'email:sent':'email-manager','whatsapp:message:sent':'whatsapp-manager','whatsapp:message:received':'whatsapp-manager'};
const literal = value => typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) && !['__proto__','prototype','constructor'].includes(value);
export const definitionHash = wf => createHash('sha256').update(JSON.stringify({nodes:wf.nodes,edges:wf.edges,trigger:wf.trigger})).digest('hex');
export function validateLocalWorkflow(wf) {
  if (!['manual','cron','schedule','webhook','event'].includes(wf.trigger?.type || 'manual')) accessDenied();
  if (wf.trigger?.type==='event' && (!eventApps[wf.trigger.event]||!literal(wf.trigger.resourceId)))accessDenied();
  if (!Array.isArray(wf.nodes) || wf.nodes.length > 100 || !Array.isArray(wf.edges) || wf.edges.length > 300) accessDenied();
  if (JSON.stringify(wf).length > 100000) accessDenied();
  const ids = new Set();
  for (const node of wf.nodes) {
    if (!literal(node.id) || ids.has(node.id) || !safeTypes.has(node.type)) accessDenied();
    ids.add(node.id);
    if (node.type === 'set' && !literal(node.config?.key || 'value')) accessDenied();
    if (node.type === 'tool') {
      const c = node.config, app = operationApps.find(a=>a.id === c?.package && a.id !== 'flows');
      if (!app || c.name !== 'local/action' || !app.actions.includes(c.args?.action) || ['read','share'].includes(c.args.action) || c.args.action.startsWith('campaigns.') || !literal(c.args.id)) accessDenied();
    }
  }
  if (wf.edges.some(e=>!ids.has(e.from)||!ids.has(e.to))) accessDenied();
  // The templater can read properties, never JavaScript or prototype chains.
  function inspect(value) {
    if (value && typeof value === 'object') for (const [key,v] of Object.entries(value)) { if (['__proto__','constructor','prototype'].includes(key)) accessDenied(); inspect(v); }
    if (typeof value === 'string') for (const match of value.matchAll(/\{\{\s*([^}]+)\}\}/g)) {
      const parts = match[1].trim().split('.');
      if (!['trigger','nodes','vars','now'].includes(parts[0]) || parts.some(p=>!literal(p))) accessDenied();
    }
  }
  inspect(wf.nodes);
  return wf;
}
export function requireTargets(userId,wf) {
  validateLocalWorkflow(wf);
  if(wf.trigger?.type==='event') {
    const pkg=eventApps[wf.trigger.event],ctx=subjectContext(userId,pkg);
    ctx.require('read');ctx.require('messages.read',resourceAccess(pkg,wf.trigger.resourceId,pkg==='email-manager'?'mailbox':'instance'));
  }
  for (const node of wf.nodes.filter(n=>n.type === 'tool')) {
    const {package:pkg,args} = node.config;
    const ctx = subjectContext(userId,pkg);
    ctx.require('read'); ctx.require(args.action,resourceAccess(pkg,args.id,pkg === 'email-manager' ? 'mailbox' : pkg === 'cnpj-scraper' ? 'search' : 'instance'));
  }
}
// Called by every runner path, including cron, public webhooks and resume.
export function localDependencies(wf, meta = {}, payload = {}) {
  const resource = resourceAccess('flows',wf.id,'workflow');
  if (!resource.ownerId && !resource.executionSubjectId && !meta.localSubject) return null;
  const userId = meta.localSubject || resource.executionSubjectId || resource.ownerId;
  const hash = definitionHash(wf);
  const check = () => {
    const current = store.getWorkflow(wf.id);
    if (!current || definitionHash(current) !== hash) accessDenied();
    const ctx = subjectContext(userId,'flows');
    ctx.require('read'); ctx.require('execute',resourceAccess('flows',wf.id,'workflow'));
    if (!meta.localSubject) {
      if (!current.enabled) accessDenied();
      ctx.require('enable',resource);
      if (['cron','schedule'].includes(current.trigger?.type)) ctx.require('schedule',resource);
      if (current.trigger?.type === 'webhook') ctx.require('webhook',resource);
      if (current.trigger?.type === 'event') ctx.require('events',resource);
    }
    requireTargets(userId,wf);
  };
  check();
  let filteredPayload;
  if(wf.trigger?.type==='event' && !meta.localSubject) {
    const pkg=eventApps[wf.trigger.event],target=wf.trigger.resourceId;
    const matches=pkg==='email-manager' ? payload.mailboxId===target : (payload.instanceId===target || (!!payload.instanceName && getProxy(pkg).instance[target]?.name===payload.instanceName));
    if(!matches)accessDenied();
    filteredPayload=Object.fromEntries(['mailboxId','instanceId','instanceName','conversationId','messageId','uid','subject','text','from','to','sentAt'].filter(k=>payload[k]!==undefined).map(k=>[k,payload[k]]));
  }
  return {
    ...(filteredPayload?{filteredPayload}:{}),
    localSubject:userId,
    beforeNode(_node,context) { check(); if (store.getRun(context.runId)?.localCancelled) accessDenied(); },
    async runTool(pkg,name,args) {
      check();
      const ctx = subjectContext(userId,pkg); ctx.require('read');
      if (name !== 'local/action') accessDenied();
      if (pkg === 'email-manager') return (await import('../../email-manager/local.js')).executeLocalAction(ctx,args);
      if (pkg === 'whatsapp-manager') return (await import('../../whatsapp-manager/local.js')).executeLocalAction(ctx,args);
      if (pkg === 'cnpj-scraper') return (await import('../../cnpj-scraper/local.js')).executeLocalAction(ctx,args);
      accessDenied();
    },
  };
}
