<script>
  import { onMount } from 'svelte';
  export let authorization = null;
  export let busy = false;
  export let error = '';
  export let close = () => {};
  export let approve = () => {};
  export let revoke = () => {};
  let dialog;
  onMount(() => { dialog.showModal(); });
</script>
<dialog bind:this={dialog} aria-labelledby="flow-authorization-title" on:cancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
  <h2 id="flow-authorization-title">Autorizações do Flow</h2>
  <p>Autorize as ferramentas abaixo para todas as execuções futuras, inclusive quando você estiver ausente, até revogar.</p>
  <p>Parâmetros com expressões recebem valores de cada execução, sem limite adicional. Mudanças na lógica do Flow ou no código do pacote exigem nova autorização.</p>
  <p>Nós de agente e sub-flows não herdam esta autorização. Bloqueios absolutos continuam valendo.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if authorization}
    <p role="status">{authorization.automatic ? 'Aceite automático ativo na configuração do Flow' : authorization.active ? 'Autorização ativa' : 'Sem autorização válida'}</p>
    {#each authorization.actions || [] as action}
      <section aria-label={action.package + '.' + action.tool}>
        <strong>{action.package}.{action.tool}</strong><small>Nó: {action.nodeId}</small>
        <pre>{JSON.stringify(action.args, null, 2)}</pre>
      </section>
    {/each}
    {#if !authorization.actions?.length}<p>Nenhuma ferramenta com pacote e nome fixos para autorizar.</p>{/if}
  {:else if busy}<p role="status">Carregando autorizações…</p>{/if}
  <footer>
    <button on:click={close} disabled={busy}>Fechar</button>
    <button on:click={revoke} disabled={busy || authorization?.automatic}>Revogar autorização</button>
    <button on:click={approve} disabled={busy || !authorization?.actions?.length || authorization?.active}>Autorizar execuções futuras</button>
  </footer>
</dialog>
<style>
  dialog { color: var(--tk-text); background: var(--tk-surface); border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-lg); padding: 24px; width: min(640px, calc(100% - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-sizing: border-box; }
  dialog::backdrop { background: var(--tk-border-hi); }
  h2 { margin-top: 0; font-size: 18px; }
  p { font-size: 13px; line-height: 1.5; }
  section { padding: 12px; border: 1px solid var(--tk-border); margin: 10px 0; border-radius: var(--tk-radius-md); }
  small { display: block; color: var(--tk-muted); margin-top: 5px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
  footer { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
  button { color: var(--tk-text); background: var(--tk-surface-2); border: 1px solid var(--tk-border-hi); padding: 8px 12px; border-radius: var(--tk-radius-md); cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
