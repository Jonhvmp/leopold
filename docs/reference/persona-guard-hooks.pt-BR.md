# Hooks do Persona Guard — Verificação ao vivo

**A pergunta:** o allowlist de domínios de uma run de persona precisa ser
imposto, não pedido. O maestro valida cada ação registrada no journal em código,
mas o limite também pode viver *antes da chamada da ferramenta* — um hook
`PreToolUse` consegue observar e negar chamadas de ferramentas de browser/MCP,
com matcher em nomes de ferramentas MCP, no Claude Code? E o que o equivalente
do Codex CLI enxerga? Esta página é a evidência capturada de runs ao vivo nos
dois harnesses, e a política que essas capturas decidiram.

**A resposta: ambos.** No Claude Code *e* no Codex CLI, um hook `PreToolUse` com
matcher `mcp__.*` dispara para chamadas de ferramentas MCP, enxerga o
`tool_input` completo (URL incluída), e um `permissionDecision: "deny"` bloqueia
a chamada **antes de o servidor MCP recebê-la**. O persona guard é, portanto,
plugado nos dois harnesses — `hook_bound=both`.

## Versões

| Componente | Versão |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.235 |
| Codex CLI (`codex`) | codex-cli 0.147.0 |
| Node.js | v22.22.0 |
| jq | 1.7.1 |
| Leopold | working tree 0.20.x (`hooks/persona-guard.sh`, `extensions/lib/harness.sh`) |
| Data | 2026-08-18 |

## Método (hermético)

- Uma raiz de probe descartável sob `mktemp -d` (`/tmp/leopold-persona-hookprobe.*`).
- Um **servidor MCP stub** (`mcp-stub.js`, stdlib do Node, JSON-RPC delimitado
  por newline) expondo duas ferramentas com cara de browser, `navigate(url)` e
  `click(label)`. O stub registra em log próprio cada `tools/call` que de fato
  *recebe* — assim uma negação no nível do hook é provada pela **ausência** da
  chamada nesse log, não por raciocínio.
- Um hook de probe que anexa o payload completo do stdin, verbatim, a um log de
  marcador, e em modo deny responde com o objeto padrão
  `hookSpecificOutput.permissionDecision: "deny"`.
- **Claude Code:** um projeto temporário com `git init`; o hook plugado no
  `.claude/settings.json` do próprio projeto com matcher `mcp__personastub__.*`;
  o stub registrado por run via `--mcp-config` + `--strict-mcp-config`; runs por
  `claude -p` (a config autenticada do usuário é apenas *lida*, exatamente como
  na run 2 de [Hooks do worker SDK](sdk-worker-hooks.md)).
- **Codex CLI:** um `CODEX_HOME` temporário com `config.toml` (servidor stub +
  bloco de hook) e uma cópia do arquivo de auth, apagada depois das runs; runs
  por `codex exec --json --skip-git-repo-check … --dangerously-bypass-hook-trust`
  com stdin fechado.
- Por fim, a **pilha de produção**: o `hooks/persona-guard.sh` entregue, plugado
  pelo writer entregue (`leo_wire_persona_guard` em `extensions/lib/harness.sh`),
  um flow real e um `ACTIVE.json` real, uma run ao vivo por harness.

## Evidência — Claude Code

**Observar.** Matcher `mcp__personastub__.*`, hook registra e permite. O payload
que o hook recebeu no stdin, verbatim:

```
{"session_id":"7513b65a-e4e8-4381-85cf-6fd4b2879bdc","transcript_path":"…/7513b65a-….jsonl","cwd":"/tmp/leopold-persona-hookprobe.rC1NUS/project","prompt_id":"134124b4-…","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"mcp__personastub__navigate","tool_input":{"url":"https://staging.example.com/welcome"},"tool_use_id":"toolu_01K8JEdUY6diBv1TdY4Ces1Z"}
```

O log do próprio stub mostra a chamada permitida chegando:
`{"ts":"2026-08-19T00:06:12.573Z","name":"navigate","args":{"url":"https://staging.example.com/welcome"}}`.

**Negar.** Mesma fiação em modo deny; o modelo foi instruído a navegar fora do
allowlist. O hook disparou com a URL completa em `tool_input`, respondeu deny —
e o log do stub **não ganhou linha nova**: o servidor MCP nunca recebeu a
chamada. A resposta final do modelo, verbatim:

