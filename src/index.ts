import path from "node:path";
import qrcode from "qrcode-terminal";
import type { Client, Message } from "whatsapp-web.js";
import { CaixaDoAgente } from "./agente/caixa";
import {
  EntradaDoAgente,
  FalhaAoBaixarImagemWhatsapp,
  FalhasRecentesImagem,
  avisarImagemIndisponivel,
  conversaParaLog,
  envelopeDe,
  idDaMensagem,
  idDaMensagemParaLog,
} from "./agente/entrada";
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
): Promise<void> {
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
  const eventosRecentes = new Set<string>();
  const falhasDeImagem = new FalhasRecentesImagem();

  const repassar = async (mensagem: Message): Promise<void> => {
    // O `message_create` também dispara para o que o próprio agente acabou de
    // enviar. Isso não é descarte digno de nota — é o eco —, e registrá-lo
    // enchia o diário de uma linha por resposta entregue.
    if (mensagem.fromMe) return;

    const envelope = await envelopeDe(mensagem, client);
    if (!envelope) {
      // Vale uma linha: sem ela, "nada aconteceu" não distingue "o evento não
      // chegou" de "chegou e eu descartei", e as duas causas são muito
      // diferentes de investigar. O jid entra junto porque é ele que explica o
      // descarte mais provável — um LID que não virou telefone.
      console.log(
        `Mensagem ignorada pela ponte (${mensagem.author ?? mensagem.from ?? "origem desconhecida"}): própria conta, sem texto ou remetente irreconhecível.`,
      );
      return;
    }
    if (envelope.imagem) {
      falhasDeImagem.limpar(mensagem.from ?? "");
    }

    void entrada
      .entregar(envelope)
      .then((recibo) => {
        const desfecho = recibo.duplicada
          ? "já conhecida"
          : recibo.aceita
            ? "aceita"
            : `ignorada pelo Finanças${recibo.motivo ? ` (${recibo.motivo})` : ""}`;
        const conversaHash = conversaParaLog(envelope.grupo ?? envelope.de);
        const tipo = envelope.imagem ? "imagem" : envelope.audio ? "audio" : "texto";
        console.log(
          `whatsapp_entrada conversa_hash=${conversaHash} tipo=${tipo} resultado=${desfecho}`,
        );
        if (recibo.aceita && !recibo.duplicada) {
          monitor.aguardarResposta();
        }
      })
      .catch((erro: unknown) => {
        // Uma mensagem perdida aqui não pode derrubar a ponte: quem escreveu
        // reenvia, e o índice único do backend cuida da repetição.
        console.error(`Falha ao repassar a mensagem recebida: ${errorMessage(erro)}`);
      });
  };

  // Os dois eventos de propósito. Versões do `whatsapp-web.js` divergem em qual
  // deles dispara para uma conversa nova, e o custo de ouvir os dois é uma
  // requisição repetida que o índice único do backend descarta — enquanto o
  // custo de ouvir só o errado é a mensagem sumir sem deixar rastro.
  const ouvir = (mensagem: Message): void => {
    const waId = idDaMensagem(mensagem);
    if (eventosRecentes.has(waId)) return;
    eventosRecentes.add(waId);
    setTimeout(() => eventosRecentes.delete(waId), 60_000).unref();

    void repassar(mensagem).catch(async (erro: unknown) => {
      console.error(`Falha ao ler a mensagem recebida: ${errorMessage(erro)}`);
      if (erro instanceof FalhaAoBaixarImagemWhatsapp) {
        const chaveDaConversa = mensagem.from ?? "origem-desconhecida";
        const quantidade = falhasDeImagem.registrar(chaveDaConversa);
        try {
          await avisarImagemIndisponivel(client, mensagem, quantidade >= 2);
          console.log(
            `whatsapp_media_falha_repetida message_id=${idDaMensagemParaLog(mensagem)} conversa_hash=${conversaParaLog(chaveDaConversa)} quantidade=${quantidade}`,
          );
        } catch (falha: unknown) {
          console.error(
            `Falha ao avisar que a imagem não pôde ser baixada: ${errorMessage(falha)}`,
          );
        }
      }
    });
  };

  client.on("message", ouvir);
  client.on("message_create", ouvir);

  console.log("Canal de conversa do agente ligado.");
  return monitor.rodar(sinal);
}

function connectedAccountDescription(client: Client): string {
  const accountId = client.info?.wid?._serialized;
  const pushName = client.info?.pushname?.trim();
  const final = accountId?.replace("@c.us", "").slice(-4);

  if (pushName && final) {
    return `${pushName} (final ${final})`;
  }

  if (final) {
    return `conta final ${final}`;
  }

  return "informação não disponível";
}

