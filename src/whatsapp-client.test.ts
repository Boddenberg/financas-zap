import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "whatsapp-web.js";
import type { AppConfig } from "./config";
import {
  createWhatsAppClient,
  resolveDestinations,
  sendAndWaitForServerAcknowledgement,
} from "./whatsapp-client";

function configWithPhones(...targetPhones: string[]): AppConfig {
  return {
    mode: "test-message",
    testMessage: "Teste",
    headless: true,
    authDataPath: ".wwebjs_auth",
    webCachePath: ".wwebjs_cache",
    statePath: ".state.json",
    lockPath: ".lock",
    targetPhones,
    demoFormats: [],
    pollIntervalMs: 15_000,
    timeZone: "America/Sao_Paulo",
  };
}

test("o Chromium sobe enxuto, sem apagar o que o Puppeteer já desliga", () => {
  const client = createWhatsAppClient({
    ...configWithPhones(),
    mode: "watch",
  }) as unknown as { options?: { puppeteer?: { args?: string[] } } };
  const args = client.options?.puppeteer?.args ?? [];

  assert.ok(args.includes("--renderer-process-limit=1"));
  assert.ok(args.includes("--disable-software-rasterizer"));

  // O Chromium fica com a última ocorrência de cada chave: um --disable-features
  // nosso substituiria a lista inteira que o Puppeteer monta.
  assert.deepEqual(
    args.filter((argument) => argument.startsWith("--disable-features")),
    [],
  );
});

test("usa o ID direto quando a consulta de número do WhatsApp falha", async () => {
  const client = {
    info: {
      wid: {
        server: "c.us",
        user: "5511981090986",
        _serialized: "5511981090986@c.us",
      },
    },
    getNumberId: async () => {
      throw new TypeError("WhatsApp Web não retornou o registro consultado");
    },
  } as unknown as Client;

  const destinations = await resolveDestinations(
    client,
    configWithPhones("5511981090986", "5511972435718"),
  );

  assert.deepEqual(
    destinations.map((destination) => destination.id),
    ["5511981090986@c.us", "5511972435718@c.us"],
  );
});

test("resolve o grupo pela coleção da página, sem pedir a metadados", async () => {
  const client = {
    info: { wid: { server: "c.us", user: "5511981090986" } },
    getChats: async () => {
      throw new Error("r");
    },
    getChatById: async () => {
      throw new Error("r");
    },
    pupPage: {
      evaluate: async () => [
        { id: "5511972435718@c.us", name: "Contato privado" },
        { id: "120363000000000000@g.us", name: "Casa" },
      ],
    },
  } as unknown as Client;

  const destinations = await resolveDestinations(client, {
    ...configWithPhones(),
    groupId: "120363000000000000@g.us",
  });

  assert.deepEqual(destinations, [
    {
      key: "group:120363000000000000@g.us",
      id: "120363000000000000@g.us",
      description: 'o grupo "Casa"',
    },
  ]);
});

test("avisa para reconferir o ID quando o grupo não está na conta conectada", async () => {
  const client = {
    info: { wid: { server: "c.us", user: "5511981090986" } },
    pupPage: {
      evaluate: async () => [{ id: "120363000000000000@g.us", name: "Casa" }],
    },
  } as unknown as Client;

  await assert.rejects(
    resolveDestinations(client, {
      ...configWithPhones(),
      groupId: "120363999999999999@g.us",
    }),
    /npm run list:groups/,
  );
});

test("aceita o envio quando a versão atual do WhatsApp não devolve a mensagem", async () => {
  let removedListener = false;
  const client = {
    on: () => undefined,
    off: () => {
      removedListener = true;
    },
    sendMessage: async () => undefined,
  } as unknown as Client;

  const acknowledgement = await sendAndWaitForServerAcknowledgement(
    client,
    "5511981090986@c.us",
    "Teste",
  );

  assert.equal(acknowledgement, "envio aceito pelo WhatsApp");
  assert.equal(removedListener, true);
});
