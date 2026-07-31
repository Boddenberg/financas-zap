import assert from "node:assert/strict";
import test from "node:test";
import { contentForDelivery } from "./message-monitor";

const MENSAGEM = [
  "☀️ Como foi o dia de ontem",
  "Ontem foram concluídas 12 atividades, somando 25 pontos de esforço.",
].join("\n");

test("entrega exatamente o campo mensagem sem interpretar o conteúdo", () => {
  assert.deepEqual(
    contentForDelivery({
      id: "mensagem-1",
      content: MENSAGEM,
      createdAt: "2026-07-29T20:00:01Z",
    }),
    { text: MENSAGEM, imageBase64: undefined, imageName: undefined },
  );
});

test("a arte vai junto da mensagem, como legenda e não como segundo envio", () => {
  const entrega = contentForDelivery({
    id: "mensagem-2",
    content: MENSAGEM,
    createdAt: "2026-07-29T20:00:01Z",
    imageBase64: "iVBORw0KGgo=",
    imageName: "casa-resumo_diario-2026-07-29.png",
  });

  assert.equal(entrega.text, MENSAGEM);
  assert.equal(entrega.imageBase64, "iVBORw0KGgo=");
  assert.equal(entrega.imageName, "casa-resumo_diario-2026-07-29.png");
});
