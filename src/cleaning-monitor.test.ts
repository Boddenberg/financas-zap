import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCleaningMessage,
  isCleaningEvent,
} from "./cleaning-monitor";
import type { CleaningEvent } from "./financas-client";

function event(overrides: Partial<CleaningEvent> = {}): CleaningEvent {
  return {
    id: "registro-1",
    actorId: "usuario-1",
    actorName: "Victor",
    activityName: "Limpar a pia e as bancadas",
    categoryName: "Limpeza e organização",
    roomName: "Cozinha",
    points: 2.5,
    shared: false,
    capturedAt: "2026-07-29T20:00:00Z",
    savedAt: "2026-07-29T20:00:01Z",
    ...overrides,
  };
}

test("reconhece a categoria de limpeza ignorando caixa e acentos", () => {
  assert.equal(isCleaningEvent(event(), ["LIMPEZA"]), true);
  assert.equal(
    isCleaningEvent(event({ categoryName: "Organização doméstica" }), ["organizacao"]),
    true,
  );
  assert.equal(isCleaningEvent(event({ categoryName: "Cozinha" }), ["limpeza"]), false);
});

test("formata um aviso com pessoa, atividade, cômodo e pontos", () => {
  assert.equal(
    formatCleaningMessage(event()),
    [
      "🧹 *Casa cuidada!*",
      "Victor registrou *Limpar a pia e as bancadas* em *Cozinha*.",
      "⭐ +2,5 pontos no app Casa.",
    ].join("\n"),
  );
});

test("indica quando a atividade foi compartilhada", () => {
  const message = formatCleaningMessage(
    event({ roomName: undefined, shared: true, points: 4 }),
  );

  assert.match(message, /Atividade feita em conjunto/);
  assert.doesNotMatch(message, / em \*/);
});
