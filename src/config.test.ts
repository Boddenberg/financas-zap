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

test("modo contínuo usa Supabase e chave restrita sem login pessoal", () => {
  const variables = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "FINANCAS_BRIDGE_TOKEN",
    "WHATSAPP_RECIPIENTS",
    "WHATSAPP_GROUP_ID",
  ] as const;
  const previous = Object.fromEntries(
    variables.map((name) => [name, process.env[name]]),
  );
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-publica";
  process.env.FINANCAS_BRIDGE_TOKEN =
    "casa_wpp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  process.env.WHATSAPP_RECIPIENTS = "11981090986";
  process.env.WHATSAPP_GROUP_ID = "";

  try {
    const config = loadConfig([]);

    assert.equal(config.supabaseUrl, "https://project.supabase.co");
    assert.equal(config.supabaseAnonKey, "anon-publica");
    assert.match(config.bridgeToken ?? "", /^casa_wpp_/);
    assert.equal("supabaseEmail" in config, false);
    assert.equal("supabasePassword" in config, false);
  } finally {
    for (const name of variables) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
