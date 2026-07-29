# Finanças Zap

Ponte local entre o app Casa e o WhatsApp. Enquanto este processo estiver
ligado, ele:

1. usa uma chave restrita gerada pelo próprio app Casa;
2. lê somente os novos registros da categoria de limpeza daquela residência;
3. não recebe fotos, observações nem outros dados do app;
4. envia um aviso para os números configurados ou para um grupo;
5. guarda a posição localmente para recuperar eventos após um reinício sem
   repetir o que já foi confirmado pelo servidor do WhatsApp.

> `whatsapp-web.js` é uma integração não oficial. Use apenas para automação
> pessoal e de baixo volume. Mudanças no WhatsApp Web podem interromper o
> funcionamento e o uso automatizado está sujeito às regras do WhatsApp.

## Pré-requisitos

- Windows 10 ou 11;
- Node.js 20 ou mais recente;
- uma conta já ativa no Finanças e no app Casa;
- um celular com WhatsApp para conectar a sessão local.

## Instalação

```powershell
npm install
Copy-Item .env.example .env
```

## Configuração

No app, abra **Casa > Ajustes > WhatsApp**, gere a chave e clique em
**Copiar configuração**. Cole as duas linhas no `.env`:

```env
FINANCAS_API_URL="https://SEU-BACKEND/api/v1"
FINANCAS_BRIDGE_TOKEN="casa_wpp_..."

WHATSAPP_RECIPIENTS="5511999999999,5511888888888"
WHATSAPP_GROUP_ID=""

POLL_INTERVAL_SECONDS="15"
HEADLESS="true"
```

A chave da ponte não é um login e não é uma credencial administrativa do
Supabase. O banco guarda somente o hash dela. Qualquer morador pode revogar ou
rotacionar a chave em **Casa > Ajustes > WhatsApp**; a chave anterior para de
funcionar imediatamente.

Em `WHATSAPP_RECIPIENTS`, separe os números por vírgula. O código também aceita
DDD + número e acrescenta o país configurado em `DEFAULT_COUNTRY_CODE` (55 por
padrão).

## Primeira execução

```powershell
npm run dev
```

Na primeira vez:

1. o terminal desenha um QR Code;
2. no celular, abra **WhatsApp > Aparelhos conectados > Conectar um aparelho**;
3. escaneie o QR Code;
4. aguarde as mensagens de que o WhatsApp e o Finanças estão prontos.

Na estreia, o cursor nasce no horário da inicialização. O histórico antigo não
é enviado. A partir daí, `.runtime/casa-notifications.json` registra a posição
e as entregas parciais. Se a ponte ficar desligada, ela recupera as novas
limpezas assim que voltar.

Mantenha o processo aberto para receber os avisos. Em operação compilada:

```powershell
npm run build
npm start
```

## Usar um grupo

Liste os grupos visíveis para a conta conectada:

```powershell
npm run list:groups
```

Copie o identificador terminado em `@g.us` para:

```env
WHATSAPP_GROUP_ID="120000000000000000@g.us"
```

Quando `WHATSAPP_GROUP_ID` está preenchido, o grupo substitui os números
privados; o aviso não é duplicado nos dois lugares.

## Testar os destinatários

Antes de deixar a ponte ligada, é possível enviar apenas `TEST_MESSAGE`:

```powershell
npm run test:message
```

O teste usa o mesmo grupo ou os mesmos números do monitor e encerra depois da
confirmação do servidor do WhatsApp.

## Validação

```powershell
npm test
npm run typecheck
npm run build
```

## Solução de problemas

- **Chave recusada:** gere uma nova em **Casa > Ajustes > WhatsApp**, copie as
  duas linhas novamente e reinicie a ponte.
- **Número não registrado:** use país + DDD + número e confirme que o contato
  possui WhatsApp.
- **Grupo não encontrado:** rode `npm run list:groups` novamente com a mesma
  conta conectada.
- **QR Code não apareceu:** aguarde o primeiro carregamento do Chromium e
  confira a conexão.
- **Sessão do WhatsApp corrompida:** encerre o processo, remova
  `.wwebjs_auth/` e `.wwebjs_cache/` e conecte novamente.
- **Estado local inválido:** preserve o arquivo para diagnóstico. Apagá-lo faz
  a ponte recomeçar no horário atual, sem recuperar o intervalo anterior.

## Arquivos privados

Não envie ao Git:

- `.env`, que contém a chave revogável da ponte;
- `.wwebjs_auth/`, que contém a sessão do WhatsApp;
- `.wwebjs_cache/`;
- `.runtime/`, que contém o cursor e as confirmações;
- `node_modules/`, `dist/` e logs.
