# Flows

Automação orientada a eventos para o runtime **Lógos** — no espírito do n8n / Make,
mas nativo do bus do Lógos.

Um **workflow** é uma lista de **passos** executados em ordem, disparada por um
**gatilho**:

## Instalação responsável

Antes de instalar, revise o código do pacote e as permissões das ferramentas que
um workflow poderá chamar. Depois, peça ao assistente do workspace ativo para
instalar o plugin **Flows**. Workflows novos começam desativados, para que a
automação seja revisada antes de receber eventos, cron ou webhooks.

## Como funciona

O Flows persiste a definição de cada workflow e seu histórico de execução em
arquivos locais do runtime. A mesma definição atende o editor visual, a API HTTP
e as ferramentas MCP. Eventos de domínio podem iniciar workflows sem depender da
interface, e execuções duráveis retomam checkpoints após reiniciar o runtime.

| Gatilho    | Como dispara                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| `event`    | Escuta um padrão de evento do bus (`agent:tool-end`, `agent:*`, `*`, …).      |
| `webhook`  | Gera uma URL pública `POST/GET /flows/webhook/:token`.                        |
| `cron`     | Recorrente por expressão cron de 5 campos (`trigger.cron`). Motor de tempo em `index.js` (tick 30s) — cron builder na UI. |
| `schedule` | Data/hora única (`trigger.at`, ISO). Dispara uma vez e **auto-desativa** o flow. |
| `semantic` | Casa eventos por similaridade de embeddings (`trigger.text`/`threshold`).     |
| `manual`   | Botão ▸ na UI, `POST /flows/workflows/:id/run` ou a tool `flows_run`.         |

## Nós

Um workflow é um **grafo** (`nodes[]` + `edges[]`, motor em `lib/graph-engine.js`).
Cada nó lê o contexto via templating `{{ caminho.pontilhado }}`:

- `trigger` — payload que disparou o workflow (evento do bus / corpo do webhook)
- `vars` — variáveis definidas pelo nó `set`
- `nodes` — saída de outros nós (`{{nodes.n1.text}}`)

Tipos: `log`, `set`, `http`, `emit`, `delay`, `condition` (portas `true`/`false`),
`switch` (uma porta por caso + `default`), `iterate` (loop sobre lista),
`tool` (`@register_tool` do runtime), `agent`, `human_approval` (portas
`approved`/`rejected`), `merge`, `sub-flow`.

## Execução durável

`executionMode` é `best-effort` por padrão. Ao selecionar `durable` no editor,
o Flows grava um checkpoint após cada nó confirmado. Um `delay` passa a deixar o
run em `waiting` com `wakeAt`, em vez de depender de `setTimeout`; o motor de
tempo retoma runs vencidos no boot e a cada tick. A definição do workflow usada
na execução também é guardada no run, então uma edição posterior não altera uma
retomada já agendada.

Nós `tool` recebem uma `idempotencyKey` estável (`<runId>:<nodeId>`) no contexto
do executor. Adaptadores que suportam idempotência devem aplicá-la no efeito
externo. A confirmação do checkpoint impede repetir nós já concluídos; uma queda
exatamente entre o efeito remoto e sua confirmação ainda exige que o destino
honre essa chave, portanto a garantia prática é ao menos uma vez com deduplicação.

- **`switch`** roteia por igualdade de texto: compara `config.value` com cada
  caso em `config.cases[]` e ativa a porta homônima; sem match, sai por `default`.
- **`iterate`** percorre `config.items` (lista) e, se `config.workflowId` estiver
  setado, roda esse sub-flow uma vez por item (`{{trigger.item}}`,
  `{{trigger.index}}`); máx. 500 itens.
- **Tratamento de erro (`on-error`)**: nós falíveis (`http`, `tool`, `agent`,
  `sub-flow`, `session-message`, `iterate`) expõem uma saída **`error`** (vermelha).
  Ligue-a a qualquer nó: ao falhar, o flow **segue pelo ramo de erro a partir do
  próprio nó que falhou** em vez de abortar, e a mensagem fica em
  `{{nodes.<id>.error}}`. Sem essa ligação, a falha é fatal para o run.

- **`agent`** roda o loop de tool-calling do `agent/runtime` (hostado pelo
  `packages/logos/docs/agent.md`) em vez de um único `call_llm`. Config:
  `{ goal, system?, model?, toolNames?, maxSteps?, outputSchema? }`. `prompt` é
  aceito como alias legado de `goal` (nome do campo antes da migração).
  `toolNames` é escolhido no **catálogo** do inspetor (buscável, agrupado por
  pacote) — não se digitam nomes. **Lista vazia é o padrão**: aí cada execução
  passa pelo **classificador da Agent** (`packages/classification`), que lê o
  `goal` e devolve só as tools relevantes (+ os builtins sempre incluídos); a
  escolha vai para o log do run. Se o classificador não estiver disponível, o
  agente recebe o catálogo inteiro, como antes.
