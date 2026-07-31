# Convenções da ponte WhatsApp

## Responsabilidade

Este processo é uma ponte local e restrita. Ele lê somente a caixa de saída
dedicada no Supabase e entrega o campo `mensagem` no WhatsApp. Não interpreta
eventos da Casa, não monta texto e não recebe uma credencial administrativa.

## Fronteiras

- `supabase-outbox-client.ts` é a única porta para o Supabase.
- `whatsapp-client.ts` é a única porta para `whatsapp-web.js`.
- `message-monitor.ts` coordena leitura, ordenação, entrega e avanço do cursor.
- `state-store.ts` garante retomada e idempotência local.
- `config.ts` valida toda entrada de ambiente antes de iniciar.
- O contrato da leitura é a função `ler_mensagens_whatsapp_casa`, criada pela
  migration canônica em `../Financas/supabase/migrations`.

Tipos não tornam JSON externo confiável. Respostas do Supabase continuam entrando
como `unknown` e são validadas antes de virar `OutboxMessage`.

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
