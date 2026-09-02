# Hooks

Três hooks são conectados pelo `install.sh` em cada harness que ele encontra —
`settings.json` no Claude Code, `config.toml` no Codex CLI. Os dois hooks do engine
vivem em `<asset home>/hooks/` e são **no-ops a menos que uma run esteja ativa**; o
prompt enhancer vive em `<asset home>/enhance/` e é um **no-op até você ligá-lo** —
então os três podem ficar instalados em toda sessão sem risco. O asset home é
`~/.claude/leopold` sempre que o Claude Code está presente e `~/.codex/leopold` numa
máquina só com Codex ([Asset Home](leopold-home.md)); os caminhos abaixo usam o
layout do Claude Code.

Os dois hooks do engine são **os mesmos scripts, sem modificação, nos dois
harnesses** — o Codex reimplementou o contrato de hooks do Claude Code quase campo a
campo, então não existe camada de portabilidade pra dar errado. Veja
[Claude Code e Codex](../concepts/harnesses.md).

## `stop-continuity.sh` — o hook de Stop

Roda quando o agente termina um turno. Contrato: lê JSON no stdin; imprime
`{"decision":"block","reason":"..."}` para continuar, ou sai com 0 para permitir a parada.

```mermaid
flowchart TD
    In["Evento Stop (JSON no stdin)"] --> Active{run ativa?}
    Active -- não --> Allow([exit 0 · permite parar])
    Active -- sim --> Owner{"a sessão que parou<br/>é a dona do run?"}
    Owner -- não --> Foreign(["exit 0 · permite parar ·<br/>foreign_stop + aviso"])
    Owner -- sim --> Kill{arquivo STOP?}
    Kill -- sim --> Allow
    Kill -- não --> Budget{budget / falhas atingidos?}
    Budget -- sim --> Allow
    Budget -- não --> Plan{itens do plano em aberto?}
    Plan -- não --> Allow
    Plan -- sim --> Human{"próximo item aberto<br/>é um nó @human?"}
    Human -- "sim · autonomy: ask" --> Ask(["exit 0 · permite parar ·<br/>awaiting_human"])
    Human -- "sim · autonomy: full" --> Persona["bloqueia · reinjeta:<br/>sintetize o papel, decida,<br/>registre com uma Reversal"]
    Human -- não --> Block["incrementa iteração ·<br/>bloqueia · reinjeta continue"]
```

Fail-open: qualquer erro inesperado permite a parada. A continuidade é melhor esforço;
parar é sempre seguro.

### Como uma parada permitida chega até você

Um hook de Stop tem dois canais de saída, e eles não são intercambiáveis. No caminho
de **bloqueio** (`{"decision":"block","reason":…}` no stdout) o motivo vai para o
modelo. No caminho de **permissão** — `exit 0`, que é toda parada acima — o stderr é
descartado: o harness expõe o stderr de um hook no exit 2, não no exit 0.

Por isso toda parada permitida sobre a qual uma pessoa precisa agir carrega seu aviso
como `systemMessage` no stdout, que o harness renderiza como um aviso `Stop says: …`.
Isso cobre o roll da janela, o teto `max_windows`, o veredito de livelock, a pausa
`awaiting_human` e o fail-safe `state_invalid`. O mesmo texto continua indo para o
stderr, para quem roda o hook na mão.

Isso importa mais do que parece: o aviso de roll era escrito só no
stderr no caminho de permissão, então uma run que rolava a janela parecia, de fora,
que o `/leopold-run` tinha desistido sozinho depois de um item do plano. Nada estava
quebrado — mas ninguém era avisado.

Os dois harnesses carregam o campo no mesmo fio: o Claude Code documenta
`systemMessage` para todos os hooks, e o Codex desserializa `reason` / `stopReason` /
`suppressOutput` / `systemMessage` no seu `StopCommandOutputWire`.

### Propriedade da sessão — uma sessão conduz um run