```
BLOCKED persona guard (probe): navigation outside the domain allowlist of flow "checkout" — denied
```

## Evidência — Codex CLI

**Observar.** Primeiro um bloco `[[hooks.PreToolUse]]` sem matcher, para ver
tudo. O Codex dispara o mesmo evento com as mesmas chaves e a **mesma grafia
`mcp__<server>__<tool>`**, mais extras próprios (`turn_id`, `model`,
`permission_mode`). Verbatim:

```
{"session_id":"01a0175d-536f-7780-a81c-ec4dc582b609","turn_id":"01a0175d-551f-…","transcript_path":"…/codex-home/sessions/2026/08/18/rollout-….jsonl","cwd":"…/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"mcp__personastub__navigate","tool_input":{"url":"https://staging.example.com/welcome"},"tool_use_id":"exec-a1428c1d-…"}
```

**Negar.** Com o hook respondendo deny (e matcher `mcp__.*|WebFetch` numa segunda
run — o Codex honra a mesma sintaxe regex de matcher), a chamada foi bloqueada
antes do servidor; o log do stub ficou vazio e a resposta final do modelo trouxe
o motivo:

```
BLOCKED Tool call blocked by PreToolUse hook: persona guard (probe): navigation outside the domain allowlist of flow "checkout" — denied. Tool: mcp__personastub__navigate
```

**Controle de allow.** Mesma fiação, hook em silêncio: a chamada executou e o log
do stub a recebeu (`status":"completed"` no stream `--json`). Logo, o deny acima
foi o hook, não outra coisa no pipeline.

**A camada de aprovação, encontrada no caminho (assimetria honesta):** em
`codex exec` não interativo, chamadas MCP foram **auto-canceladas pela própria
mecânica de aprovação do Codex** — `"error":{"message":"user cancelled MCP tool
call"}` — sob `--sandbox read-only`, `--sandbox workspace-write` e até
`-c approval_policy=never`, com ou sem hooks. O único modo testado em que uma
chamada MCP *permitida* de fato executa headless é
`--dangerously-bypass-approvals-and-sandbox`. O hook dispara e nega em todos
esses modos (ele fica upstream), mas um worker de persona headless no Codex que
precise *navegar* precisa dessa flag — e, como já verificado para o git lock,
hooks declarados na config ficam inertes em runs headless sem
`--dangerously-bypass-hook-trust`. Os dois fatos pertencem ao seam de condução
do Codex, e o `leopold doctor` declara qual limite está em vigor em vez de
sugerir um hook que não está plugado.

## Evidência — a pilha de produção, ponta a ponta

O hook entregue (`hooks/persona-guard.sh`) plugado pelo writer entregue
(`leo_wire_persona_guard`), um `flows/checkout.md` real cujo allowlist é
`staging.example.com` + `accounts.example.com`, e um
`.leopold/persona/ACTIVE.json` real. Uma run ao vivo por harness, cada uma
instruída a navegar uma vez dentro e uma vez fora do allowlist.

Resposta final do Claude Code, verbatim:

```
OK
BLOCKED — Leopold persona guard: navigation to host "prod-dashboard.example.org" is outside the domain allowlist of flow "checkout"
```

Resposta final do Codex CLI, verbatim:

```
OK
BLOCKED Tool call blocked by PreToolUse hook: Leopold persona guard: navigation to host "prod-dashboard.example.org" is outside the domain allowlist of flow "checkout" — the persona stays inside the flow's bounds; journal the wall as a finding instead of retrying.. Tool: mcp__personastub__navigate
```

Nos dois harnesses o log do stub carrega **apenas** a navegação permitida, e o
`.leopold/persona/events.jsonl` do projeto carrega um evento
`persona_guard_block` por negação — host e flow, nunca a URL completa:

```
{"ts":"2026-08-19T00:28:06Z","event":"persona_guard_block","tool":"mcp__personastub__navigate","host":"prod-dashboard.example.org","flow":"checkout"}
```

## Descobertas

1. **PreToolUse enxerga chamadas MCP nos dois harnesses**, como
   `tool_name: "mcp__<server>__<tool>"` com o `tool_input` completo. Matcher em
   nomes de ferramentas MCP (`mcp__.*`) funciona nos dois — o Codex reimplementou
   a mesma semântica de matcher que já honra para `Bash`.
