import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "./config";
import { SupabaseOutboxClient } from "./supabase-outbox-client";

function config(): AppConfig {
  return {
    mode: "watch",
    testMessage: "teste",
    headless: true,
    authDataPath: ".auth",
    webCachePath: ".cache",
    statePath: ".state",
    targetPhones: ["5511981090986", "5511972435718"],
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-publica",
    bridgeToken: "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    pollIntervalMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

test("lê somente a função da outbox e recebe a mensagem pronta", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let method = "";
  let apiKey = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    method = init?.method ?? "";
    apiKey = new Headers(init?.headers).get("apikey") ?? "";
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify([
        {
          id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          mensagem: "Texto final do Finanças",
          criada_em: "2026-07-29T22:00:00Z",
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const messages = await new SupabaseOutboxClient(config()).listMessagesSince(
      "2026-07-29T21:00:00Z",
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    );

    assert.equal(
      requestedUrl,
      "https://project.supabase.co/rest/v1/rpc/ler_mensagens_whatsapp_casa",
    );
    assert.equal(method, "POST");
    assert.equal(apiKey, "anon-publica");
    assert.equal(
      body.p_chave,
      "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    );
    assert.equal(
      body.p_depois_de_id,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    assert.deepEqual(messages, [
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        content: "Texto final do Finanças",
        createdAt: "2026-07-29T22:00:00Z",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