Um run é conduzido por **uma sessão**. O `state.json` a registra como `owner`
(`session_id`, `harness`, `engine`, `claimed_at`, `pid`, `transcript_path`), escrito uma
vez pelo engine que ativou o run: o Step 1 do `/leopold-run` (engine `skill`; o id da
sessão é o que o harness exporta para todo shell que executa — `CLAUDE_CODE_SESSION_ID`
no Claude Code, `CODEX_THREAD_ID` no Codex) ou o `initState` do driver (engine `driver`,
sem id de sessão). Todo payload de Stop nomeia a sessão que parou como `session_id` — a
mesma string — então o hook faz uma comparação antes de contar qualquer coisa:

| Owner no `state.json` | Sessão que parou | O hook |
| --- | --- | --- |
| igual ao `session_id` do payload | a dona | continua e conta, exatamente como antes |
| outra sessão | não é a dona | **permite a parada**, não escreve nada no `state.json`, registra um evento `foreign_stop` nomeando as duas sessões e avisa a pessoa via `systemMessage` quem é a dona e como assumir o assento (`/leopold-run`) |
| engine `driver` | uma sessão que o driver criou (`LEOPOLD_SDK_WORKER=1` no ambiente) | permite a parada em silêncio — o conductor decide o que vem depois |
| engine `driver` | qualquer outra sessão | permite a parada com um aviso nomeando o run do driver e seu pid |
| presente, mas o payload não tem `session_id` | impossível escopar | continua como antes e registra `owner_unknown` uma vez (`no_session_in_payload`) |
| ausente (um state anterior ao registro) | qualquer uma | continua como antes e registra `owner_unknown` uma vez (`no_owner_in_state`) — reative com `/leopold-run` para vincular o run |

Um state escrito por um `/leopold-run` antigo carrega a sessão no `session_id` de
primeiro nível; o hook o lê como owner, então esses runs também ficam escopados. Um
state que um driver antigo escreveu tem `orchestrator_pid` e nenhuma sessão: é um run do
driver.

Por que existe: em 2026-09-02 uma segunda janela do Claude Code, aberta num checkout
para uma pergunta sem relação, foi bloqueada por este hook, cobrada em nove das dezessete
iterações do run e encerrou um run produtivo com `no_progress` — o executor nunca tinha
parado uma vez sequer. A mesma regra encerra um defeito latente nos runs padrão do
driver, onde o hook disparava dentro de cada worker (eles rodam no cwd do projeto com os
hooks do usuário carregados) e mandava cada um pegar o próximo item do plano depois do
seu status block ([SDK Worker Hooks](sdk-worker-hooks.md)).

Duas consequências a mais de um único owner: o budget de contexto é medido apenas na
transcrição da dona (uma parada estrangeira não sobrescreve mais `transcript_path`), e
todo evento que o hook registra carrega `session` (os oito primeiros caracteres do id).

**Um escritor por vez.** Toda parada contada toma um lock `mkdir`
(`.leopold/.state.lock`) em volta do seu read-modify-write do `state.json`; um lock com
mais de um minuto é de um hook que morreu e é recolhido. Antes dele, duas paradas no
mesmo segundo — ou uma parada com o hook fiado duas vezes — perdiam uma atualização em
cada contador. Se o lock não puder ser tomado em cerca de cinco segundos a parada ainda
é contada e um evento `lock_timeout` diz isso: continuidade vence precisão de contador.

**O hook é o dono dos contadores.** `iteration`, `no_progress`, `progress_sig`,
`windows`, `window_*`, `context_mb`, `transcript_path`, `last_turn` e `owner` são
escritos só pelo hook (e pela ativação); a skill de run diz isso nas regras duras.

