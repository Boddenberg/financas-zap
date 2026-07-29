import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advanceCursor,
  isAfterCursor,
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
      savedAt: "2026-07-29T21:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    isAfterCursor(state, {
      id: "registro-2",
      savedAt: "2026-07-29T21:00:00.000Z",
    }),
    true,
  );

  advanceCursor(state, {
    id: "registro-2",
    savedAt: "2026-07-29T21:00:00.000Z",
  });
  assert.deepEqual(state.cursorIds, ["registro-1", "registro-2"]);
});
