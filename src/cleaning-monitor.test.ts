import assert from "node:assert/strict";
import test from "node:test";
import { formatCleaningMessage } from "./cleaning-monitor";
import type { CleaningEvent } from "./financas-client";

function event(overrides: Partial<CleaningEvent> = {}): CleaningEvent {
  return {
    id: "registro-1",
    actorName: "Victor",
    activityName: "Limpar a pia e as bancadas",
    roomName: "Cozinha",
    points: 2.5,
    shared: false,
    savedAt: "2026-07-29T20:00:01Z",
    ...overrides,
  };
}

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