**Quem mais lê o owner.** `scripts/leopold-owner.sh` é o único leitor, compartilhado por
`/leopold-run` (que se recusa a iniciar ao lado de uma dona viva e assume uma abandonada;
`--takeover` força), `/leopold-stop` (que se recusa a encerrar o run de outra sessão viva
sem `--force`), `/leopold-status`, `leopold doctor` e `leopold watch`. Vitalidade é
qualquer sinal dentro de dez minutos: o pid do harness da dona ainda roda, `last_turn`
está fresco, ou o arquivo de transcrição da dona foi modificado — então um executor que
trabalha um turno longo sem parar nunca é lido como abandonado.

Verificado ao vivo no Claude Code 2.1.258 e no Codex CLI 0.150.1: o `session_id` do
payload de Stop é igual ao `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` do shell;
sobrevive a `claude -p --resume`; subagentes do Agent tool disparam `SubagentStop` (com
o id do pai), nunca `Stop`; e um processo de hook do Codex não herda nenhuma variável
`CODEX_*`, então no Codex o payload é a única identidade que um hook tem.

### O roll da janela de contexto

Desde a 0.18.0 o budget de contexto é **um evento de manutenção, não uma morte** — a
mudança de comportamento é explícita, não implícita. O hook mede o transcript contra
`max_context_mb` (padrão 5 MB) a cada turno:

- **Em ~80% do budget** o turno é bloqueado com uma instrução de checkpoint: escrever
  ou fazer merge do `.leopold/CHECKPOINT.md` — o contrato único em
  `packages/driver/src/checkpoint.ts` (título fixo, sete seções fixas,
  merge-sem-aninhar, teto de 32768 bytes que falha alto) — e então continuar o plano.
  A instrução é reinjetada a cada turno na faixa; o merge é idempotente. Um evento
  `checkpoint_instruction` é logado.
- **Em 100% e ainda sem checkpoint, a janela ganha um turno para escrever um.** A
  faixa de 80% só é alcançada por uma janela que subiu por ela; uma run ativada dentro
  de uma sessão *já* acima do budget cai direto no roll e nunca seria avisada uma vez
  sequer para fazer checkpoint — justamente a janela cujo estado de trabalho é o mais
  caro de perder. Então o turno é bloqueado com a instrução de checkpoint em vez de
  rolar, e um evento `checkpoint_grace` é logado. O limite mora no código, não no
  prompt: `checkpoint_grace_window` registra a janela que o gastou, então uma janela
  adia no máximo uma vez e o turno seguinte rola de todo jeito. Esse turno não gasta o
  resgate de falha da run — ele existe para preservar estado, não para tentar o item
  de novo.
- **Em 100%** a parada acontece com o motivo de sempre —
  `stopped_reason: context_budget`, consumidores o leem — mas o estado diz roll:
  `windows` é incrementado, o vetor de checkboxes do plano é fotografado, e
  `checkpoint_written` registra se o checkpoint existe (um ausente é nomeado em voz
  alta na mensagem de stop, nunca em silêncio). A mensagem sempre nomeia o caminho de
  retomada; um evento `window_roll` é logado.
- **Antes de rolar, dois gates rodam.** O **gate de livelock**: cada roll registra
  quantos itens do plano a janela que termina fechou (diff do vetor de checkboxes
  contra a fotografia do início da janela); duas janelas consecutivas fechando zero
  itens param a run com `no_progress_across_windows` — sem ponteiro de retomada, nada
  relança. E o **`max_windows`** (state > `GUARDRAILS.md` > 10) limita o total de
  janelas que uma run pode consumir; alcançá-lo para a run com `max_windows`.
- **Budgets sobrevivem ao roll.** `iteration`/`max_iterations` é o teto da run somando
  todas as janelas, e one-shots gastos (o resgate de falha, o reparo de deadlock)
  continuam gastos por toda ressemeadura. Nada que um roll faz renova um budget ou
  limpa o `.leopold/STOP`.

