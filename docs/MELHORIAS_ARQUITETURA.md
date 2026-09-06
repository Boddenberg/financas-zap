# Mapeamento de melhorias — arquitetura e tecnologia

Leitura do repositório inteiro (24 arquivos `.ts`, ~4,7 mil linhas) feita em
06/09/2026, no contexto dos quatro repositórios do workspace. Este documento
trata da **forma** — o que a estrutura pede — e não do que a ponte faz.

---

## O diagnóstico em uma frase

Este é, de longe, o repositório mais bem construído dos quatro — e o mais
frágil de todos, por uma razão que não está no código: **ele é o relógio do
hub inteiro, e mora num computador de casa.**

As duas coisas são verdadeiras ao mesmo tempo, e por isso a maior parte do que
segue não é sobre mudar este código. É sobre o que o resto do sistema apoiou
nele sem dizer.

---

## O que já está certo, e por números

| | |
| --- | --- |
| linhas de código | 2.994 |
| linhas de teste | 1.686 (**56%**) |
| arquivos sem teste | 3 (`index.ts`, `agente/http.ts`, `agente/caixa.ts`) |
| `noUncheckedIndexedAccess` | **ligado** — o único dos quatro repositórios |
| CI | audit, testes, typecheck, build |

A proporção de teste é a melhor do workspace por uma margem grande (o backend
tem ~45%, o web ~6%, o app 0%). O `tsconfig.json` é o mais estrito dos quatro.
E as fronteiras do `AGENTS.md` — uma porta por sistema externo, `unknown` para
todo JSON que chega, transcrição e interpretação sempre do outro lado — estão
cumpridas arquivo a arquivo.

Três decisões que merecem ser ditas em voz alta porque são incomuns:

- **quem conta tentativa e desiste é o backend**, não a ponte
  (`supabase-outbox-client.ts`, `agente/caixa.ts`). Isso é o que impede uma
  mensagem envenenada de travar a fila para sempre, e é o tipo de coisa que
  quase todo integrador de WhatsApp erra;
- **o `trace.ts` implementa W3C Trace Context à mão, sem SDK**, e o comentário
  explica por quê: o backend já lê `X-Trace-Id`, e um exporter futuro vira
  escrita em vez de reinstrumentação. É a decisão certa pelo motivo certo;
- **o diário registra a forma, não o conteúdo** — telefone em hash, mensagem em
  tipo e tamanho. Uma ponte que loga conversa é uma segunda cópia do dado
  sensível sem tela que a governe, e isso está escrito no código.

Nada disso precisa mudar. O que segue é o que está fora do código.

---

## 1. Alta prioridade

### 1.1 Um computador de casa é o agendador de todo o hub

Está escrito com todas as letras em `src/backend-pulse.ts`:

> O Finanças não tem agendador. O resumo do dia, o panorama da semana, o do mês
> e o fechamento de um bloco de registros acontecem porque esta ponte […] avisa
> o backend antes de perguntar.

E confirmado do outro lado, em `Financas/app/modulos/casa/rotas.py:399`:

> Este é o relógio do módulo. O backend não tem agendador, e é este pedido […]
> que dá ao resumo diário, ao panorama semanal, ao mensal e ao fechamento de um
> bloco a chance de acontecer na hora marcada.

A fronteira está desenhada com cuidado — a ponte não interpreta nada, não sabe o
que venceu, não monta texto. **O desenho está certo; a topologia é que não
está.** Um Windows doméstico que reinicia para atualizar, um cabo solto, um
Wi-Fi que cai à noite: qualquer um deles significa que o hub inteiro não produz
nada periódico até alguém reparar. E não há como reparar rápido, pelo item 1.2.

**Proposta.** O conserto não é aqui — é no `Financas` — e o ponto importante é
que ele é **aditivo**: o pulso já é idempotente (a migration
`20260819010000_calendario_idempotencia_whatsapp.sql` existe justamente para
isso), então uma segunda fonte batendo o mesmo relógio não duplica nada.

Duas opções, ambas de uma tarde:

