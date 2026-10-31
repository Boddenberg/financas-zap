import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advanceCursor,
  inicioDaLeitura,
  isAfterCursor,
  jaEntregue,
  marcarEntregue,
  StateStore,
  type BridgeState,
} from "./state-store";

test("o primeiro início cria um cursor no presente sem importar o histórico", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  const now = new Date("2026-07-29T21:00:00.000Z");
  const state = await new StateStore(filePath).loadOrCreate(now);

  assert.equal(state.cursorAt, now.toISOString());
  assert.deepEqual(state.cursorIds, []);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 1);
});

test("o cursor distingue registros salvos no mesmo instante", () => {
  const state: BridgeState = {
    version: 1,
    cursorAt: "2026-07-29T21:00:00.000Z",
    cursorIds: ["registro-1"],
    deliveredDestinations: {},
  };

  assert.equal(
    isAfterCursor(state, {
      id: "registro-1",
      createdAt: "2026-07-29T21:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    isAfterCursor(state, {
      id: "registro-2",
      createdAt: "2026-07-29T21:00:00.000Z",
    }),
    true,
  );

  advanceCursor(state, {
    id: "registro-2",
    createdAt: "2026-07-29T21:00:00.000Z",
  });
  assert.deepEqual(state.cursorIds, ["registro-1", "registro-2"]);
});

test("um estado truncado vai para o lado e a ponte recomeça sozinha", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  await writeFile(filePath, '{"version":1,"cursorAt":"2026-07-', "utf8");
  const now = new Date("2026-10-31T12:00:00.000Z");
  const erros: unknown[] = [];
  const original = console.error;
  console.error = (...partes: unknown[]) => void erros.push(partes);

  try {
    const state = await new StateStore(filePath).loadOrCreate(now);

    assert.equal(state.cursorAt, now.toISOString());
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), state);
    const guardado = path.join(directory, "state.json.corrompido-2026-10-31T12-00-00-000Z");
    assert.equal(await readFile(guardado, "utf8"), '{"version":1,"cursorAt":"2026-07-');
    assert.equal(erros.length, 1);
  } finally {
    console.error = original;
  }
});

test("um estado de outro formato também recomeça, sem derrubar a ponte", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  await writeFile(filePath, '{"version":9}', "utf8");
  const original = console.error;
  console.error = () => {};

  try {
    const state = await new StateStore(filePath).loadOrCreate(new Date("2026-10-31T12:00:00.000Z"));

    assert.equal(state.version, 1);
    assert.ok((await readdir(directory)).some((nome) => nome.startsWith("state.json.corrompido-")));
  } finally {
    console.error = original;
  }
});

test("a gravação troca o arquivo inteiro e não deixa o temporário para trás", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  const store = new StateStore(filePath);
  const state = await store.loadOrCreate(new Date("2026-10-31T12:00:00.000Z"));

  state.cursorIds = ["registro-1"];
  await store.save(state);

  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).cursorIds, ["registro-1"]);
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("o rename preso pelo antivírus (EPERM) é tentado de novo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  let chamadas = 0;
  const store = new StateStore(filePath, {
    renomear: async (de, para) => {
      chamadas += 1;
      if (chamadas === 1) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      await rename(de, para);
    },
  });

  const state = await store.loadOrCreate(new Date("2026-10-31T12:00:00.000Z"));

  assert.equal(chamadas, 2);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), state);
});

test("um rename que falha por outro motivo não é repetido", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  let chamadas = 0;
  const store = new StateStore(path.join(directory, "state.json"), {
    renomear: async () => {
      chamadas += 1;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
  });

  await assert.rejects(store.loadOrCreate(), /no space left/);
  assert.equal(chamadas, 1);
});

test("as entregas anotadas somem 48 h atrás do cursor e sobrevivem à gravação", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  const store = new StateStore(filePath);
  const state = await store.loadOrCreate(new Date("2026-10-31T12:00:00.000Z"));

  marcarEntregue(state, { id: "antiga", createdAt: "2026-10-29T11:00:00.000Z" });
  marcarEntregue(state, { id: "recente", createdAt: "2026-10-31T11:50:00.000Z" });
  await store.save(state);
  const relido = await store.loadOrCreate();

  assert.deepEqual(Object.keys(relido.entregues ?? {}), ["recente"]);
  assert.equal(jaEntregue(relido, { id: "recente", createdAt: "2026-10-31T11:50:00.000Z" }), true);
  assert.equal(jaEntregue(relido, { id: "outra", createdAt: "2026-10-31T11:50:00.000Z" }), false);
  assert.equal(inicioDaLeitura(relido), "2026-10-31T11:45:00.000Z");
});

test("o estado de antes, sem entregues, continua valendo e conta os cursorIds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "financas-zap-"));
  const filePath = path.join(directory, "state.json");
  const antigo = {
    version: 1,
    cursorAt: "2026-10-31T12:00:00.000Z",
    cursorIds: ["no-cursor"],
    deliveredDestinations: {},
  };
  await writeFile(filePath, JSON.stringify(antigo), "utf8");

  const state = await new StateStore(filePath).loadOrCreate();

  assert.equal(state.cursorAt, antigo.cursorAt);
  assert.equal(jaEntregue(state, { id: "no-cursor", createdAt: "2026-10-31T12:00:00.000Z" }), true);
});
