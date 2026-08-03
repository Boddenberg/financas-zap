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

test("no privado, quem falou é o próprio remetente", async () => {
  const envelope = await envelopeDe(mensagem());

  assert.equal(envelope?.de, "5511981090986");
  assert.equal(envelope?.conversa, "direta");
  assert.equal(envelope?.grupo, null);
  assert.equal(envelope?.texto, "lavei a louça");
});

test("no grupo, quem falou vem do autor e nunca do jid do grupo", async () => {
  const envelope = await envelopeDe(
    mensagem({
      from: "120363411589990438@g.us",
      author: "5511972435718@c.us",
    } as Partial<Message>),
  );

  assert.equal(envelope?.de, "5511972435718");
  assert.equal(envelope?.conversa, "grupo");
  assert.equal(envelope?.grupo, "120363411589990438");
});

test("o eco da própria conta não volta para o backend", async () => {
  assert.equal(await envelopeDe(mensagem({ fromMe: true } as Partial<Message>)), null);
});

test("mensagem sem texto não vira pergunta", async () => {
  assert.equal(await envelopeDe(mensagem({ body: "   " } as Partial<Message>)), null);
});

test("remetente sem número reconhecível é descartado", async () => {
  assert.equal(
    await envelopeDe(mensagem({ from: "status@broadcast" } as Partial<Message>)),
    null,
  );
});

test("o jid vira dígitos", async () => {
  assert.equal(numeroDoJid("5511946316274@c.us"), "5511946316274");
  assert.equal(numeroDoJid(null), "");
});

test("sem `_serialized`, o id é montado das partes", async () => {
  const envelope = await envelopeDe(
    mensagem({
      id: { fromMe: false, remote: "5511981090986@c.us", id: "3EB0ABC" },
    } as unknown as Partial<Message>),
  );

  assert.equal(envelope?.waId, "false_5511981090986@c.us_3EB0ABC");
});

test("sem id nenhum, o derivado é o mesmo para a mesma mensagem", async () => {
  const sem = { id: undefined } as unknown as Partial<Message>;
  const primeiro = await envelopeDe(mensagem(sem));
  const segundo = await envelopeDe(mensagem(sem));

  // Determinístico de propósito: é isso que faz a reentrega bater no índice
  // único do backend em vez de virar um segundo registro.
  assert.match(primeiro?.waId ?? "", /^derivado_[0-9a-f]{40}$/);
  assert.equal(primeiro?.waId, segundo?.waId);
});

test("um LID vira o telefone de verdade, tirado do contato", async () => {
  const envelope = await envelopeDe(
    mensagem({
      from: "120363411589990438@g.us",
      author: "61100221534218@lid",
      getContact: async () => ({ number: "5511981090986" }),
    } as unknown as Partial<Message>),
  );

  // O LID tem catorze dígitos e passaria por qualquer validação de E.164 — é
  // exatamente por isso que ele precisa ser resolvido, e não só validado.
  assert.equal(envelope?.de, "5511981090986");
});

test("LID sem contato é descartado em vez de virar identidade falsa", async () => {
  const envelope = await envelopeDe(
    mensagem({
      from: "61100221534218@lid",
      getContact: async () => {
        throw new Error("contato indisponível");
      },
    } as unknown as Partial<Message>),
  );

  assert.equal(envelope, null);
});

test("mensagens diferentes derivam ids diferentes", async () => {
  const um = await envelopeDe(mensagem({ id: undefined } as unknown as Partial<Message>));
  const outro = await envelopeDe(
    mensagem({ id: undefined, body: "passei pano" } as unknown as Partial<Message>),
  );

  assert.notEqual(um?.waId, outro?.waId);
});
