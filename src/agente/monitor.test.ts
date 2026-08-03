import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client } from "whatsapp-web.js";
import type { AppConfig } from "../config";
import { StateStore } from "../state-store";
import type { CaixaDoAgente, MensagemDaCaixa } from "./caixa";
import type { EntradaDoAgente } from "./entrada";
import { MonitorDoAgente } from "./monitor";

/**
 * Quatro garantias, e todas vêm do canal ser uma conversa e não um aviso:
 *
 * 1. **o endereço não é montado aqui.** A resposta vai para o `jid` que veio da
 *    caixa — uma resposta de grupo termina em `@g.us`, e concatenar `@c.us` no
 *    telefone mandaria a conversa do casal para um número inexistente;
 * 2. **falhar no envio não perde a resposta.** Ela é confirmada como não
 *    entregue **e o cursor não passa por cima dela**, senão a leitura seguinte
 *    (que pede `criada_em > cursor`) nunca mais a traria;
 * 3. **documento não leva legenda.** O WhatsApp não exibe a legenda de um
 *    documento: mandar a frase ali é perdê-la, e a pessoa recebe três PDFs sem
 *    uma linha dizendo o que são;
 * 4. **imagem leva.** A arte da Casa continua chegando numa bolha só.
 */

function config(statePath: string): AppConfig {
  return {
    mode: "watch",
    testMessage: "teste",
    headless: true,
    authDataPath: ".auth",
    webCachePath: ".cache",
    statePath,
    lockPath: `${statePath}.lock`,
    targetPhones: [],
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-publica",
    bridgeToken: "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    agenteChave: "wpp_abcdefghijklmnopqrstuvwxyz0123456789",
    financasApiUrl: "https://financas.example/api/v1",
    demoFormats: [],
    pollIntervalMs: 15_000,
    agentePollAtivoMs: 2_000,
    agentePollParadoMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

function resposta(
  jid: string,
  anexos: MensagemDaCaixa["anexos"] = [],
  id = "22222222-2222-2222-2222-222222222222",
): MensagemDaCaixa {
  return {
    id,
    jid,
    texto: "Anotei a louça.",
    // Mais nova que o cursor, que nasce no instante em que a ponte sobe.
    criadaEm: new Date(Date.now() + 1_000).toISOString(),
    anexos,
  };
}

const PDF = {
  nome: "reserva.pdf",
  mime: "application/pdf",
  conteudoBase64: "JVBERi0=",
};
const PNG = { nome: "casa.png", mime: "image/png", conteudoBase64: "iVBORw0=" };

function caixaFalsa(mensagens: MensagemDaCaixa[]) {
  const confirmadas: Array<{ id: string; entregue: boolean }> = [];
  let entregou = false;
  const caixa = {
    async ler() {
      return entregou ? [] : mensagens;
    },
    async confirmar(id: string, entregue: boolean) {
      confirmadas.push({ id, entregue });
      entregou = true;
    },
  } as unknown as CaixaDoAgente;
  return { caixa, confirmadas };
}

/** Registra o que foi para o WhatsApp, na ordem. */
function clienteFalso() {
  const enviadas: Array<{ jid: string; tipo: string; legenda?: string }> = [];
  const client = {
    async sendMessage(jid: string, conteudo: unknown, opcoes?: { caption?: string }) {
      const media = conteudo as { mimetype?: string };
      enviadas.push({
        jid,
        tipo: typeof conteudo === "string" ? "texto" : (media.mimetype ?? "?"),
        legenda: opcoes?.caption,
      });
    },
  } as unknown as Client;
  return { client, enviadas };
}

const entradaFalsa = {
  async pulsar() {
    return { presas: 0, expiradas: 0 };
  },
} as unknown as EntradaDoAgente;

async function comPasta(corpo: (statePath: string) => Promise<void>): Promise<void> {
  const pasta = await mkdtemp(path.join(tmpdir(), "zap-agente-"));
  try {
    await corpo(path.join(pasta, "agente.json"));
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

test("a resposta vai para o jid que veio da caixa", async () => {
  await comPasta(async (statePath) => {
    const enviadas: string[] = [];
    const client = {
      async sendMessage(jid: string) {
        enviadas.push(jid);
      },
    } as unknown as Client;
    const { caixa, confirmadas } = caixaFalsa([resposta("120363411589990438@g.us")]);

    const monitor = new MonitorDoAgente(
      client,
      caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );
    const entregues = await monitor.bater();

    assert.equal(entregues, 1);
    assert.deepEqual(enviadas, ["120363411589990438@g.us"]);
    assert.deepEqual(confirmadas, [
      { id: "22222222-2222-2222-2222-222222222222", entregue: true },
    ]);
  });
});

test("envio que falha é confirmado como não entregue", async () => {
  await comPasta(async (statePath) => {
    const client = {
      async sendMessage() {
        throw new Error("o WhatsApp recusou");
      },
    } as unknown as Client;
    const { caixa, confirmadas } = caixaFalsa([resposta("5511946316274@c.us")]);

    const monitor = new MonitorDoAgente(
      client,
      caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );
    const entregues = await monitor.bater();

    assert.equal(entregues, 0);
    assert.equal(confirmadas[0]?.entregue, false);
  });
});

test("o cursor não passa por cima de uma resposta que não foi entregue", async () => {
  await comPasta(async (statePath) => {
    const client = {
      async sendMessage() {
        throw new Error("o WhatsApp recusou");
      },
    } as unknown as Client;
    const { caixa } = caixaFalsa([resposta("5511946316274@c.us")]);
    const store = new StateStore(statePath);
    const antes = await store.loadOrCreate();

    const monitor = new MonitorDoAgente(
      client,
      caixa,
      entradaFalsa,
      store,
      config(statePath),
    );
    await monitor.bater();

    const depois = await store.loadOrCreate();
    assert.equal(depois.cursorAt, antes.cursorAt, "o cursor não pode avançar");
    assert.deepEqual(depois.cursorIds, antes.cursorIds);
  });
});

test("uma falha segura a fila atrás dela em vez de furar a ordem", async () => {
  await comPasta(async (statePath) => {
    const { client, enviadas } = clienteFalso();
    let tentativas = 0;
    const quebrado = {
      async sendMessage(jid: string, conteudo: unknown, opcoes?: { caption?: string }) {
        tentativas += 1;
        if (tentativas === 1) {
          throw new Error("o WhatsApp recusou");
        }
        return client.sendMessage(jid, conteudo as string, opcoes);
      },
    } as unknown as Client;
    const { caixa } = caixaFalsa([
      resposta("5511946316274@c.us", [], "11111111-1111-1111-1111-111111111111"),
      resposta("5511946316274@c.us", [], "33333333-3333-3333-3333-333333333333"),
    ]);

    const monitor = new MonitorDoAgente(
      quebrado,
      caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );
    await monitor.bater();

    assert.deepEqual(enviadas, [], "a segunda resposta não pode passar na frente");
  });
});

test("o texto vai sozinho quando o anexo é documento", async () => {
  await comPasta(async (statePath) => {
    const { client, enviadas } = clienteFalso();
    const { caixa } = caixaFalsa([resposta("5511946316274@c.us", [PDF, PDF])]);

    const monitor = new MonitorDoAgente(
      client,
      caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );
    await monitor.bater();

    assert.deepEqual(
      enviadas.map((envio) => envio.tipo),
      ["texto", "application/pdf", "application/pdf"],
    );
    assert.equal(
      enviadas.every((envio) => envio.legenda === undefined),
      true,
      "o WhatsApp não exibe legenda de documento",
    );
  });
});

test("a imagem continua levando o texto na legenda", async () => {
  await comPasta(async (statePath) => {
    const { client, enviadas } = clienteFalso();
    const { caixa } = caixaFalsa([resposta("5511946316274@c.us", [PNG])]);

    const monitor = new MonitorDoAgente(
      client,
      caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );
    await monitor.bater();

    assert.deepEqual(enviadas, [
      { jid: "5511946316274@c.us", tipo: "image/png", legenda: "Anotei a louça." },
    ]);
  });
});

test("o laço acelera quando alguém está esperando resposta", async () => {
  await comPasta(async (statePath) => {
    const monitor = new MonitorDoAgente(
      {} as unknown as Client,
      caixaFalsa([]).caixa,
      entradaFalsa,
      new StateStore(statePath),
      config(statePath),
    );

    const parado = Reflect.get(monitor, "intervalo") as number;
    monitor.aguardarResposta();
    const ativo = Reflect.get(monitor, "intervalo") as number;

    assert.equal(parado, 15_000);
    assert.equal(ativo, 2_000);
  });
});
