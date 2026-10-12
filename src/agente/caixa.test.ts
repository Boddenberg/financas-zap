import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config";
import { CaixaDoAgente } from "./caixa";

/**
 * A fila acumulada de 09/10 a 12/10/2026 travou a ponte: cinquenta cartões de
 * caçada com vídeo numa leitura só estouravam o tempo do banco a cada volta, e
 * nada mais saía. A leitura agora desce de lote até caber.
 */

const config = {
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon",
  agenteChave: "wpp_" + "x".repeat(40),
} as AppConfig;

function linha(id: string) {
  return { id, jid: "120363000000000000@g.us", mensagem: "oi", criada_em: "2026-10-12T18:00:00Z", anexos: [] };
}

test("a leitura desce de lote quando o banco estoura o tempo", async (t) => {
  const pedidos: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const limite = JSON.parse(init.body).p_limite as number;
    pedidos.push(limite);
    if (limite > 3) {
      return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500 });
    }
    return new Response(JSON.stringify([linha("a"), linha("b")]), { status: 200 });
  });

  const lidas = await new CaixaDoAgente(config).ler("2026-10-08T00:00:00Z", []);

  assert.deepEqual(pedidos, [50, 10, 3]);
  assert.deepEqual(lidas.map((m) => m.id), ["a", "b"]);
});

test("outro erro não vira lote menor", async (t) => {
  const pedidos: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    pedidos.push(JSON.parse(init.body).p_limite as number);
    return new Response(JSON.stringify({ message: "chave inválida" }), { status: 401 });
  });

  await assert.rejects(new CaixaDoAgente(config).ler("2026-10-08T00:00:00Z", []), /chave inválida/);
  assert.deepEqual(pedidos, [50]);
});
