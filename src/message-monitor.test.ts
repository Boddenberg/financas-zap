import assert from "node:assert/strict";
import test from "node:test";
import { contentForDelivery } from "./message-monitor";

test("entrega exatamente o campo mensagem sem interpretar o conteúdo", () => {
  const content = [
    "🧹 *Casa cuidada!*",
    "Victor registrou *Limpar a pia e as bancadas* em *Cozinha*.",
    "⭐ +2,5 pontos no app Casa.",
  ].join("\n");

  assert.equal(
    contentForDelivery({
      id: "mensagem-1",
      content,
      createdAt: "2026-07-29T20:00:01Z",
    }),
    content,
  );
});
