import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { contextFromSearch, normalize, documentMessage } from '../views/workspace-flow.js';

const require = createRequire(import.meta.url);
const logosRoot = path.dirname(require.resolve('logos/package.json'));
const engineUrl = pathToFileURL(path.join(logosRoot, 'dist/src/modules/views/engine.js')).href;

test('home renders in SSR without browser globals', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'flows-view-'));
  try {
    const engineModule = await import(engineUrl);
    const { SvelteEngine } = engineModule.default ?? engineModule;
    const html = await new SvelteEngine(cacheDir).render(
      path.resolve('packages/flows/views/Index.svelte'),
      'flows__Index_ssr', {}, path.resolve('packages'),
    );
    assert.match(html, /Flows/);
    assert.match(html, /Your automations/);
    assert.match(html, /Abrir Workspace/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('canvas-document context accepts host parameters and a Flow always has a visible trigger node', () => {
  assert.deepEqual(contextFromSearch('?canvasDocument=1&workspaceId=space-1&documentId=document-1&id=flow-1&widgetId=canvas&widgetRole=canvas'), { workspaceId: 'space-1', documentId: 'document-1', flowId: 'flow-1', componentId: 'canvas', role: 'canvas' });
  assert.deepEqual(normalize({ id: 'flow-1', nodes: [], edges: [] }).nodes[0].position, { x: 360, y: 160 });
});

test('Flow emits the v2 document event envelope', () => {
  assert.deepEqual(documentMessage('document-1', 'event', { event: { type: 'node.create' } }), { source: 'canvas-document', version: 2, documentId: 'document-1', kind: 'event', event: { type: 'node.create' } });
});

test('editor renders in SSR without browser globals', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'flows-editor-view-'));
  try {
    const engineModule = await import(engineUrl);
    const { SvelteEngine } = engineModule.default ?? engineModule;
    const html = await new SvelteEngine(cacheDir).render(
      path.resolve('packages/flows/views/Editor.svelte'),
      'flows__Editor_ssr', {}, path.resolve('packages'),
    );
    assert.match(html, /Loading editor/);
    assert.match(html, /ed--compact/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

for (const [view, marker] of [
  ['FlowCanvas', 'Canvas do fluxo'],
  ['FlowTrigger', 'Gatilho do fluxo'],
  ['FlowControls', 'Controles do fluxo'],
  ['NodeCatalog', 'Adicionar nós'],
  ['NodeInspector', 'Propriedades do nó'],
]) {
  test(`${view} renders in SSR without browser globals`, async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), `flows-${view}-view-`));
    try {
      const engineModule = await import(engineUrl);
      const { SvelteEngine } = engineModule.default ?? engineModule;
      const html = await new SvelteEngine(cacheDir).render(
        path.resolve(`packages/flows/views/${view}.svelte`),
        `flows__${view}_ssr`, {}, path.resolve('packages'),
      );
      assert.match(html, new RegExp(marker));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
}
