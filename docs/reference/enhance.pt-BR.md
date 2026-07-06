# Prompt Enhancer

Prompts do dia a dia são naturalmente rasos — a pressa vira hábito ("fix login", "arruma o
build"). O enhancer é um único hook global de `UserPromptSubmit`: ele pontua todo prompt
e, quando um é genuinamente fraco, faz o **Haiku — na sua própria conta conectada** —
produzir uma interpretação estruturada, injetada como contexto *ao lado* do prompt bruto:

```
[leopold-enhance — structured interpretation of the prompt above]
Objective: ...
Context: ...
Constraints: ...
Done when: ...
Assumptions: ...
Rule: this is a machine interpretation to help you plan. If it conflicts with the
user's raw prompt, THE RAW PROMPT WINS.
```

O prompt bruto nunca é modificado nem bloqueado (a plataforma não permite, e a regra
injetada torna a precedência explícita). A interpretação espelha o idioma do
prompt — um prompt em português recebe uma interpretação em português.

O que o diferencia de um prompt enhancer genérico:

- **Ciente do charter.** Se o projeto tem um brief do Leopold, o rewriter lê
  `.leopold/CHARTER.md` (senão `MISSION.md`) — ele interpreta o prompt do jeito que *você*
  interpretaria, não do jeito que um usuário médio interpretaria.
- **Ciente da conversa.** O rewriter recebe as últimas trocas do transcript da sessão,
  então "agora faz o mesmo pro logout" resolve em vez de alucinar.
- **Autoaprendizado.** Todo enhancement cai em um ledger que o
  [`/leopold-enhance learn`](skills.md#leopold-enhance) minera em busca de correções,
  propondo regras para o seu `PROMPT-PROFILE.md` global — sem nunca aplicá-las sozinho.

## Ciclo de vida

Instalado **conectado, mas DESLIGADO** pelo `install.sh` (o hook é um no-op silencioso
enquanto `enabled` é false, e o merge no settings é idempotente, então reinstalações
nunca o duplicam). Ligue e desligue interativamente:

```
leopold menu → enhance → t) Toggle       # or: /leopold-enhance on|off
```

Destruição completa — desconecta o hook e apaga `~/.claude/enhance` incluindo o ledger
e o profile aprendido: `leopold menu` → `u) Uninstall` → `enhance`. Remover o core do
Leopold também remove o enhancer (foi o instalador do core que o conectou).

## O gate

Falso positivo é o que mata a UX: aprimorar um prompt bom desperdiça segundos e adiciona
ruído. Então os hard skips rodam primeiro, depois um score que exige vários sinais
independentes de fraqueza — e uma única âncora veta.

**Hard skips** (passagem silenciosa): enhancer desligado · comandos `!`, `#` · acks
curtos ("ok", "sim", "2") · código/logs colados (fences ou > 8 linhas) · prompts acima de
`max_words` · uma run autônoma do Leopold ativa no projeto · um cooldown por sessão
· as env vars de recursão/kill switch.

**Briefs em `/skill` são a exceção.** Um prompt com barra é pulado como comando
*a menos que* o argumento se leia como um brief de tarefa de verdade — pelo menos 8
palavras, e que não seja um dos verbos de controle do próprio enhancer
(`status` / `on` / `off` / `preview` / `learn`). Nesse caso o **argumento** é o que
passa pelo score e pelo rewriter, com o prefixo do comando removido — `/leopold-brief`
em si nunca conta como âncora. `"/leopold-brief adiciona microinterações no
onboarding, algo gostoso, sem exagero"` é gateado pelo brief; `/model opus` e
`/leopold-enhance preview …` continuam pulados.

**Score de fraqueza** (aprimora a partir de `min_score`, padrão 4):

| sinal | pontos |
|---|---|
| ≤ 25 palavras | +2 |
| 26–`max_words` palavras | +1 |
| sem estrutura (sem quebra de linha / bullet / lista numerada) | +1 |
| abertura vaga ("fix", "arruma", "melhora", …) e < 15 palavras | +1 |
| **âncora**: um path, extensão de código, `` `symbol` `` ou identificador CamelCase/snake_case | **−2** |
| pergunta formada (termina em `?`, ≥ 8 palavras) | −2 |

Então `"fix login"` pontua 5 → aprimorado; `"fix the retry loop in src/api/client.ts"`
pontua 2 → passa intocado. Verifique qualquer prompt com
`/leopold-enhance preview "your prompt"` — ele imprime a pontuação por sinal e
o bloco exato que seria injetado, sem tocar no ledger.

## A chamada do rewriter

```
claude -p --safe-mode --model haiku --output-format text --tools "" --no-session-persistence
```

- **Safe mode** mantém o seu login OAuth mas pula hooks, plugins, MCP e CLAUDE.md
  dentro do subprocesso — cerca de **metade da latência** de uma chamada headless comum,
  e a recursão fica estruturalmente impossível (o subprocesso não roda hook nenhum).
  Uma sondagem única (na instalação e ao ligar) confirma que a flag existe; um CLI
  antigo sem ela se autocorrige para o modo normal depois de dois *erros* consecutivos
  (timeouts nunca rebaixam — são lentidão de API, e o modo normal é mais lento). No
  modo normal, o guard de env `LEOPOLD_ENHANCE_ACTIVE=1` ainda bloqueia recursão (mais
  `OVMEM_DISABLE=1` para os hooks do ovmem não pagarem latência ali).
- Roda com `cwd=~/.claude/enhance` para que o CLAUDE.md *do projeto* nunca seja carregado.
- O Haiku está [sempre disponível em todos os planos](https://code.claude.com/docs) e a
  chamada custa uma fração de centavo; só prompts que passam pelo gate pagam a ida e
  volta — tipicamente 4–10 s, ocasionalmente mais quando a API enfileira (a latência do
  CLI headless é ruidosa) — limitada por um budget de 25 s do subprocesso e o timeout
  de 30 s do hook, e um estouro simplesmente falha aberto.
- **Fail-open, sempre**: sem binário `claude`, timeout, saída não-zero, output vazio ou
  malformado → nada é emitido, a falha vai para o ledger, a sessão nem
  percebe.

## Estado e ledger

Tudo vive em `~/.claude/enhance/` e nunca sai da máquina (a documentação em disco:
o [`RUNTIME.md`](https://github.com/Jonhvmp/leopold/blob/main/extensions/enhance/payload/RUNTIME.md)
é instalado como o README dele).

`state.json`:

```json
{
  "enabled": false, "model": "haiku", "safe_mode": true, "probed_at": null,
  "thresholds": { "min_score": 4, "max_words": 60, "cooldown_s": 120, "max_inject_chars": 1200 },
  "subprocess_timeout_s": 25, "consecutive_failures": 0
}
```

`enhancements.jsonl` — uma linha por injeção *ou tentativa falha* (skips do gate não
vão para o ledger); rotaciona a 2 MB mantendo uma geração:

```json
{"ts":"2026-07-05T14:03:22Z","session_id":"…","prompt_id":"…","cwd":"/home/me/app",
 "prompt_excerpt":"fix login","words":2,"score":5,
 "signals":{"short":2,"structure":1,"anchor":1,"vague":1,"question":0},
 "mode":"safe","model":"haiku","latency_ms":3840,
 "charter_used":true,"profile_used":false,"tail_used":true,
 "injected":true,"injected_chars":642,"error":null}
```

Controles de ambiente:

```
LEOPOLD_ENHANCE_DISABLE=1     kill switch (stays wired, does nothing)
LEOPOLD_ENHANCE_DEBUG=1       log gate decisions to ~/.claude/enhance/enhance.log
LEOPOLD_ENHANCE_MIN_SCORE     LEOPOLD_ENHANCE_MAX_WORDS
LEOPOLD_ENHANCE_COOLDOWN_S    LEOPOLD_ENHANCE_TIMEOUT_S
```

## O loop de learn

Enhancers genéricos não têm estado; este fecha o ciclo. O `/leopold-enhance learn`
compila a mesma estrutura de confiança do [`/leopold-learn`](skills.md#leopold-learn)
em um dynamic workflow: um **correlacionador de correções** cruza o ledger com os
transcripts das suas sessões e encontra prompts aprimorados que você corrigiu logo em
seguida; um **minerador de estatísticas do ledger** encontra disparos errados do gate
sem nunca sair do ledger; um passo de clusterização mescla os dois (um padrão presente
nos dois mineradores é o sinal mais forte); um **cético com viés de rejeição por
candidato** rejeita por padrão; os sobreviventes viram
`~/.claude/enhance/PROFILE-amendments.md` — uma proposta. Você aceita as regras
explicitamente; a skill nunca edita o `PROMPT-PROFILE.md` sozinha. Regras aceitas
alimentam toda interpretação futura, então a cada passada o enhancer lê os seus
atalhos de escrita um pouco mais do seu jeito.

## Privacidade & limitações

- **Os prompts ficam locais.** Trechos (≤ 500 chars) vivem no ledger em
  `~/.claude/enhance` — o mesmo domínio de confiança dos transcripts de `~/.claude/projects`.
  A única chamada de rede é o rewriter, pelo seu próprio login do `claude`. A
  opção de uninstall apaga tudo.
- **Latência** só em prompts genuinamente fracos (o gate em si é < 10 ms de
  Python); um cooldown de 120 s por sessão o impede de disparar em trocas rápidas.
- **Instalações via plugin**: as extensões vêm com as instalações via repo/npm, não com
  o plugin do Claude Code — usuários do plugin conseguem o enhancer com
  `npm i -g leopold-driver && leopold enhance install`.
- **Sistemas sem jq**: o wiring (instalar/remover) precisa de `jq`, como toda extensão
  do Leopold; o runtime e o toggle são python3 puro.
