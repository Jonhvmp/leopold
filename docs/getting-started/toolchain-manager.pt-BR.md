# Gerenciador de Toolchain

O Leopold traz um pequeno menu interativo pra instalar e gerenciar, num lugar só, a toolchain
que ele conduz (gstack) e as extensões companheiras (como ovmem e enhance). Ele generaliza a
pergunta pontual de "instalar o gstack?" do instalador num registry orientado a dados.

```bash
make menu
# or, from an install:
bash ~/.claude/leopold/scripts/leopold-menu.sh
```

```
========================================
  Leopold - toolchain manager
========================================
   1) Leopold   installed             — the harness (skills + hooks)
   2) serena    installed             — LSP code intelligence (MCP, mandatory)
   3) gstack    installed             — planning / QA skill suite
   4) ovmem     not installed         — RAG long-term memory
   d) Doctor all     q) Quit
```

Escolha um componente pra instalar, atualizar, remover ou rodar o doctor dele.

## Como o registry funciona

Cada componente vive em `extensions/<name>/` com dois arquivos:

- `extension.json` — metadados que o menu renderiza (`name`, `title`, `summary`, `order`).
- `manage.sh` — as ações que o menu chama: `detect | status | install | update | remove | doctor`.

O menu descobre tudo que está nessa pasta, então **adicionar um componente é só largar uma
pasta ali** — sem mudar código do menu. O `detect` é a fonte única da verdade pra "instalado?".
Cada `manage.sh` precisa ser idempotente, nunca pode tocar no seu git e nunca pode imprimir segredos.

## Desinstalar

A opção **`u`** do menu remove o Leopold de forma granular e **sem perder dados**. Ela pergunta
exatamente o que tirar e confirma cada escolha — o core do Leopold (skills + hooks + `~/.claude/leopold`),
o CLI `leopold`, serena, gstack e o engine do ovmem, todos **preservam os seus dados**. Apagar
a memória de longo prazo do ovmem (`~/.openviking`) é um item separado que exige digitar `DELETE`,
então nada precioso é removido por acidente. A exceção é o **enhance**, cuja entrada avisa isso
em amarelo: a remoção dele apaga `~/.claude/enhance`, incluindo o ledger de enhancement e o
prompt profile aprendido (eles são inúteis sem o engine). O `remove` de cada extensão
(usado aqui) despluga os hooks dela e apaga o engine, deixando os seus dados e qualquer servidor
compartilhado no lugar.

## Extensões embutidas

### serena (obrigatória)

