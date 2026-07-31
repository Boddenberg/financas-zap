import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigError,
  loadConfig,
  normalizeInternationalPhone,
} from "./config";

test("acrescenta o código do Brasil aos dois formatos locais configurados", () => {
  assert.equal(normalizeInternationalPhone("11 98109-0986"), "5511981090986");
  assert.equal(normalizeInternationalPhone("11972435718"), "5511972435718");
});

test("preserva um número que já está no formato internacional", () => {
  assert.equal(normalizeInternationalPhone("+55 11 98109-0986"), "5511981090986");
});

test("recusa números incompletos", () => {
  assert.throws(
    () => normalizeInternationalPhone("1234"),
    (error) => error instanceof ConfigError,
  );
});

const VARIAVEIS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "FINANCAS_BRIDGE_TOKEN",
  "FINANCAS_API_URL",
  "WHATSAPP_RECIPIENTS",
  "WHATSAPP_GROUP_ID",
] as const;

function comAmbiente(
  ajustes: Partial<Record<(typeof VARIAVEIS)[number], string>>,
  corpo: () => void,
): void {
  const previous = Object.fromEntries(
    VARIAVEIS.map((name) => [name, process.env[name]]),
  );
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-publica";
  process.env.FINANCAS_BRIDGE_TOKEN =
    "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  process.env.FINANCAS_API_URL = "https://financas.example/api/v1";
  process.env.WHATSAPP_RECIPIENTS = "11981090986";
  process.env.WHATSAPP_GROUP_ID = "";

  for (const [name, value] of Object.entries(ajustes)) {
    process.env[name] = value;
  }

  try {
    corpo();
  } finally {
    for (const name of VARIAVEIS) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("modo contínuo usa Supabase e chave restrita sem login pessoal", () => {
  comAmbiente({}, () => {
    const config = loadConfig([]);

    assert.equal(config.supabaseUrl, "https://project.supabase.co");
    assert.equal(config.supabaseAnonKey, "anon-publica");
    assert.match(config.bridgeToken ?? "", /^casa_wpp_/);
    assert.equal(config.financasApiUrl, "https://financas.example/api/v1");
    assert.equal("supabaseEmail" in config, false);
    assert.equal("supabasePassword" in config, false);
  });
});

test("sem o endereço do backend a ponte não sobe: ninguém bateria o relógio", () => {
  comAmbiente({ FINANCAS_API_URL: "" }, () => {
    assert.throws(
      () => loadConfig([]),
      (error) => error instanceof ConfigError,
    );
  });
});

test("sem argumento, a demonstração pede uma prévia de cada tipo", () => {
  comAmbiente({}, () => {
    assert.deepEqual(loadConfig(["--demo"]).demoFormats, [
      "bloco",
      "resumo_diario",
      "panorama_semanal",
      "panorama_mensal"
    ]);
  });
});

test("--demo=<tipo> pede só aquela prévia, e recusa um tipo que não existe", () => {
  comAmbiente({}, () => {
    assert.deepEqual(loadConfig(["--demo=panorama_mensal"]).demoFormats, [
      "panorama_mensal"
    ]);
    assert.deepEqual(loadConfig(["--demo=inventado"]).demoFormats, [undefined]);
    assert.throws(
      () => loadConfig(["--demo=semana_que_vem"]),
      (error) => error instanceof ConfigError
    );
  });
});