- **`human_approval`** notifica (`ntfy`, best-effort) e suspende o nó até uma
  chamada em `POST /flows/runs/:runId/approve/:nodeId` ou `.../reject/:nodeId`,
  ou até `config.timeoutMs` vencer (rejeita automaticamente com `timedOut: true`).
  **Cuidado**: se o workflow foi disparado por uma rota síncrona
  (`workflows/:id/run`, webhook), a resposta HTTP fica pendurada até a
  aprovação resolver — para automações com aprovação, prefira gatilho `event`
  (dispara via `emit`, não-bloqueante) e acompanhe o run por `GET /flows/runs/:id`.

## API REST (`/flows`)

```
GET    /flows/workflows                    lista
POST   /flows/workflows                    cria
GET    /flows/workflows/:id                detalhe
PUT    /flows/workflows/:id                atualiza
DELETE /flows/workflows/:id                remove
PATCH  /flows/workflows/:id/toggle         ativa/desativa
POST   /flows/workflows/:id/duplicate      duplica (ids novos, desligada, sem publicar)
POST   /flows/workflows/:id/run            executa (body = trigger)
GET    /flows/workflows/:id/interface      campos de entrada p/ o formulário de teste
GET    /flows/runs?workflowId&limit        histórico
POST   /flows/runs/:id/replay              repete o run com o MESMO payload
GET    /flows/runs/:id                     detalhe de um run (poll p/ human_approval pendente)
POST   /flows/runs/:runId/approve/:nodeId  aprova um nó human_approval pendente
POST   /flows/runs/:runId/reject/:nodeId   rejeita um nó human_approval pendente
GET    /flows/events                       catálogo de padrões sugeridos
GET    /flows/tools                        catálogo de tools (com schema dos params)
GET    /flows/tools/options?source=…       opções de um param com fonte viva (@enumSource)
POST   /flows/webhook/:token               receptor de webhook
GET    /flows/webhook/:token               receptor de webhook (conveniência)
```

## UI

No inspetor do nó `tool`, um parâmetro que declara valores no JSDoc do Lógos
(`@enum` ou `@enumSource` — ver `packages/logos/docs/decorators.md`) vira um
`<select>` em vez de caixa de texto. Fonte viva que não resolve volta a ser
texto livre, nunca trava o formulário.

`/view/flows/Index` — dashboard responsivo (segue o `DESIGN.md` da Agent,
sistema *Zero Interface*, com suporte claro/escuro).

## Debug: testar, log e replay

- **Testar** abre um formulário com o payload do gatilho antes de executar —
  campos vindos dos `inputs[]` declarados e da interface do gatilho. Alterna
  entre preenchimento por campo e JSON cru; o último payload usado fica salvo
  no flow (`testPayload`) e volta preenchido na próxima vez.
- **Interface absorvida.** O catálogo de eventos do tap vive em memória e some a
  cada reboot. Por isso, quando um flow dispara de verdade (evento ou webhook),
  ele **absorve o formato do payload** (só chaves → tipos, nunca valores) em
  `trigger.shape` — que é persistido e continua alimentando o formulário de
  teste depois de reiniciar o runtime. Trocar o evento do gatilho descarta o
  shape antigo; o campo é do servidor e ignora o que o cliente enviar.
- **Log.** Cada run grava `logs[]`: mensagens dos nós `Log`, erros de nó e
  início/fim da execução. O painel do editor mostra as abas *Etapas*, *Log* e
  *Entrada*, e lê o histórico de disco — não depende mais de ter clicado em
  Testar naquela sessão.
- **Replay.** O payload que disparou cada run é guardado em `run.input`, então
  `POST /flows/runs/:id/replay` (ou o botão *repetir*) reexecuta com exatamente
  os mesmos parâmetros. *Editar e rodar* reabre o formulário já preenchido com
  aquele payload. Runs anteriores a este recurso não têm `input` e não são
  replayáveis.

## Segurança

- Namespaces reservados (`runtime:`, `package:`, `tool:`, …) não podem ser emitidos
  pelo passo `emit`.
