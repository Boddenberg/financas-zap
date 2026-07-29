import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "./config";
import { FinancasClient } from "./financas-client";

function config(): AppConfig {
  return {
    mode: "watch",
    testMessage: "teste",
    headless: true,
    authDataPath: ".auth",
    webCachePath: ".cache",
    statePath: ".state",
    targetPhones: ["5511981090986", "5511972435718"],
    financesApiUrl: "https://api.example.com/api/v1",
    financesBridgeToken:
      "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    pollIntervalMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

test("lê o feed restrito usando somente a chave da ponte", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(
      JSON.stringify({
        eventos: [
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            criado_por_nome: "Filipe",
            atividade_nome: "Limpar o fogão",
            ambiente_nome: "Cozinha",
            pontuacao_total: "3",
            compartilhada: false,
            salva_em: "2026-07-29T22:00:00Z",
          },
        ],
        tem_mais: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const events = await new FinancasClient(config()).listEventsSince(
      "2026-07-29T21:00:00Z",
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    );

    assert.match(requestedUrl, /casa\/ponte-whatsapp\/eventos/);
    assert.match(requestedUrl, /depois_de_id=aaaaaaaa-aaaa/);
    assert.equal(
      authorization,
      "Bearer casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    );
    assert.equal(events[0]?.actorName, "Filipe");
    assert.equal(events[0]?.points, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
