# Convenções da ponte WhatsApp

## Responsabilidade

Este processo é uma ponte local e restrita. Ele lê somente o feed de eventos
exposto pelo módulo Casa e entrega avisos no WhatsApp. Não é backend, não acessa
Supabase e não recebe uma credencial administrativa.

## Fronteiras

- `financas-client.ts` é a única porta para a API.
- `whatsapp-client.ts` é a única porta para `whatsapp-web.js`.
- `cleaning-monitor.ts` coordena leitura, ordenação, entrega e avanço do cursor.
- `state-store.ts` garante retomada e idempotência local.
- `config.ts` valida toda entrada de ambiente antes de iniciar.
- O contrato canônico da API é o OpenAPI exportado por `../Financas`.

Tipos não tornam JSON externo confiável. Respostas da API continuam entrando
como `unknown` e são validadas antes de virar `CleaningEvent`.

## Segurança

- Nunca registre o token, conteúdo de sessão ou destinatários completos.
- `.env`, `.wwebjs_auth`, `.wwebjs_cache` e `.runtime` são privados.
- Não amplie o feed da Casa com fotos, observações ou dados de outros módulos.
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