- Guarda de recursão (profundidade máx. 5) impede loops de eventos.
- Escrita de estado é atômica (arquivo `.tmp` + rename).
- `tools/options` só resolve fontes (`@enumSource`) que algum parâmetro do
  catálogo realmente declara — o `source` vem do cliente, e sem esse filtro a
  rota viraria "chame qualquer tool por querystring". Fonte externa (`https://…`)
  exige host em `FLOWS_ENUM_SOURCE_HOSTS` (csv; vazio = externas desligadas),
  não segue redirect e tem timeout de 4s.

## Armazenamento

Arquivos JSON em `data/` (`workflows.json`, `runs.json`) — sem dependência de banco.

## Editor no workspace transparente

`FlowCanvas`, `NodeCatalog` e `NodeInspector` usam o mesmo `Editor.svelte`, com
papéis distintos. O editor tradicional permanece disponível em `/view/flows/Editor`.
O manifesto continua declarando uma superfície e dois painéis nativos do Desktop.
A abertura pelo botão Workspace emite `canvas-document:open`, sem trocar a URL
do Desktop. Duplicatas e sub-flows abertos no documento usam o mesmo evento.

A superfície é a autoridade de edição e persistência. Painéis enviam diferenças
por campo; nós e arestas são identificados por ID. Edições ainda sem confirmação
são reaplicadas sobre atualizações recebidas. A superfície confirma cada operação
e serializa gravações com snapshots independentes, preservando alterações feitas
durante a requisição. Falhas mantêm o rascunho e exibem nova tentativa. Testar e
executar exigem confirmação de gravação.

Os controles compartilhados preservam os seis gatilhos, nós específicos, tools,
portas condicionais e de erro, conexões por arrasto ou toque, entradas publicadas,
execução durável, teste com payload, histórico e replay. No mobile, catálogo e
propriedades são acessíveis pela barra inferior do próprio canvas.

Verificação: `node --test packages/flows/test/view-ssr.test.js
packages/flows/test/workspace-state.test.js packages/flows/test/workspace-browser.test.js`.
O teste de navegador usa Chromium/Puppeteer e uma API em memória; não executa
workflows reais nem escreve dados do usuário.

Contratos consultados: `engineer/docs/integrations.md`, `views.md`, `events.md`,
`agent/docs/package-widgets-and-ui-bus.md`, documentação de eventos do Lógos e
`desktop/README.md`. Referências de compatibilidade: editor existente e transporte
v2 do `WorkCanvas`. O Breadboard não faz parte desta implementação.

## Autorizações persistentes por Flow

No editor, abra **Autorizações**, revise ferramentas e parâmetros e clique em
**Autorizar execuções futuras**. O registro vale para execuções repetidas e
retomadas após reinício, até **Revogar autorização**. A revogação impede chamadas
futuras; não cancela um efeito que já começou.

Como alternativa por Flow, ative **Aceitar permissões automaticamente** nas
configurações do gatilho. A partir do próximo salvamento, Tools com pacote e nome
fixos declaradas no grafo executam sem abrir solicitações de governança. O aceite
é opt-in, não é herdado por cópias e fica registrado na auditoria como
`flow:auto-approve`. Bloqueios absolutos da governança continuam valendo.

O escopo cobre nós `tool` com pacote e nome fixos. Parâmetros com `{{...}}`
continuam dinâmicos, conforme as expressões revisadas, sem limites adicionais.
Nós de agente e sub-flows não herdam a autorização. Cada sub-flow precisa da
própria autorização. Os bloqueios absolutos da governança continuam aplicados.

Alterações em configurações, conexões, gatilhos, entradas, modo de execução ou
código do pacote da ferramenta invalidam o registro. Título, posição e ativação
não alteram o escopo. Duplicatas não herdam autorização. Um run durável com
snapshot antigo não pode usar autorização para uma definição diferente.

As rotas privadas `GET/POST/DELETE /flows/workflows/:id/authorization` oferecem
revisão, autorização vinculada ao `scopeHash` revisado e revogação. Não há tool
para conceder autorização; salvar o workflow também não concede acesso.
O arquivo `data/authorizations.json` é separado da definição e consultado em
cada chamada. A governança registra o Flow, nó e identificador da autorização
na razão da decisão, preservando as políticas das demais sessões.

Contratos consultados: Engineer `integrations.md`, `routes.md`, `tools.md`,
`events.md`, `views.md`; Lógos `decorators.md` e `stabilizer.md`. Referências:
`runtime_bridge.invokeRuntimeTool`, `evaluateAction`, `graph-engine`, store e
transporte do editor. Validação: `authorization.test.mjs`, testes da governança,
execução durável, agente, estado do workspace, navegador e SSR.
