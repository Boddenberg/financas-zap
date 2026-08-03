import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "whatsapp-web.js";
import { envelopeDe, numeroDoJid } from "./entrada";

/**
 * O que estes testes seguram é a regra que mantém a ponte burra: ela **relata**
 * o envelope e não interpreta nada.
 *
 * O caso mais caro é o do grupo. Ali `from` é o grupo e quem falou vem em
 * `author`; mandar o jid do grupo no campo `de` faria o casal inteiro parecer
 * um número desconhecido, e o backend responderia com silêncio sem ninguém
 * entender por quê.
 */

function mensagem(extras: Partial<Message> = {}): Message {
  return {
    id: { _serialized: "wa-1" },
    from: "5511981090986@c.us",
    body: "lavei a louça",
    fromMe: false,
    timestamp: 1_780_000_000,
    ...extras,
  } as unknown as Message;
}

test("no privado, quem falou é o próprio remetente", () => {
  const envelope = envelopeDe(mensagem());

  assert.equal(envelope?.de, "5511981090986");
  assert.equal(envelope?.conversa, "direta");
  assert.equal(envelope?.grupo, null);
  assert.equal(envelope?.texto, "lavei a louça");
});

test("no grupo, quem falou vem do autor e nunca do jid do grupo", () => {
  const envelope = envelopeDe(
    mensagem({
      from: "120363411589990438@g.us",
      author: "5511972435718@c.us",
    } as Partial<Message>),
  );

  assert.equal(envelope?.de, "5511972435718");
  assert.equal(envelope?.conversa, "grupo");
  assert.equal(envelope?.grupo, "120363411589990438");
});

test("o eco da própria conta não volta para o backend", () => {
  assert.equal(envelopeDe(mensagem({ fromMe: true } as Partial<Message>)), null);
});

test("mensagem sem texto não vira pergunta", () => {
  assert.equal(envelopeDe(mensagem({ body: "   " } as Partial<Message>)), null);
});

test("remetente sem número reconhecível é descartado", () => {
  assert.equal(
    envelopeDe(mensagem({ from: "status@broadcast" } as Partial<Message>)),
    null,
  );
});

test("o jid vira dígitos", () => {
  assert.equal(numeroDoJid("5511946316274@c.us"), "5511946316274");
  assert.equal(numeroDoJid(null), "");
});

test("sem `_serialized`, o id é montado das partes", () => {
  const envelope = envelopeDe(
    mensagem({
      id: { fromMe: false, remote: "5511981090986@c.us", id: "3EB0ABC" },
    } as unknown as Partial<Message>),
  );

  assert.equal(envelope?.waId, "false_5511981090986@c.us_3EB0ABC");
});

test("sem id nenhum, o derivado é o mesmo para a mesma mensagem", () => {
  const sem = { id: undefined } as unknown as Partial<Message>;
  const primeiro = envelopeDe(mensagem(sem));
  const segundo = envelopeDe(mensagem(sem));

  // Determinístico de propósito: é isso que faz a reentrega bater no índice
  // único do backend em vez de virar um segundo registro.
  assert.match(primeiro?.waId ?? "", /^derivado_[0-9a-f]{40}$/);
  assert.equal(primeiro?.waId, segundo?.waId);
});

test("mensagens diferentes derivam ids diferentes", () => {
  const um = envelopeDe(mensagem({ id: undefined } as unknown as Partial<Message>));
  const outro = envelopeDe(
    mensagem({ id: undefined, body: "passei pano" } as unknown as Partial<Message>),
  );

  assert.notEqual(um?.waId, outro?.waId);
});