2. **O deny é imposto antes do servidor nos dois.** Uma chamada negada nunca
   chega ao servidor MCP (provado pelo log de recebimento do stub), e o modelo
   recebe o `permissionDecisionReason` verbatim — no Codex prefixado com
   `Tool call blocked by PreToolUse hook:`.
3. **A camada de aprovação do Codex é um portão separado e adicional** para
   chamadas MCP em runs `exec` headless (auto-cancela a menos que as aprovações
   sejam contornadas). Ela restringe o caminho do *allow* e nunca enfraquece o
   caminho do *deny*.
4. **Os processos de hook recebem o `cwd` da sessão no payload** nos dois
   harnesses — é isso que permite a um guard relativo ao projeto
   (`.leopold/persona/ACTIVE.json`) se escopar sozinho, sem refiação do script
   por run.

## A política que esta evidência decidiu

`hooks/persona-guard.sh` é a metade em hook dos limites de persona, plugado nos
**dois** harnesses pelo único writer compartilhado:

- **Plugado apenas enquanto uma run de persona está ativa.** O maestro chama
  `leo_wire_persona_guard <path>` no início da run e `leo_unwire_persona_guard`
  no fim (`extensions/lib/harness.sh` — tag gerenciada própria,
  `leopold-persona-guard`, então plugar e desplugar nunca toca o git lock).
  Além disso, o hook é inerte sem um `.leopold/persona/ACTIVE.json` ativo, então
  uma fiação órfã deixada por um maestro que morreu nunca limita uma sessão
  normal.
- **O allowlist é lido do flow ativo** nomeado pelo `ACTIVE.json`, com a
  semântica exata do parser de flow do driver (`hostAllowed` em
  `packages/driver/src/persona-testing/flow.ts`): apenas http(s), hostname em
  minúsculas, pontos finais removidos, host exato ou subdomínio em fronteira de
  ponto, nunca substring. A autoridade termina em `/`, `\`, `?` ou `#`,
  exatamente como os parsers de URL WHATWG (Chromium, `new URL` do Node — a
  stack que de fato navega) tratam — então
  `https://evil.io\@staging.example.com/` é julgado como host `evil.io` e
  negado, nunca como `staging.example.com` atrás de um userinfo falso.
- **Desconhecido é fora.** `ACTIVE.json` malformado, flow ausente, allowlist
  vazio, URL que não parseia: tudo nega, cada um com motivo nomeado. Negações
  nomeiam o flow e são registradas em `.leopold/persona/events.jsonl` como
  `persona_guard_block` — só o host, nunca a URL completa, para que uma URL com
  credencial embutida jamais caia em texto gravado.
- **Escopo: o matcher plugado é `mcp__.*|WebFetch`** — a mesma alternância com
  que a sonda de negação acima rodou. Ele roteia as duas superfícies de
  navegação que o script julga: as ferramentas MCP de browser da persona e o
  `WebFetch` nativo (mesmo formato de `url`). Tudo que é semântico (pagamentos,
  deleções — a regra de irreversibilidade) continua sendo imposição do
  **maestro**: um hook não julga intenção. O hook é profundidade; o maestro é o
  limite.
- Cada negação tem um caso red-team em `scripts/test-persona-guard.sh`
  (tentativas de bypass incluídas: hosts parecidos, truques de sufixo, truques
  de userinfo nas duas direções — formas com barra invertida na autoridade
  incluídas, julgadas pelo host WHATWG —, chaves `url` aninhadas, payloads em
  lote), o par plugar/desplugar é assertado idempotente em
  `scripts/test-harness-lib.sh`, e o `leopold doctor` nomeia o limite de fato em
  vigor por harness.

## Hermeticidade

Toda escrita caiu sob a raiz de probe do `mktemp -d` (mais os diretórios de
transcript dos próprios harnesses para o projeto temporário). O `.leopold/`
deste repositório nunca foi tocado, nenhum browser real e nenhum site alvo real
foi envolvido — a única rede foi cada harness falando com sua própria API de
modelo. A cópia do arquivo de auth no `CODEX_HOME` temporário foi apagada depois
das runs.

<!-- @emit hook_bound=both -->
