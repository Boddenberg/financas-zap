import qrcode from "qrcode-terminal";
import { Client } from "whatsapp-web.js";
import { ConfigError, loadConfig } from "./config";
import { createWhatsAppClient, sendTestMessage } from "./whatsapp-client";

let client: Client | undefined;
let sendStarted = false;
let shuttingDown = false;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Erro desconhecido.";
}

async function shutdown(message: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(message);

  if (client) {
    try {
      await client.destroy();
    } catch {
      console.error("Não foi possível encerrar o cliente do WhatsApp de forma limpa.");
    }
  }

  process.exit(exitCode);
}

function connectedAccountDescription(whatsappClient: Client): string {
  const accountId = whatsappClient.info?.wid?._serialized;
  const pushName = whatsappClient.info?.pushname?.trim();

  if (pushName && accountId) {
    return `${pushName} (${accountId.replace("@c.us", "")})`;
  }

  if (accountId) {
    return accountId.replace("@c.us", "");
  }

  return "informação não disponível";
}

async function main(): Promise<void> {
  let config;

  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Erro de configuração: ${error.message}`);
    } else {
      console.error(`Falha ao carregar a configuração: ${errorMessage(error)}`);
    }

    process.exitCode = 1;
    return;
  }

  client = createWhatsAppClient(config);

  client.on("qr", (qr) => {
    console.log("\nQR Code recebido.");
    console.log("No WhatsApp, abra Aparelhos conectados > Conectar um aparelho e escaneie:\n");
    qrcode.generate(qr, { small: true });
    console.log("\nAguardando a leitura do QR Code...");
  });

  client.on("authenticated", () => {
    console.log("Autenticação realizada com sucesso. Preparando o cliente...");
  });

  client.on("auth_failure", () => {
    void shutdown(
      "Falha de autenticação. Se a sessão local estiver corrompida, apague .wwebjs_auth e tente novamente.",
      1,
    );
  });

  client.once("ready", () => {
    void (async () => {
      if (sendStarted) {
        return;
      }

      sendStarted = true;
      console.log("Cliente do WhatsApp pronto.");
      console.log(`Conta conectada: ${connectedAccountDescription(client as Client)}`);
      console.log("Enviando a mensagem de teste...");

      try {
        const result = await sendTestMessage(client as Client, config);
        console.log(`Mensagem de teste enviada com sucesso para ${result.destinationDescription}.`);
        await shutdown("Teste concluído. Encerrando o cliente do WhatsApp.", 0);
      } catch (error) {
        console.error(`Falha ao enviar a mensagem de teste: ${errorMessage(error)}`);
        await shutdown("Teste encerrado com erro.", 1);
      }
    })();
  });

  client.on("disconnected", (reason) => {
    void shutdown(`Sessão do WhatsApp desconectada (${String(reason)}).`, 1);
  });

  process.once("SIGINT", () => {
    void shutdown("\nInterrupção recebida. Encerrando o cliente do WhatsApp...", 130);
  });

  process.once("SIGTERM", () => {
    void shutdown("Solicitação de encerramento recebida.", 143);
  });

  process.once("uncaughtException", (error) => {
    console.error(`Erro inesperado: ${errorMessage(error)}`);
    void shutdown("Encerrando após erro inesperado.", 1);
  });

  process.once("unhandledRejection", (error) => {
    console.error(`Falha assíncrona inesperada: ${errorMessage(error)}`);
    void shutdown("Encerrando após erro inesperado.", 1);
  });

  console.log("Iniciando o cliente local do WhatsApp...");
  console.log(
    config.headless
      ? "Chromium em modo headless (sem janela visível)."
      : "Chromium com janela visível para diagnóstico.",
  );

  try {
    await client.initialize();
  } catch (error) {
    console.error(`Falha ao iniciar o cliente do WhatsApp: ${errorMessage(error)}`);
    await shutdown("Não foi possível iniciar o teste.", 1);
  }
}

void main();
