import path from "node:path";
import qrcode from "qrcode-terminal";
import type { Client, Message } from "whatsapp-web.js";
import { CaixaDoAgente } from "./agente/caixa";
import { EntradaDoAgente, envelopeDe } from "./agente/entrada";
import { MonitorDoAgente } from "./agente/monitor";
import { BackendPulseClient } from "./backend-pulse";
import { ConfigError, loadConfig } from "./config";
import { mirrorConsoleToFile } from "./log-file";
import { MessageMonitor } from "./message-monitor";
import { claimSingleInstance } from "./single-instance";
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

/**
 * O canal de conversa: escuta o que chega e entrega o que o agente respondeu.
 *
 * A escuta e o laço são separados de propósito. Repassar é imediato — o backend
 * responde `202` e trabalha atrás —, e a resposta aparece na caixa segundos
 * depois, que é o que o laço busca. Segurar a conexão da ponte esperando o
 * agente pensar seria frágil num Wi-Fi de casa.
 */
async function ligarOAgente(
  client: Client,
  config: import("./config").AppConfig,
  sinal: AbortSignal,
): Promise<Promise<void>> {
  const caixa = new CaixaDoAgente(config);
  const entrada = new EntradaDoAgente(config);
  await caixa.conectar();

  const monitor = new MonitorDoAgente(
    client,
    caixa,
    entrada,
    // Cursor próprio: o do canal da Casa continua sendo só dele.
    new StateStore(path.resolve(process.cwd(), ".runtime/agente-whatsapp.json")),
    config,
  );

  client.on("message", (mensagem: Message) => {
    const envelope = envelopeDe(mensagem);
    if (!envelope) return;

    void entrada
      .entregar(envelope)
      .then((recibo) => {
        if (recibo.aceita && !recibo.duplicada) {
          monitor.aguardarResposta();
        }
      })
      .catch((erro: unknown) => {
        // Uma mensagem perdida aqui não pode derrubar a ponte: quem escreveu
        // reenvia, e o índice único do backend cuida da repetição.
        console.error(`Falha ao repassar a mensagem recebida: ${errorMessage(erro)}`);
      });
  });

  console.log("Canal de conversa do agente ligado.");
  return monitor.rodar(sinal);
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
  // Antes da configuração de propósito: subindo com o Windows não há tela, e um
  // .env recusado precisa deixar rastro tanto quanto uma entrega. Quem define o
  // caminho é o atalho da inicialização, não o .env — que a esta altura ainda
  // nem foi lido.
  mirrorConsoleToFile(process.env.LOG_PATH);

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

  // Antes de abrir o Chromium: uma segunda cópia usaria o mesmo perfil e a
  // mesma sessão, e o estrago aparece como mensagem repetida no celular de quem
  // mora aqui.
  let releaseSingleInstance: () => void;

  try {
    releaseSingleInstance = claimSingleInstance(config.lockPath);
  } catch (error) {
    console.error(errorMessage(error));
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
      for (const formato of config.demoFormats) {
        const rotulo = formato ?? "números inventados";
        console.log(`Pedindo ao Finanças a prévia de ${rotulo}...`);

        if (await pulse.requestDemo(formato)) {
          console.log(`Prévia de ${rotulo} enfileirada.`);
        } else {
          console.log(`O Finanças não enfileirou a prévia de ${rotulo}.`);
        }
      }

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

    // O canal de conversa é o segundo laço, e ele é opcional: sem
    // AGENTE_PONTE_CHAVE a ponte roda só os avisos da Casa, como sempre rodou.
    const agente = config.agenteChave
      ? await ligarOAgente(client, config, abortController.signal)
      : null;
    if (!agente) {
      console.log(
        "Canal de conversa desligado (sem AGENTE_PONTE_CHAVE). Só os avisos da Casa.",
      );
    }

    await Promise.all([
      monitor.run(abortController.signal),
      agente ?? Promise.resolve(),
    ]);

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

    releaseSingleInstance();
  }
}

void main();
