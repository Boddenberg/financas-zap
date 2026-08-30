import assert from "node:assert/strict";
import { test } from "node:test";

import { apelido, novoTraceId, registrar } from "./trace";

test("o trace tem o formato que o backend aceita", () => {
  const trace = novoTraceId();
  assert.match(trace, /^[0-9a-f]{32}$/u);
});

test("dois traces seguidos são diferentes", () => {
  assert.notEqual(novoTraceId(), novoTraceId());
});

test("o apelido de um telefone é estável e não é o telefone", () => {
  const um = apelido("5511999998888");
  const outro = apelido("5511999998888");
  assert.equal(um, outro);
  assert.match(String(um), /^[0-9a-f]{16}$/u);
  assert.ok(!String(um).includes("9999"));
});

test("sem identificador não há apelido", () => {
  assert.equal(apelido(undefined), null);
});

test("o diário sai em JSON por linha, com o trace junto", () => {
  const linhas: string[] = [];
  const original = console.log;
  console.log = (texto: unknown) => linhas.push(String(texto));
  try {
    registrar("whatsapp_recebida", { trace_id: "a".repeat(32), tipo: "imagem" });
  } finally {
    console.log = original;
  }

  assert.equal(linhas.length, 1);
  const objeto = JSON.parse(linhas[0] ?? "{}") as Record<string, unknown>;
  assert.equal(objeto.evento, "whatsapp_recebida");
  assert.equal(objeto.trace_id, "a".repeat(32));
  assert.equal(objeto.tipo, "imagem");
  assert.ok(typeof objeto.em === "string");
});

test("campo ausente não vira 'undefined' na linha", () => {
  const linhas: string[] = [];
  const original = console.log;
  console.log = (texto: unknown) => linhas.push(String(texto));
  try {
    registrar("teste", { presente: 1, ausente: undefined });
  } finally {
    console.log = original;
  }

  const objeto = JSON.parse(linhas[0] ?? "{}") as Record<string, unknown>;
  assert.equal(objeto.presente, 1);
  assert.ok(!("ausente" in objeto));
});