1. **`pg_cron` no Supabase**, chamando a mesma lógica. Zero infraestrutura nova;
2. **um cron service no Railway** batendo em `POST /casa/whatsapp/pulso` — é
   literalmente o que esta ponte faz, só que de um lugar que não desliga.

Com qualquer uma delas, esta ponte continua mandando o pulso e passa a ser
**redundância**, que é o papel adequado para ela. O que muda não é o código
daqui; é que o resumo da manhã deixa de depender de um PC estar ligado.

**Esforço**: meio dia, no `Financas`. É o item de maior consequência deste
documento.

### 1.2 Ninguém percebe quando a ponte cai

A ponte manda um pulso por minuto (`POLL_INTERVAL_SECONDS`, padrão 60). O
backend recebe, faz o que venceu e responde. E é só.

Não existe registro de "a última ponte falou às 14:32". Procurei por
heartbeat, batimento, saúde ou sinal de vida no `src/` e não há nada; do lado do
backend, `pulso_da_ponte` chama `servico.pulsar` e devolve o que enfileirou —
não anota que a ponte esteve viva.

Consequência: **silêncio e "nada a fazer" são indistinguíveis.** Uma ponte
parada há seis horas parece exatamente igual a uma casa tranquila. Quem descobre
é a pessoa, quando repara que o resumo da manhã não chegou — e aí o dado já foi
perdido.

O detalhe que torna isso barato de resolver: **o backend já tem a informação**.
Cada pulso é uma requisição autenticada por `ponte_id`, e a tabela
`pontes_whatsapp` já existe com uma linha por ponte.

**Proposta**

1. no `Financas`, `pulso_da_ponte` grava `ultimo_pulso_em = now()` na linha da
   ponte. Uma coluna, um `update`, nenhuma tabela nova;
2. o próprio pulso — que já roda toda vez — verifica se alguma ponte ativa está
   silenciosa há mais de N minutos e enfileira um aviso. Com o item 1.1 no
   lugar, isso funciona mesmo com a ponte caída, porque quem bate o relógio
   passa a ser o cron. **Sem o 1.1, essa verificação nunca roda justamente no
   caso em que ela importa** — é por isso que os dois itens andam juntos, nesta
   ordem;
3. opcionalmente, `/observabilidade` mostra a última batida de cada ponte.

**Esforço**: meio dia, no `Financas`. Depende do 1.1 para valer.

### 1.3 `whatsapp-web.js` é a dependência mais arriscada do workspace, e não há plano B escrito

O `AGENTS.md` já diz o essencial — *"`whatsapp-web.js` é não oficial; mantenha a
integração atrás do adaptador"* — e o adaptador existe e é respeitado
(`whatsapp-client.ts` é a única porta, com 193 linhas de teste). Isso é o
máximo que o código pode fazer, e foi feito.

O que falta é a outra metade: **o que acontece quando quebrar.** E vai quebrar —
é uma biblioteca que automatiza o WhatsApp Web por Chromium; uma mudança no
front do WhatsApp derruba, e a conta pode ser banida por automação. Não é
hipótese remota, é o modo de falha esperado desse tipo de integração.

Hoje, se acontecer amanhã: a Casa para de mandar resumo, o agente para de
responder no WhatsApp, e — pelos itens 1.1 e 1.2 — nada periódico acontece no
hub inteiro **e ninguém é avisado**.

**Proposta**: um ADR curto (`docs/decisoes/0001-whatsapp-nao-oficial.md`) que
registre o que já foi decidido e o que se faz quando quebrar. Não é burocracia;
é a diferença entre uma noite ruim e uma semana ruim. O conteúdo mínimo:

- **por que não oficial**: a API oficial (Cloud API) cobra por conversa, exige
  número de negócio verificado e não entrega em grupo do jeito que a Casa usa.
  Isso é uma razão boa e deve estar escrita, senão a pergunta volta todo ano;
- **o que é o adaptador e o que ele isola**: `whatsapp-client.ts` para saída,
  `agente/entrada.ts` para entrada. Uma troca de biblioteca mexe nesses dois e
  em mais nada — isso é verdade hoje e é o ativo mais valioso do repositório;
- **o degradê aceito**: com a ponte fora, o hub continua inteiro no web e no
  app; só o canal WhatsApp cai. Dito assim, a falha vira incômodo em vez de
  incidente — desde que 1.1 esteja feito;