Com `continuity: auto` (o padrão no `GUARDRAILS.md`), o `leopold watch` detecta o roll
e relança a run headless no harness dono da sessão (`claude -p` / `codex exec`),
depois de rechecar por conta própria o kill switch, o `max_windows` e o gate de
livelock. Com `continuity: manual` nada relança — você retoma com `/leopold-run`. A
instrução de continue reinjetada também carrega a linha da janela (`Window N/max`) e
manda o agente tratar o workspace, os resultados de ferramentas e o estado durável
como autoridade acima da narração anterior. A história completa:
[Continuidade](../concepts/continuity.md).

Um projeto sem checkpoint e com guardrails padrão se comporta exatamente como na
0.17.x, exceto que a mensagem de stop agora nomeia o caminho de retomada.

### Tipos de nó

Itens do `PLAN.md` podem declarar um tipo de nó (`@node work|gate|human|tool|verify|feedback`,
ou os atalhos `@gate` / `@human` / `@tool` / `@verify` / `@feedback`). O motor in-session age sobre um
deles — **`@human`** — e o que ele faz com um depende da postura de julgamento
([`autonomy`](#autonomy)), nunca do harness em que você está:

- **`autonomy: full` (o padrão).** Ninguém vai vir, então o hook **bloqueia a parada** e
  reinjeta uma instrução para sintetizar o papel que aquela decisão exige — um nome, um
  título de papel, a expertise que o item realmente demanda, o que esse papel otimiza e as
  regras duras copiadas literalmente do `CHARTER.md` — assumir esse papel, fazer o item e
  registrar a decisão em `.leopold/DECISIONS.md` com uma linha **Reversal**. Ele registra
  um evento `persona` (`fork: "human"`, `engine: "hook"`) e nomeia o item no stderr. A
  fronteira de confiança não muda: um papel *decide*, ele nunca publica — e a instrução
  reinjetada é precisa sobre o que de fato garante isso. O `guard-irreversible.sh` nega
  `git commit` e `git push` (force-push sempre) e mais nada; `git tag`, `npm publish`,
  `gh pr create`, `gh release create`, aumentar um budget no `state.json` e editar o
  `GUARDRAILS.md` **não são bloqueados por hook nenhum** — são regras que o papel recebe
  para cumprir sozinho, e ele é avisado com todas as letras de que nenhum hook vai impedi-lo.
  Veja [o que o guard garante e o que não garante](#o-que-o-guard-garante).
- **`autonomy: ask`.** O hook permite a parada com `stopped_reason: awaiting_human`,
  nomeia o item no stderr e registra um evento `awaiting_human`. Responda, marque o item
  como `[x]` e `/leopold-run` retoma.

Nos dois casos ele bate com o driver, que resolve o mesmo nó do mesmo jeito a partir da
mesma postura — então um plano significa a mesma coisa nos dois motores.

Qualquer outro tipo continua como antes, e um item que não declara tipo é um nó `work` —
ou seja, um plano escrito antes da gramática existir percorre o hook por um caminho
idêntico. O `packages/driver/test/hook-kinds.test.ts` parseia os mesmos planos com o hook
e com o parser do driver e quebra o build se os dois discordarem.

#### `autonomy: full | ask` { #autonomy }

A postura é lida primeiro de `LEOPOLD_AUTONOMY`, depois de `autonomy:` no
`.leopold/GUARDRAILS.md`, e o padrão é `full`. `ask`, `halt` e `human` escrevem a postura
estrita; um valor que nenhum motor reconhece é tratado como ausente em vez de como `ask`,
porque uma linha ilegível nunca pode parar uma run em silêncio. Isso espelha o
`resolveAutonomy()` em `packages/driver/src/config.ts` — a única fonte extra do driver é a
flag `--autonomy` / `--ask`, que uma run in-session não tem equivalente.

## `guard-irreversible.sh` — o hook de PreToolUse

Roda antes de toda chamada de ferramenta. Contrato: lê JSON no stdin; imprime um
`hookSpecificOutput` com `permissionDecision: "deny"` para bloquear, ou sai com 0 para
permitir. Ele só adiciona negações; nunca afrouxa as permissões do próprio harness.

O Codex entrega esse evento com as mesmas chaves — `tool_name` (a ferramenta de shell
dele é reportada como `Bash`), `tool_input.command`, `cwd`, `transcript_path` — e
respeita a mesma resposta de negação.

### O que o guard garante

O escopo tem exatamente dois comandos de largura, e importa saber quais dois — sob
`autonomy: full` um nó `@human` é executado por um papel sintetizado, e é justamente ali
que moram as chamadas irreversíveis. Cada linha abaixo tem um caso em
`scripts/test-guard.sh`.

| Tentativa | Guard | Por quê |
| --- | --- | --- |
| `git commit` (incl. `git -c …`, `git -C …`, `/usr/bin/git`, tabs) | **negado** — a não ser que exista `.leopold/ALLOW_GIT` | a run prepara, o humano commita |
| `git push` | **negado** — a não ser que exista `.leopold/ALLOW_PUSH` | dar push é decisão do usuário |
| `git push --force` / `-f` | **negado**, sempre, com token ou sem | nada que uma run faça justifica |
| `git tag`, `npm publish`, `cargo publish`, `gh pr create`, `gh release create` | **permitido** | fora do escopo do lock |
| `rm -rf`, `git reset --hard`, `git clean -fd`, qualquer outro comando | **permitido** | o worker é livre para trabalhar |
| editar qualquer arquivo, incluindo `.leopold/GUARDRAILS.md` e `state.json` | **permitido** — o guard só inspeciona `Bash` | edições nunca são guardadas |

Ou seja: as outras regras da run — não dar tag, não publicar, não abrir PR externo, nunca
aumentar um budget nem editar o `GUARDRAILS.md` — são **política, não garantia**. O Leopold
diz exatamente isso a todo papel sintetizado, com essas palavras: um papel que acredita que
um hook vai barrar o `npm publish` não tem motivo para se segurar, e nada o impediria. Se
você precisa disso garantido em vez de instruído, negue nas permissões do próprio harness —
o `guard-irreversible.sh` nunca as afrouxa, ele só acrescenta as duas negações de git.

Veja a tabela de política em [Guardrails](../guardrails.md).

## `persona-guard.sh` — o hook PreToolUse de persona, escopado ao run

O terceiro hook em `hooks/` **não** faz parte da fiação sempre-ativa acima: o
maestro de persona o pluga (matcher `mcp__.*|WebFetch`, tag gerenciada própria
`leopold-persona-guard` pelo mesmo writer compartilhado) apenas enquanto um run
de persona está ativo, e o despluga no fim do run. Enquanto plugado, ele confere
cada `url` de uma chamada de ferramenta MCP ou `WebFetch` contra a allowlist de
domínios do flow ativo e nega qualquer coisa fora — antes de o servidor MCP receber a
chamada, nos dois harnesses, verificado ao vivo. O hook também é inerte sem um
`.leopold/persona/ACTIVE.json` ativo, então uma fiação órfã nunca limita uma
sessão normal. Payloads capturados, versões e a política completa:
[Hooks do Persona Guard](persona-guard-hooks.md); suíte red-team:
`scripts/test-persona-guard.sh`.

## `enhance.py` — o prompt enhancer de UserPromptSubmit

Roda a cada prompt que você envia (o evento não aceita matcher, então todo o gating é
interno). Contrato: lê o JSON do hook no stdin; texto puro no stdout é injetado como
contexto ao lado do prompt bruto (texto puro, não JSON, para concatenar com segurança
com outros hooks de `UserPromptSubmit`); **sempre sai com 0** — o prompt em si nunca é
modificado nem bloqueado. O Codex valida o stdout do hook como JSON estrito, então
nesse harness o mesmo texto vai embrulhado em `hookSpecificOutput.additionalContext` —
a forma em texto puro loga `hook: UserPromptSubmit Failed` lá e nunca chega no modelo.
O engine detecta qual harness mandou o payload e responde no dialeto dele.

```mermaid
flowchart TD
    In["UserPromptSubmit (JSON no stdin)"] --> Rec{env de recursão / kill switch?}
    Rec -- sim --> Silent([exit 0 · silencioso])
    Rec -- não --> On{habilitado no state.json?}
    On -- não --> Silent
    On -- sim --> Skips{"comando · ack · código colado ·<br/>&gt;60 palavras · run ativa · cooldown?"}
    Skips -- sim --> Silent
    Skips -- não --> Score{score de fraqueza ≥ 4?<br/>âncora veta}
    Score -- não --> Silent
    Score -- sim --> Call["claude -p haiku<br/>(charter + profile + cauda do transcript)"]
    Call -- falha --> Ledger2["ledger: injected=false"] --> Silent
    Call -- ok --> Inject["injeta interpretação ·<br/>ledger · carimbo de cooldown"]
```

Fail-open: sem `claude` no PATH, timeout, erro de API, saída malformada — nada é
emitido e o prompt segue intocado. Detalhe completo (tabela do gate, estado,
ledger, o loop de learn): [Prompt Enhancer](enhance.md).

## Wiring, por harness

### Claude Code — `~/.claude/settings.json`

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "~/.claude/leopold/hooks/stop-continuity.sh" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "~/.claude/leopold/hooks/guard-irreversible.sh" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 ~/.claude/enhance/enhance.py --event user-prompt", "timeout": 30 } ] }
    ]
  }
}
```

### Codex CLI — `~/.codex/config.toml`

Os mesmos hooks, em TOML, dentro de um bloco gerenciado delimitado por marcadores que
uma reinstalação troca e mais nada. Os dois hooks do engine:

```toml
# >>> leopold (managed) >>>
[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/guard-irreversible.sh"
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/stop-continuity.sh"
timeout = 15
# <<< leopold (managed) <<<
```

O prompt enhancer e cada extension ganham o próprio bloco com tag
(`# >>> leopold:enhance (managed) >>>` e companhia), então cada um é instalado,
atualizado e removido sem encostar nos outros.

A config é copiada antes do merge e o resultado é validado: uma escrita que não
parsearia volta atrás e o bloco é impresso pra você colar. Os dois formatos saem de um
único escritor compartilhado, o `extensions/lib/harness.sh`, então os dois harnesses
não têm como divergir.

!!! warning "Hooks do Codex ficam inertes até serem confiados"
    O Codex não executa um hook declarado no `config.toml` enquanto você não aprovar
    uma vez (`hooks.state."<id>".trusted_hash`) — sem erro, ele simplesmente não roda.
    Aprove numa sessão interativa, ou instale o Leopold como plugin do Codex, que
    confia nos hooks vindos do plugin pela própria instalação. Workers headless
    iniciados por `leopold run --provider codex` passam
    `--dangerously-bypass-hook-trust` e armam o próprio trava-git. O `leopold doctor`
    reporta em que estado cada harness está.

## Log de eventos

Os dois hooks do engine anexam eventos estruturados em `.leopold/events.jsonl`
(`turn_start`, `stop`, `guard_block`, os eventos de propriedade `foreign_stop`,
`owner_unknown`, `owner_takeover` e `lock_timeout`, e os eventos de continuidade
`checkpoint_instruction`, `checkpoint_grace`, `window_roll`,
`no_progress_across_windows`, `max_windows`; o watcher adiciona `window_relaunch` /
`window_relaunch_refused`),
que o `/leopold-status` lê. O enhancer, por sua
vez, registra no próprio ledger global — `~/.claude/enhance/enhancements.jsonl`, uma
linha por injeção ou tentativa falha — que o `/leopold-enhance learn` minera.
