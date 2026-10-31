# CLAUDE.md

## Projeto
- **O que é:** Finanças Zap, a ponte local do WhatsApp: roda no PC de casa (Windows), entrega no WhatsApp o que o FiNanças põe nas duas caixas do Supabase (a da Casa e a caixa geral do agente), repassa ao backend o que chega e bate o relógio (os pulsos) do hub.
- **Stack:** Node 24 + TypeScript 7 (`tsc` nativo); `whatsapp-web.js` 1.34.7 (Puppeteer com o Chrome do PC); Supabase por REST/RPC com chave restrita; API do FiNanças por `fetch`; testes `node:test` via `tsx`; tarefa do Windows em PowerShell + VBScript.
- **Rodar testes:** `npm test` (tudo de uma vez: `npm run verificar` = test + typecheck + build + auditar; na nuvem, `npm ci` com `PUPPETEER_SKIP_DOWNLOAD=1`)
- **Checar tipos:** `npm run typecheck` (o audit com as exceções escritas: `npm run auditar`)
- **Deploy:** não há deploy automático nem DEV/HOM: é uma ponte só, no PC de casa, ligada à produção do FiNanças. A branch de trabalho sai da `main`; juntar na `main` não muda nada no PC. Quem atualiza é o dono, no PC: `npm run windows:atualizar` (para a tarefa, `git pull --ff-only`, `npm ci`, `npm run build`, inicia a tarefa) e confere com `npm run windows:situacao` e `npm run test:message`. A subida grava no diário o commit que está rodando (`dist/versao.json`).
- **Pastas principais:** `src/index.ts` (processo, trava, QR, os dois laços), `src/whatsapp-client.ts` (a única porta para o `whatsapp-web.js`), canal da Casa em `src/{message-monitor,supabase-outbox-client,backend-pulse}.ts`, canal do agente em `src/agente/` (`caixa`, `monitor`, `entrada`), `src/{state-store,single-instance,log-file,config}.ts`, `scripts/` (Windows e o remendo do `postinstall`), `.github/` (CI e `auditar.mjs`), `docs/`.
- **Spec e pronto:** ainda não há `docs/specs/` nem `docs/pronto.md` aqui; pronto = `npm run verificar` verde e a conferência no PC anotada para o dono.
- **Cuidados:** leia o `AGENTS.md`. Nada roda no PC a partir da nuvem: só código e testes. `.env`, `.wwebjs_auth` (a sessão do chip), `.wwebjs_cache` e `.runtime` são privados. A ponte não formata nem interpreta mensagem; telefone nunca inteiro no diário (hash). Exceção de audit só em `.github/auditar.mjs`, com o motivo. O remendo em `node_modules` (`scripts/corrigir-wwebjs-midia.mjs`) tem teste (`src/remendos.test.ts`). Arquivos em LF; `.ps1`, `.vbs`, `.bat` e `.cmd` saem em CRLF no checkout (`.gitattributes`).

---

# Regras de trabalho (v2)

O objetivo é gastar pouco contexto sem perder qualidade.

## 1. Início de sessão
- Seção "Projeto" com campos `<...>`: preencha antes de começar (package.json, README, pastas, workflows) e inclua no primeiro commit.
- Outro repositório: leia o CLAUDE.md dele antes de mexer (sem um, crie a partir deste).
- Nome de ambiente, jogo ou "Quinteto" no pedido: traduza pelo glossário (DEV, HOM, PROD; Quinteto do PC, do celular ou do hub).
- Spec, `TAREFAS.md` e `HANDOFF.md`: retome só se o pedido for sobre eles.
- Não explore o repositório inteiro: use a seção "Projeto", o índice dos docs e o README da área.

## 2. Do áudio ao trabalho
1. Cole o trecho do áudio (até 5 linhas) no topo de uma spec em `docs/specs/` (o modelo e a lista de pronto estão linkados na seção "Projeto").
2. Junte todas as dúvidas numa pergunta só, no começo. Termo fora do glossário é dúvida.
3. Um item por comportamento, com etiqueta de área. Ordem: balanço, núcleo, servidor, tela, arte, textos e novidades.
4. Lista grande: blocos de até 15 itens da mesma área; um subagente por bloco, um bloco por vez. Ele recebe a spec e os arquivos da área, roda tipos e testes uma vez, faz um commit e devolve um resumo curto. A sessão principal só coordena.
5. Pronto = a lista de pronto do repositório. Decisão que vale além da spec vira ADR em `docs/decisoes/`.
6. O `TAREFAS.md` da raiz é só um índice: uma linha por spec aberta.

## 3. Handoff
- Uma sessão = um assunto. Ao terminar um assunto, ou com a conversa longa (muitos arquivos, várias imagens, ~1h), avise: "Bom ponto para handoff + /clear."
- "handoff" (ou `/handoff`): atualize a seção "Handoff" da spec (até 10 linhas: estado, próximo passo, armadilha). Sem spec, escreva o `HANDOFF.md` (até 60 linhas: objetivo, feito, decisões, estado, próximos passos, armadilhas). Depois responda só: "Handoff salvo — pode dar /clear."

## 4. Branches e publicação
- A branch de trabalho sai da branch do DEV (veja "Deploy") e se chama `claude/<area>-<assunto>`, sem sufixo de ambiente.
- Nunca push direto em `main` ou `hom`. Nunca cherry-pick: é sempre merge.
- Promover só com a frase do dono ("sobe pro DEV", "promove pro HOM", "pode ir pra PROD"). Onde juntar na `main` publica (hub, Quinteto, Expo, web), juntar é do dono.
- Deploy uma vez por bloco ou no fim, nunca a cada item.

## 5. Subagentes e paralelismo
- Fora de listas grandes, faça na própria sessão.
- No máximo 2 frentes em paralelo, em áreas que não se tocam. Quem divide um arquivo gigante fica com ele só para si.
- "Duas opções pra escolher": entregue os dois planos em texto e implemente só a escolhida.

## 6. Nuvem e orquestração
- Nunca monte um orquestrador com várias sessões na nuvem.
- Nunca crie lembretes recorrentes para "acordar e checar frentes".
- Para acompanhar deploy ou CI: um único lembrete curto que confere o status e avisa.

## 7. Mídia, saídas grandes e comentários
- Vídeo: 3–4 frames-chave. Sprites e GIFs: um script gera os arquivos; olhe só o resultado final.
- Interface: leia texto/DOM; prints só no QA final.
- Logs, listas e saídas de teste: filtre com `grep`, `tail`, `head`.
- Comentário diz o quê e por quê em 1–2 linhas, sem data e sem citação; a história vai no commit ou na ADR.
