import assert from "node:assert/strict";
import test from "node:test";
import { BackendPulseClient } from "./backend-pulse";
import type { AppConfig } from "./config";

function config(): AppConfig {
  return {
    mode: "watch",
    testMessage: "teste",
    headless: true,
    authDataPath: ".auth",
    webCachePath: ".cache",
    statePath: ".state",
    targetPhones: ["5511981090986"],
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-publica",
    bridgeToken: "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    financasApiUrl: "https://financas.example/api/v1",
    pollIntervalMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

test("o pulso se identifica pela chave da ponte e não manda dado nenhum", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let chave = "";
  let corpo: string | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    chave = new Headers(init?.headers).get("X-Casa-Ponte") ?? "";
    corpo = init?.body === undefined ? undefined : String(init.body);
    return new Response(
      JSON.stringify({ enfileiradas: 2, tipos: ["resumo_diario", "bloco"] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const resultado = await new BackendPulseClient(config()).pulse();

    assert.equal(requestedUrl, "https://financas.example/api/v1/casa/whatsapp/pulso");
    assert.equal(chave, "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    assert.equal(corpo, undefined);
    assert.deepEqual(resultado, {
      queued: 2,
      kinds: ["resumo_diario", "bloco"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uma resposta estranha não vira mensagem inventada", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ enfileiradas: "duas", tipos: "bloco" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    assert.deepEqual(await new BackendPulseClient(config()).pulse(), {
      queued: 0,
      kinds: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("o backend fora do ar vira erro claro, para o ciclo seguir sem ele", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "Chave da ponte inválida ou revogada." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await assert.rejects(
      () => new BackendPulseClient(config()).pulse(),
      /Chave da ponte inválida ou revogada/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