A [Serena](https://github.com/oraios/serena) (MIT) dá ao agente **ferramentas em nível de símbolo,
com LSP por trás**, via MCP — `find_symbol`, `find_referencing_symbols`, `replace_symbol_body` — em vez
de grep + leitura de arquivos inteiros. O instalador do Leopold configura tudo automaticamente: instala
o `serena-agent` via uv se estiver faltando e então registra o servidor MCP pra todos os projetos
e pluga os hooks recomendados da Serena **uma vez por harness da máquina** — `claude mcp add
--scope user serena -- serena start-mcp-server --context=claude-code --project-from-cwd` mais
os hooks no `~/.claude/settings.json` no Claude Code, e `codex mcp add serena -- serena
start-mcp-server --context=codex --project-from-cwd` mais os hooks no `~/.codex/config.toml`
no Codex CLI. O `manage.sh status` e o `doctor` reportam cada harness separadamente, então
numa máquina com os dois você nunca vê o estado de um passando por ambos. (No Codex os hooks
ficam inertes até você aprovar uma vez — o doctor avisa.) É a maior alavanca isolada
pra **qualidade de código** *e* **contexto enxuto** (leituras em nível de símbolo custam bem
menos tokens — a mesma disciplina que os [guardrails de custo](../guardrails.md) impõem),
e é por isso que ela é obrigatória em vez de opcional. O setup usa o caminho oficial da Serena, não o
marketplace de MCP (que traz comandos desatualizados). Gerencie com `make serena-install` /
`make serena-doctor`.

### gstack

A suíte de skills de planejamento + QA que o Leopold conduz (`/spec`, `/autoplan`, `/plan-*-review`, …).
Um projeto MIT separado, do Garry Tan; a extensão clona o repositório e roda o setup dele. Precisa de Bun.

As skills do gstack são diretórios `SKILL.md` comuns, e **os dois harnesses as descobrem** —
o Claude Code em `~/.claude/skills`, o Codex CLI em `~/.codex/skills` — então a extensão roda
o instalador do próprio gstack uma vez por harness da máquina (`--host claude`, `--host
codex`), e o `status`, o `remove` e o `doctor` reportam cada um separadamente, contando as
skills que realmente aparecem naquele skills root. Uma máquina só com Codex mantém o checkout
no `~/.gstack/repos/gstack` do próprio gstack (ele recusa um checkout dentro do skills dir do
Codex, o que faria cada skill ser descoberta duas vezes) e não ganha nada em `~/.claude`.
`make gstack-install` / `make gstack-doctor`.

### ovmem

Memória RAG de longo prazo autônoma: ela liga o [OpenViking](https://github.com/volcengine/OpenViking)
ao seu agente através de 4 hooks nativos (SessionStart, UserPromptSubmit, PreCompact, SessionEnd),
então as sessões ficam otimizadas sem `/compact` ou `/clear` destrutivos. Destilação, dedup e
reconsolidação acontecem do lado do servidor; uma poda semanal por hotness impede o store de inchar.

Esses quatro eventos existem tanto no **Claude Code quanto no Codex CLI**, e o instalador declara
todos eles nos harnesses que estiverem na máquina — `~/.claude/settings.json` em JSON,
`~/.codex/config.toml` em TOML. O store de memória é um só pra máquina, então uma decisão registrada
numa sessão do Codex volta numa sessão do Claude Code. O Codex mantém um hook declarado em config
inerte até você aprovar uma vez, e limita o `SessionEnd` a 3 segundos — por isso o flush de fim de
sessão roda destacado lá. O `leopold doctor` e o doctor da própria extensão nomeiam todo harness que
ainda está sem a fiação.

O instalador traz o **perfil OpenAI**:

- pede uma chave da OpenAI e **valida contra chat + embeddings** antes de salvar
  (ela precisa do escopo `model.request`, não só de embedding),
- escreve `~/.openviking/ov.conf` (`chmod 600`), pluga os 4 hooks de forma idempotente em todo
  harness presente e verifica de ponta a ponta com uma ida e volta de commit → extract.

Tudo é **local e privado**: o servidor OpenViking faz bind em `127.0.0.1` (loopback) no
dispositivo do próprio usuário — ele não fica exposto à rede, e nada aponta pra um servidor
central. O único tráfego de saída vai pra OpenAI (com a chave do próprio usuário), pra embeddings e
extração. Um perfil totalmente local com Ollama/GGUF (sem chave) está no roadmap.

Suportado em Linux e macOS. No Windows nativo, rode dentro do WSL.

### enhance

O [prompt enhancer global](../reference/enhance.md): um hook de `UserPromptSubmit` que faz o
Haiku — na sua própria conta conectada — produzir uma interpretação estruturada de prompts
genuinamente fracos ("conserta o login") e injetá-la ao lado do prompt cru, que sempre vence em caso
de conflito. Ciente do charter quando o projeto tem um brief do Leopold, fail-open em qualquer erro,
e se aprimora sozinho via `/leopold-enhance learn`. Diferente das outras extensões, ele é instalado
(plugado, mas **desligado**) pelo instalador principal; a ação `t) Toggle` do menu — ou
`/leopold-enhance on|off` — é o interruptor. Precisa de python3 + jq; o reescritor usa o seu
login existente do `claude`, sem chave extra.
