import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Client } from "whatsapp-web.js";
import type { AppConfig } from "./config";
import {
  createWhatsAppClient,
  protectEventAttachmentFromNavigation,
  protectReadyFromEarlySync,
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
    agentePollAtivoMs: 2_000,
    agentePollParadoMs: 15_000,
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

test("repete o registro dos eventos quando a página navega durante o ready", async () => {
  let attachments = 0;
  let waits = 0;
  let readinessChecks = 0;
  const client = {
    attachEventListeners: async () => {
      attachments += 1;
      if (attachments === 1) {
        const error = new Error(
          "Protocol error (Page.addScriptToEvaluateOnNewDocument): Target closed",
        );
        error.name = "TargetCloseError";
        throw error;
      }
    },
    pupPage: {
      waitForFunction: async () => {
        readinessChecks += 1;
      },
    },
  } as unknown as Client;

  protectEventAttachmentFromNavigation(client, async () => {
    waits += 1;
  });
  await (
    client as unknown as { attachEventListeners: () => Promise<void> }
  ).attachEventListeners();

  assert.equal(attachments, 2);
  assert.equal(waits, 1);
  assert.equal(readinessChecks, 1);
});

test("não repete uma falha real ao registrar os eventos", async () => {
  let attachments = 0;
  const client = {
    attachEventListeners: async () => {
      attachments += 1;
      throw new Error("módulo interno do WhatsApp não encontrado");
    },
  } as unknown as Client;

  protectEventAttachmentFromNavigation(client, async () => undefined);

  await assert.rejects(
    (
      client as unknown as { attachEventListeners: () => Promise<void> }
    ).attachEventListeners(),
    /módulo interno/,
  );
  assert.equal(attachments, 1);
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

/** Um cliente com a injeção e a página de mentira, e a folga sob controle do teste. */
function clienteSincronizado(sincronizou: boolean) {
  const chamadas: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    inject: async () => undefined,
    pupPage: {
      evaluate: async (expressao: string) => {
        chamadas.push(expressao.includes("onAppStateHasSyncedEvent()") ? "avisar" : "conferir");
        return sincronizou;
      },
    },
  });
  let soltar = (): void => undefined;
  const folga = new Promise<void>((resolve) => {
    soltar = resolve;
  });
  const avisos = console.warn;
  console.warn = () => undefined;
  protectReadyFromEarlySync(client as unknown as Client, () => folga);
  const terminar = async (): Promise<void> => {
    soltar();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    console.warn = avisos;
  };
  return { client, chamadas, terminar };
}

test("chama o aviso de sincronia que passou antes de a ponte ouvir", async () => {
  const { client, chamadas, terminar } = clienteSincronizado(true);

  await client.inject();
  await terminar();

  assert.deepEqual(chamadas, ["conferir", "avisar"]);
});

test("não chama o aviso quando ele chegou sozinho durante a folga", async () => {
  const { client, chamadas, terminar } = clienteSincronizado(true);

  await client.inject();
  client.emit("authenticated");
  await terminar();

  assert.deepEqual(chamadas, []);
  assert.equal(client.listenerCount("authenticated"), 0);
});

test("não chama o aviso enquanto o WhatsApp ainda não sincronizou", async () => {
  const { client, chamadas, terminar } = clienteSincronizado(false);

  await client.inject();
  await terminar();

  assert.deepEqual(chamadas, ["conferir"]);
});
