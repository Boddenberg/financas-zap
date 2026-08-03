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
 * Duas garantias, e as duas vêm do canal ser uma conversa e não um aviso:
 *
 * 1. **o endereço não é montado aqui.** A resposta vai para o `jid` que veio da
 *    caixa — uma resposta de grupo termina em `@g.us`, e concatenar `@c.us` no
 *    telefone mandaria a conversa do casal para um número inexistente;
 * 2. **falhar no envio não perde a resposta.** Ela é devolvida como não
 *    entregue e volta na leitura seguinte.
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

function resposta(jid: string): MensagemDaCaixa {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    jid,
    texto: "Anotei a louça.",
    // Mais nova que o cursor, que nasce no instante em que a ponte sobe.
    criadaEm: new Date(Date.now() + 1_000).toISOString(),
    anexos: [],
  };
}

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
