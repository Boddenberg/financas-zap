import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config";
import { MessageMonitor } from "./message-monitor";
import { StateStore } from "./state-store";
import type { OutboxMessage } from "./supabase-outbox-client";

/**
 * Cenário 12 do pedido: o envio falha, o Finanças fica sabendo, e a mensagem
 * volta a ser oferecida na leitura seguinte — sem duplicar a que já saiu.
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
    targetPhones: ["5511981090986"],
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-publica",
    bridgeToken: "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    financasApiUrl: "https://financas.example/api/v1",
    demoFormats: [],
    pollIntervalMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

// O cursor nasce no instante em que a ponte sobe, então a mensagem do teste
// precisa ser mais nova que ele — como qualquer mensagem de verdade seria.
function mensagem(): OutboxMessage {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    content: "☀️ Como foi o dia de ontem",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  };
}

const ID_DA_MENSAGEM = "11111111-1111-1111-1111-111111111111";

class OutboxFalsa {
  readonly confirmacoes: Array<{ id: string; entregue: boolean; erro?: string }> = [];
  pendentes: OutboxMessage[] = [mensagem()];

  async listMessagesSince(): Promise<OutboxMessage[]> {
    return this.pendentes;
  }

  async confirmDelivery(id: string, entregue: boolean, erro?: string): Promise<void> {
    this.confirmacoes.push({ id, entregue, erro });

    if (entregue) {
      this.pendentes = this.pendentes.filter((mensagem) => mensagem.id !== id);
    }
  }
}

function whatsappQue(falha: boolean) {
  const enviadas: string[] = [];
  return {
    enviadas,
    cliente: {
      on() {},
      off() {},
      async sendMessage(destino: string) {
        if (falha) {
          throw new Error("O WhatsApp recusou a mensagem durante o envio.");
        }
        enviadas.push(destino);
        return { id: { _serialized: "wa-1" }, ack: 1 };
      },
    },
  };
}

async function comEstado(
  corpo: (statePath: string) => Promise<void>,
): Promise<void> {
  const pasta = await mkdtemp(path.join(tmpdir(), "zap-teste-"));

  try {
    await corpo(path.join(pasta, "estado.json"));
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

const DESTINO = [
  { key: "phone:5511981090986", id: "5511981090986@c.us", description: "o número" },
];

test("uma falha de envio é registrada e a mensagem não é dada por entregue", async () => {
  await comEstado(async (statePath) => {
    const outbox = new OutboxFalsa();
    const { cliente } = whatsappQue(true);
    const store = new StateStore(statePath);
    const monitor = new MessageMonitor(
      cliente as never,
      outbox as never,
      DESTINO,
      store,
      config(statePath),
    );

    await assert.rejects(() => monitor.entregarPendentes());

    assert.deepEqual(outbox.confirmacoes, [
      {
        id: ID_DA_MENSAGEM,
        entregue: false,
        erro: "O WhatsApp recusou a mensagem durante o envio.",
      },
    ]);

    // O cursor não avançou: a mensagem continua pendente para a próxima volta.
    const estado = await store.loadOrCreate();
    assert.equal(estado.cursorIds.includes(ID_DA_MENSAGEM), false);
  });
});

test("na tentativa seguinte a mensagem sai e é confirmada uma vez só", async () => {
  await comEstado(async (statePath) => {
    const outbox = new OutboxFalsa();
    const store = new StateStore(statePath);
    const quebrado = whatsappQue(true);
    const inteiro = whatsappQue(false);

    await assert.rejects(() =>
      new MessageMonitor(
        quebrado.cliente as never,
        outbox as never,
        DESTINO,
        store,
        config(statePath),
      ).entregarPendentes(),
    );

    const enviadas = await new MessageMonitor(
      inteiro.cliente as never,
      outbox as never,
      DESTINO,
      store,
      config(statePath),
    ).entregarPendentes();

    assert.equal(enviadas, 1);
    assert.deepEqual(inteiro.enviadas, ["5511981090986@c.us"]);
    assert.deepEqual(
      outbox.confirmacoes.map((confirmacao) => confirmacao.entregue),
      [false, true],
    );

    // E uma terceira volta não repete o que já saiu.
    assert.equal(
      await new MessageMonitor(
        inteiro.cliente as never,
        outbox as never,
        DESTINO,
        store,
        config(statePath),
      ).entregarPendentes(),
      0,
    );
    assert.deepEqual(inteiro.enviadas, ["5511981090986@c.us"]);
  });
});
