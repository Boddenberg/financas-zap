# Finanças Zap

Entregador local entre uma caixa de saída dedicada no Supabase e o WhatsApp.
Enquanto este processo estiver ligado, ele:

1. chama somente a função `ler_mensagens_whatsapp_casa` no Supabase;
2. recebe apenas `id`, `mensagem` pronta e `criada_em`;
3. repassa `mensagem` sem formatar, filtrar ou consultar dados da Casa;
4. entrega o texto para os números configurados ou para um grupo;
5. guarda a posição localmente para recuperar mensagens após um reinício sem
   repetir o que já foi confirmado pelo servidor do WhatsApp.

> `whatsapp-web.js` é uma integração não oficial. Use apenas para automação
> pessoal e de baixo volume. Mudanças no WhatsApp Web podem interromper o
> funcionamento e o uso automatizado está sujeito às regras do WhatsApp.

## Pré-requisitos

- Windows 10 ou 11;
- Node.js 20 ou mais recente;
- uma chave restrita da ponte, gerada no app Casa;
- um celular com WhatsApp para conectar a sessão local.

## Instalação

```powershell
npm install
Copy-Item .env.example .env
```

## Configuração

No app, abra **Casa > Ajustes > WhatsApp**, gere a chave e clique em
**Copiar configuração**. Use no `.env` a URL e a chave pública `anon` do mesmo
Supabase do Finanças, além da chave restrita da ponte:

```env
SUPABASE_URL="https://SEU-PROJETO.supabase.co"
SUPABASE_ANON_KEY="..."
FINANCAS_BRIDGE_TOKEN="casa_wpp_..."

WHATSAPP_RECIPIENTS="5511999999999,5511888888888"
WHATSAPP_GROUP_ID=""

POLL_INTERVAL_SECONDS="15"
HEADLESS="true"
```

Não configure e-mail, senha nem `SUPABASE_SERVICE_ROLE_KEY`. A chave `anon` é a
chave pública do projeto; a função do banco exige também a chave restrita da
ponte e retorna somente a caixa daquela residência. O banco guarda apenas o
hash dessa chave. Qualquer morador pode revogá-la ou rotacioná-la em
**Casa > Ajustes > WhatsApp**.

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
4. aguarde as mensagens de que o WhatsApp e a caixa do Supabase estão prontos.

Na estreia, o cursor nasce no horário da inicialização. O histórico antigo não
é enviado. A partir daí, `.runtime/casa-notifications.json` registra a posição
e as entregas parciais. Se a ponte ficar desligada, ela recupera as novas
mensagens assim que voltar.

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

- **Chave recusada:** gere uma nova em **Casa > Ajustes > WhatsApp**, copie a
  chave para `FINANCAS_BRIDGE_TOKEN` e reinicie a ponte.
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
