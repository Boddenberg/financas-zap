import qrcode from "qrcode-terminal";
import type { Client } from "whatsapp-web.js";
import { BackendPulseClient } from "./backend-pulse";
import { ConfigError, loadConfig } from "./config";
import { MessageMonitor } from "./message-monitor";
import { StateStore } from "./state-store";
import { SupabaseOutboxClient } from "./supabase-outbox-client";
import {
  createWhatsAppClient,
  listGroups,
  resolveDestinations,
  sendTestMessage,
} from "./whatsapp-client";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Erro desconhecido.";
}

function connectedAccountDescription(client: Client): string {
  const accountId = client.info?.wid?._serialized;
  const pushName = client.info?.pushname?.trim();

  if (pushName && accountId) {
    return `${pushName} (${accountId.replace("@c.us", "")})`;
  }

  if (accountId) {
    return accountId.replace("@c.us", "");
  }

  return "informação não disponível";
}

async function waitUntilReady(client: Client, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.off("ready", ready);
      client.off("auth_failure", authFailure);
      client.off("disconnected", disconnected);
      signal.removeEventListener("abort", aborted);
    };
    const ready = (): void => {
      cleanup();
      resolve();
    };
    const authFailure = (): void => {
      cleanup();
      reject(
        new Error(
          "Falha de autenticação. Se a sessão estiver corrompida, remova .wwebjs_auth e tente novamente.",
        ),
      );
    };
    const disconnected = (reason: unknown): void => {
      cleanup();
      reject(new Error(`Sessão do WhatsApp desconectada (${String(reason)}).`));
    };
    const aborted = (): void => {
      cleanup();
      reject(new Error("Inicialização interrompida."));
    };

    client.once("ready", ready);
    client.once("auth_failure", authFailure);
    client.once("disconnected", disconnected);
    signal.addEventListener("abort", aborted, { once: true });
    void client.initialize().catch((error: unknown) => {
      cleanup();
      reject(error);
    });
  });
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

  const abortController = new AbortController();
  const client = createWhatsAppClient(config);
  const stateStore = new StateStore(config.statePath);
  let disconnectedReason: unknown;

  const stop = (message: string): void => {
    if (!abortController.signal.aborted) {
      console.log(message);
      abortController.abort();
    }
  };

  process.once("SIGINT", () => stop("\nInterrupção recebida. Encerrando..."));
  process.once("SIGTERM", () => stop("Solicitação de encerramento recebida."));
  client.on("disconnected", (reason) => {
    disconnectedReason = reason;
    stop(`Sessão do WhatsApp desconectada (${String(reason)}).`);
  });
  client.on("qr", (qr) => {
    console.log("\nQR Code recebido.");
    console.log("No WhatsApp, abra Aparelhos conectados > Conectar um aparelho:\n");
    qrcode.generate(qr, { small: true });
    console.log("\nAguardando a leitura do QR Code...");
  });
  client.once("authenticated", () => {
    console.log("Autenticação do WhatsApp realizada. Preparando o cliente...");
  });

  console.log("Iniciando o cliente local do WhatsApp...");
  console.log(
    config.headless
      ? "Chromium em modo headless (sem janela visível)."
      : "Chromium com janela visível para diagnóstico.",
  );

  try {
    if (config.mode === "watch") {
      // O marco nasce antes do QR/login para não abrir uma janela sem monitoramento
      // durante a primeira inicialização, que pode levar alguns minutos.
      await stateStore.loadOrCreate();
    }
    await waitUntilReady(client, abortController.signal);
    console.log(`WhatsApp pronto: ${connectedAccountDescription(client)}.`);

    if (config.mode === "list-groups") {
      await listGroups(client);
      return;
    }

    if (config.mode === "test-message") {
      await sendTestMessage(client, config);
      return;
    }

    const outbox = new SupabaseOutboxClient(config);
    console.log("Validando o acesso restrito à caixa do WhatsApp no Supabase...");
    await outbox.connect();
    const pulse = new BackendPulseClient(config);
    const destinations = await resolveDestinations(client, config);
    console.log(
      `Destino dos avisos: ${destinations
        .map((destination) => destination.description)
        .join(" e ")}.`,
    );

    if (config.mode === "demo") {
      console.log("Pedindo ao Finanças uma mensagem de demonstração...");
      const enfileirada = await pulse.requestDemo();

      if (!enfileirada) {
        throw new Error("O Finanças não enfileirou a demonstração.");
      }

      console.log("Demonstração enfileirada. Entregando...");
      const monitorDemo = new MessageMonitor(
        client,
        outbox,
        destinations,
        stateStore,
        config,
      );
      await monitorDemo.entregarPendentes();
      return;
    }

    const monitor = new MessageMonitor(
      client,
      outbox,
      destinations,
      stateStore,
      config,
      pulse,
    );
    await monitor.run(abortController.signal);

    if (disconnectedReason !== undefined) {
      throw new Error(
        `A sessão do WhatsApp foi desconectada (${String(disconnectedReason)}).`,
      );
    }
  } catch (error) {
    if (!abortController.signal.aborted || disconnectedReason !== undefined) {
      console.error(`Finanças Zap encerrado com erro: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      await client.destroy();
    } catch {
      console.error("Não foi possível encerrar o cliente do WhatsApp de forma limpa.");
    }
  }
}

void main();