/**
 * Quanto a ponte espera o WhatsApp ficar pronto antes de desistir e sair.
 *
 * O `whatsapp-web.js` não tem prazo: abre a página com `timeout: 0` e espera o
 * socket mudar de estado sem limite. Em 29/09/2026 (14:19 até 00:08) e de novo
 * em 30/09 às 09:25 a página carregou logada e o `ready` nunca veio — horas sem
 * entregar nada, com a tarefa "em execução". Sair deixa o `financas-zap.vbs`
 * subir uma ponte nova. O prazo é largo porque, com a máquina sem memória, só o
 * Node chegou a levar 2 minutos e meio para abrir. Enquanto um QR espera
 * alguém, o relógio para: sem a pessoa, reiniciar não resolve nada.
 */
const PRAZO_PARA_FICAR_PRONTA_MS = 8 * 60 * 1000;

/** Quanto se espera o Chrome fechar antes de sair mesmo assim. */
const PRAZO_PARA_FECHAR_MS = 30_000;

/**
 * Saída que o `financas-zap.vbs` não repete: `.env` recusado ou outra ponte
 * já de pé na mesma pasta. Qualquer outra saída com erro ele repete.
 */
const SAIDA_SEM_REPETIR = 2;

async function waitUntilReady(client: Client, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let prazo: NodeJS.Timeout | undefined;
    const armarPrazo = (): void => {
      clearTimeout(prazo);
      prazo = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `O WhatsApp não ficou pronto em ${PRAZO_PARA_FICAR_PRONTA_MS / 60_000} minutos.`,
          ),
        );
      }, PRAZO_PARA_FICAR_PRONTA_MS);
    };
    const esperandoQr = (): void => clearTimeout(prazo);
    const cleanup = (): void => {
      clearTimeout(prazo);
      client.off("ready", ready);
      client.off("auth_failure", authFailure);
      client.off("disconnected", disconnected);
      client.off("qr", esperandoQr);
      client.off("authenticated", armarPrazo);
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
    client.on("qr", esperandoQr);
    client.on("authenticated", armarPrazo);
    signal.addEventListener("abort", aborted, { once: true });
    armarPrazo();
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
    process.exitCode = SAIDA_SEM_REPETIR;
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
    process.exitCode = SAIDA_SEM_REPETIR;
    return;
  }

  const abortController = new AbortController();
  const client = createWhatsAppClient(config);
  const stateStore = new StateStore(config.statePath);
  let disconnectedReason: unknown;
  // O Chrome fechou ou a página do WhatsApp caiu depois de pronta. Sem isto os
  // laços seguiam lendo a caixa sem ter por onde entregar.
  let quedaDoNavegador: string | undefined;

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
    const caiu = (motivo: string): void => {
      quedaDoNavegador ??= motivo;
      stop(motivo);
    };
    client.pupBrowser?.once("disconnected", () => caiu("O Chrome do WhatsApp fechou."));
    client.pupPage?.once("error", (erro) =>
      caiu(`A página do WhatsApp caiu (${errorMessage(erro)}).`),
    );

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
      ? ligarOAgente(client, config, abortController.signal)
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
    if (quedaDoNavegador) {
      throw new Error(quedaDoNavegador);
    }
  } catch (error) {
    if (
      !abortController.signal.aborted ||
      disconnectedReason !== undefined ||
      quedaDoNavegador
    ) {
      console.error(`Finanças Zap encerrado com erro: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
    // Quando um laço cai, o outro ainda roda. Sem parar os dois sobrava um
    // processo sem WhatsApp, e a tarefa do Windows o via "em execução".
    abortController.abort();
  } finally {
    try {
      await comPrazo(client.destroy(), PRAZO_PARA_FECHAR_MS);
    } catch {
      console.error("Não foi possível encerrar o cliente do WhatsApp de forma limpa.");
      // Um Chrome esquecido segura o perfil, e a próxima ponte não abriria.
      client.pupBrowser?.process()?.kill();
    }

    releaseSingleInstance();
  }
}

async function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let relogio: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, reject) => {
        relogio = setTimeout(() => reject(new Error("Prazo esgotado.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(relogio);
  }
}

// Sair sempre, e com o código certo: é o `financas-zap.vbs` quem sobe a ponte
// de novo, e ele só sabe que ela caiu quando o processo termina.
void main()
  .catch((error: unknown) => {
    console.error(`Finanças Zap encerrado com erro: ${errorMessage(error)}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
