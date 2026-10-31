import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { descreverVersao } from "./versao";

test("a subida diz qual commit está rodando", async () => {
  const pasta = await mkdtemp(path.join(os.tmpdir(), "financas-zap-versao-"));
  await writeFile(
    path.join(pasta, "versao.json"),
    JSON.stringify({ commit: "abc1234", alterado: false, data: "2026-10-31T12:00:00.000Z" }),
  );

  assert.equal(descreverVersao(pasta), "abc1234, build de 2026-10-31T12:00:00.000Z");
});

test("código alterado à mão aparece na versão", async () => {
  const pasta = await mkdtemp(path.join(os.tmpdir(), "financas-zap-versao-"));
  await writeFile(path.join(pasta, "versao.json"), JSON.stringify({ commit: "abc1234", alterado: true }));

  assert.equal(descreverVersao(pasta), "abc1234 com alterações locais");
});

test("sem build, a versão diz que não há arquivo", async () => {
  const pasta = await mkdtemp(path.join(os.tmpdir(), "financas-zap-versao-"));

  assert.equal(descreverVersao(pasta), "sem versão gravada (fora do build)");
});
