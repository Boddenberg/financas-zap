# Finanças Zap

Aplicação local mínima para conectar uma conta comum ao WhatsApp Web, exibir o QR Code no terminal e enviar uma única mensagem de teste. Ela não possui servidor, página web, banco de dados, integração com o projeto principal ou processamento de mensagens recebidas.

> **Aviso:** `whatsapp-web.js` é uma integração não oficial. Use este projeto apenas para testes pessoais e de baixo volume. Mudanças no WhatsApp Web podem interromper o funcionamento, e uso automatizado pode estar sujeito às regras do WhatsApp.

## Pré-requisitos

- Windows 10 ou 11;
- Node.js LTS 20 ou mais recente;
- npm (instalado junto com o Node.js);
- celular com WhatsApp e acesso à internet;
- computador conectado à internet.

Confira a instalação no terminal:

```powershell
node --version
npm --version
```

## Instalação

Abra o terminal na pasta `Financas-zap` e instale as dependências:

```powershell
npm install
```

O pacote do Puppeteer baixa uma versão compatível do Chromium. Por isso, a primeira instalação pode levar alguns minutos.

## Configuração

No PowerShell, copie o exemplo:

```powershell
Copy-Item .env.example .env
```

No Prompt de Comando (`cmd`), use:

```bat
copy .env.example .env
```

Para enviar o primeiro `Oi` à própria conta conectada, deixe o `.env` assim:

```env
TEST_MESSAGE=Oi
SEND_TO_SELF=true
TARGET_PHONE=
HEADLESS=true
```

Para enviar a outro número:

```env
TEST_MESSAGE=Oi
SEND_TO_SELF=false
TARGET_PHONE=5511999999999
HEADLESS=true
```

Substitua o exemplo por um número real com código do país, DDD e número, somente com dígitos. Não inclua o `+`, espaços, parênteses, hífens, zero de longa distância ou código da operadora. O aplicativo também tolera esses separadores e os remove, mas salvar apenas os dígitos evita dúvidas.

## Primeira execução

Execute:

```powershell
npm run dev
```

Na primeira vez:

1. O terminal mostrará `QR Code recebido` e desenhará o código.
2. No celular, abra o WhatsApp.
3. Acesse **Configurações/Menu > Aparelhos conectados > Conectar um aparelho**.
4. Escaneie o QR Code exibido no terminal.
5. Aguarde as mensagens `Autenticação realizada com sucesso`, `Cliente do WhatsApp pronto` e `Conta conectada`.
6. O aplicativo enviará a mensagem configurada uma única vez e mostrará `Mensagem de teste enviada com sucesso`.
7. Depois do envio, o cliente será encerrado automaticamente.

Abra a conversa de destino no WhatsApp e confirme que o `Oi` apareceu. Quando `SEND_TO_SELF=true`, procure a conversa com você mesmo. Se a sua conta ou versão do WhatsApp não aceitar o envio para o próprio identificador, configure `SEND_TO_SELF=false` e use em `TARGET_PHONE` outro número que esteja registrado no WhatsApp.

O QR Code expira por segurança. Se isso acontecer, aguarde: o programa exibirá um novo código.

## Próximas execuções

A autenticação fica salva em `.wwebjs_auth/`, e o cache do WhatsApp Web fica em `.wwebjs_cache/`. Execute novamente:

```powershell
npm run dev
```

Se a sessão ainda for válida, o cliente será restaurado sem pedir outro QR Code. Cada nova execução envia uma mensagem de teste; a proteção contra duplicidade vale dentro de cada execução.

## Compilar e executar sem o IntelliJ

Valide os tipos e compile:

```powershell
npm run typecheck
npm run build
```

Execute a versão compilada:

```powershell
npm start
```

Não é necessário deixar o IntelliJ aberto. Depois de compilar, qualquer terminal ou outro processo pode executar `npm start` nessa pasta. Configuração permanente em segundo plano não faz parte desta primeira versão.

## Conectar outra conta

Primeiro encerre o programa com `Ctrl+C`. Depois, na pasta do projeto, apague a sessão e o cache:

```powershell
Remove-Item -Recurse -Force .wwebjs_auth, .wwebjs_cache
```

Se uma das pastas ainda não existir, o PowerShell poderá mostrar um aviso inofensivo. Na próxima execução de `npm run dev`, um novo QR Code será exibido.

## Solução de problemas

- **O QR Code não apareceu:** aguarde o primeiro carregamento do Chromium. Confira sua conexão e tente novamente.
- **Falha ao iniciar o Chromium:** execute `npm install` novamente. Para diagnóstico, altere temporariamente `HEADLESS=false` e rode `npm run dev`.
- **Falha de autenticação:** encerre o programa, apague `.wwebjs_auth/` e `.wwebjs_cache/` e escaneie um novo QR Code.
- **Número não registrado:** confirme `SEND_TO_SELF=false`, o código do país, o DDD e se o número possui WhatsApp.
- **Sessão desconectada:** confira em **Aparelhos conectados** no celular. Se necessário, remova a sessão local e conecte outra vez.
- **O terminal parece travado:** ele pode estar aguardando o QR Code ser lido. Use `Ctrl+C` para encerrar com segurança.

## Arquivos privados e Git

Nunca envie ao GitHub:

- `.env`, que contém sua configuração local;
- `.wwebjs_auth/`, que contém a sessão autenticada;
- `.wwebjs_cache/`, que contém o cache local;
- `node_modules/`, `dist/` e arquivos `*.log`.

Esses caminhos já estão no `.gitignore`. O arquivo `.env.example` pode ser versionado porque contém apenas exemplos, sem números ou credenciais reais.