- **os sinais de banimento** e o que fazer com eles.

**Esforço**: 1 hora. O valor não está no tempo gasto.

---

## 2. Média prioridade

### 2.1 Os três arquivos sem teste são exatamente os que orquestram

`index.ts` (367 linhas), `agente/caixa.ts` (146) e `agente/http.ts` (21) são os
únicos sem `.test.ts`. Os dois primeiros não são detalhe: `index.ts` é onde o
QR, a sessão, o ciclo de vida, o `AbortSignal` e as duas caixas se encontram, e
`caixa.ts` é a porta do Supabase para o canal do agente — o irmão do
`supabase-outbox-client.ts`, que **tem** 116 linhas de teste.

O `http.ts` pode ficar sem: são 21 linhas de formatação de erro.

**Proposta**

- **`caixa.ts` primeiro**, e é o mais fácil: o teste do irmão
  (`supabase-outbox-client.test.ts`) já tem o dublê de `fetch` pronto e o
  formato das asserções. É copiar e trocar o contrato;
- **`index.ts` merece extração antes de teste.** Ele mistura três coisas —
  interpretar argumentos de linha de comando (`--demo`, `--list-groups`,
  `--test-message`), montar as dependências, e rodar o ciclo. Separar a montagem
  numa função que recebe config e devolve as peças torna o ciclo testável sem
  Chromium nenhum. Não é refatoração grande: é mover o meio do arquivo para uma
  função com nome.

**Esforço**: meio dia para `caixa.ts`; 1 dia para a extração de `index.ts`.

### 2.2 O ritmo de 2 segundos custa mais do que parece

`agente/monitor.ts` alterna entre `AGENTE_POLL_ATIVO_MS` (2.000) quando alguém
espera resposta e `AGENTE_POLL_PARADO_MS` (15.000) quando não. O canal da Casa
tem seu próprio `POLL_INTERVAL_SECONDS` (60).

A escolha é bem justificada — uma resposta que demora 15 segundos para aparecer
depois de pronta parece travada. Mas o `AGENTS.md` tem uma seção chamada "Peso"
que diz, com razão, que *"toda mudança que acrescente […] trabalho a cada ciclo
precisa se justificar"*. Vale aplicar a mesma régua ao que já existe: a 2
segundos, uma conversa de dez minutos são 300 consultas ao PostgREST, todas
vazias depois da primeira.

**Proposta**, e a ordem importa:

1. **medir antes de mexer.** O `trace.ts` já existe e o diário já é JSON por
   linha — contar quantas leituras voltaram vazias por conversa é uma soma, não
   uma instrumentação nova. Pode ser que o número seja irrelevante, e aí não se
   mexe;
2. se incomodar, o recuo é a saída óbvia: 2s nas primeiras leituras depois de
   uma mensagem repassada, subindo para 5s e 10s enquanto a caixa voltar vazia.
   O agente responde em segundos, então o recuo quase nunca chega ao fim;
3. o que **não** vale é Realtime do Supabase. Trocaria polling barato por uma
   conexão WebSocket persistente num Wi-Fi doméstico — mais frágil, e contra o
   espírito da seção "Peso".

**Esforço**: 2 horas para medir; meio dia para o recuo, se for o caso.

### 2.3 A instalação no Windows não tem como se explicar

`scripts/` tem `instalar-inicializacao.ps1`, `remover-inicializacao.ps1`,
`situacao.ps1` e um `.vbs` — e o `AGENTS.md` os limita corretamente a
instalação, sem regra de negócio. Só que nada disso roda no CI (é Ubuntu), e um
erro de PowerShell só aparece na máquina onde importa.

Não vale montar um runner Windows para quatro scripts. Vale o mais barato:

**Proposta**: um `npm run windows:situacao` que já existe e imprime o estado —
garantir que ele responda três perguntas em uma tela: a tarefa agendada está
registrada, o processo está de pé, e **quando foi o último pulso bem-sucedido**.
A terceira é a que falta hoje, e ela é local (a ponte sabe a resposta), então
não depende do item 1.2. É o diagnóstico de primeira linha para "o resumo não
chegou hoje de manhã".

