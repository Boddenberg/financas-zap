# Convenções da ponte WhatsApp

## Responsabilidade

Este processo é uma ponte local e restrita. Ele lê somente a caixa de saída
dedicada no Supabase e entrega `mensagem` (com a arte, quando ela vem) no
WhatsApp. Não interpreta eventos da Casa, não monta texto e não recebe uma
credencial administrativa.

A ponte também **bate o relógio**: antes de cada leitura ela chama
`POST /casa/whatsapp/pulso` no Finanças. Isso não é exceção à regra acima — o
pulso não leva dado nenhum e não recebe conteúdo; ele só informa que o tempo
passou, porque o backend não tem agendador e sem essa batida nenhum resumo
periódico nasceria. Quem decide o que venceu continua sendo o backend.

## Fronteiras

- `supabase-outbox-client.ts` é a única porta para o Supabase.
- `backend-pulse.ts` é a única porta para a API do Finanças.
- `whatsapp-client.ts` é a única porta para `whatsapp-web.js`.
- `message-monitor.ts` coordena pulso, leitura, ordenação, entrega, confirmação
  e avanço do cursor.
- `state-store.ts` garante retomada e idempotência local.
- `single-instance.ts` impede duas pontes na mesma pasta.
- `log-file.ts` é o diário de quem roda sem tela; ele espelha o console e
  nunca é condição para entregar.
- `config.ts` valida toda entrada de ambiente antes de iniciar.
- `scripts/` é a instalação no Windows, e só isso: nada de regra de negócio ali.
- O contrato da leitura é a função `ler_mensagens_whatsapp_casa` e o da
  confirmação é `confirmar_mensagem_whatsapp_casa`, ambas criadas pelas
  migrations canônicas em `../Financas/supabase/migrations`.

Falhar no pulso nunca pode calar a entrega: mensagem que já está na caixa chega
mesmo com o backend fora do ar.

Tipos não tornam JSON externo confiável. Respostas do Supabase continuam entrando
como `unknown` e são validadas antes de virar `OutboxMessage`.

## Peso

Esta ponte mora no computador de casa, ligada o dia inteiro. Toda mudança que
acrescente processo, dependência, gravação frequente em disco ou trabalho a cada
ciclo precisa se justificar contra isso. O que já foi decidido: Chromium sem GPU
e com cache curto, um renderizador só, pulso a cada minuto, diário com teto e
prioridade abaixo do normal herdada da tarefa do Windows.

## Segurança

- Nunca registre o token, conteúdo de sessão ou destinatários completos.
- `.env`, `.wwebjs_auth`, `.wwebjs_cache` e `.runtime` são privados.
- Não consulte tabelas de domínio nem acrescente formatação à mensagem pronta.
- Uma falha parcial deve preservar destinos já confirmados para não duplicar
  mensagens na retomada.
- `whatsapp-web.js` é não oficial; mantenha a integração atrás do adaptador.

## Qualidade

Antes de concluir:

```powershell
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Separe mudanças em commits pequenos. Só configure ou publique um remote quando
o dono do projeto indicar explicitamente o destino.