**Esforço**: 2 horas.

---

## 3. Tecnologia — o que trocar, o que manter

| Peça | Hoje | Recomendação |
| --- | --- | --- |
| `whatsapp-web.js` | 1.34 (não oficial) | **Manter, e documentar a saída** (1.3). A alternativa oficial não atende o caso de uso e custa dinheiro por conversa. |
| Node | 24 (`.node-version`), `engines >=20.9` | **Manter.** |
| TypeScript | **^7.0.2** | **Atenção.** Este é o único repositório do workspace já no TS 7 (os outros três estão no 5.9). Está funcionando e o `build` passa no CI, então não é problema — mas é uma divergência que ninguém decidiu: vale ou alinhar os quatro, ou registrar num ADR por que este vai na frente. Divergência silenciosa entre repositórios é o que produz "funciona aqui e não lá". |
| `tsconfig` | `strict` + `noUncheckedIndexedAccess` | **Manter, e copiar para os outros.** É a configuração mais correta dos quatro repositórios, e `noUncheckedIndexedAccess` é exatamente o que pega o bug de índice que os outros três podem ter. |
| Executor de testes | `node --test` via `tsx` | **Manter.** Sem dependência extra, e a proporção de teste prova que funciona. Não trocar por Vitest só por uniformidade. |
| `dotenv` | 17.4 | **Avaliar remover.** Node 20.6+ tem `--env-file` nativo, e o `start` já é `node dist/index.js`. Uma dependência a menos numa ponte que roda 24/7 é ganho pequeno mas alinhado com a seção "Peso". Só que `dotenv` também é lido pelo `tsx` no `dev` — verificar antes de tirar. |
| `qrcode-terminal` | 0.12 | **Manter.** Faz uma coisa e é a única forma de parear. |
| Observabilidade | `trace.ts` próprio, W3C | **Manter.** O caminho para OTLP já está aberto e não custa nada hoje. |
| Agendamento | esta ponte | Ver 1.1: **mover para o backend**, mantendo esta como redundância. |
| Dependabot + `npm audit` | ambos configurados | **Manter.** |

---

## 4. O que este repositório revela sobre o workspace

Três coisas daqui deveriam atravessar para os outros três, e é mais fácil ver
isso de fora:

1. **`noUncheckedIndexedAccess`** — ligado só aqui. Os outros dois repositórios
   TypeScript ganhariam de graça, ainda que com dívida inicial;
2. **a proporção de teste** — 56% aqui, 0% no `Financas-app`. E a razão não é
   que este código seja mais crítico: é que ele nasceu pequeno e com o hábito
   formado;
3. **o `AGENTS.md` de 60 linhas** — este repositório documenta *fronteiras e
   razões* em uma tela. O do `Financas-app` tem 1.215 linhas e diz coisas
   igualmente boas, mas ninguém as lê inteiras. Tamanho de documento é decisão
   de arquitetura também.

---

## 5. Ordem sugerida

Note que os três itens de alta prioridade **quase não têm código neste
repositório** — o conserto é no `Financas`, e é sobre parar de apoiar o hub
inteiro numa máquina doméstica.

| # | O quê | Onde | Esforço |
| --- | --- | --- | --- |
| 1 | ADR do WhatsApp não oficial (1.3) | aqui | 1 h |
| 2 | Agendador no backend, ponte como redundância (1.1) | `Financas` | meio dia |
| 3 | `ultimo_pulso_em` + aviso de ponte muda (1.2) | `Financas` | meio dia |
| 4 | `situacao.ps1` mostra o último pulso (2.3) | aqui | 2 h |
| 5 | Teste de `agente/caixa.ts` (2.1) | aqui | meio dia |
| 6 | Medir o custo do polling de 2s (2.2) | aqui | 2 h |
| 7 | Extrair a montagem de `index.ts` e testar (2.1) | aqui | 1 dia |
| 8 | Decidir a divergência do TypeScript 7 (3) | workspace | 1 h |

Os três primeiros somam pouco mais de um dia e tiram do sistema a única falha
que hoje é silenciosa **e** total.
