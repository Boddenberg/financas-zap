import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BridgeState = {
  version: 1;
  cursorAt: string;
  cursorIds: string[];
  deliveredDestinations: Record<string, string[]>;
};

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseState(value: unknown): BridgeState {
  if (!value || typeof value !== "object") {
    throw new Error("O estado salvo da ponte não é um objeto válido.");
  }

  const state = value as Partial<BridgeState>;

  if (
    state.version !== 1 ||
    !isValidDate(state.cursorAt) ||
    !Array.isArray(state.cursorIds) ||
    !state.cursorIds.every((id) => typeof id === "string") ||
    !state.deliveredDestinations ||
    typeof state.deliveredDestinations !== "object"
  ) {
    throw new Error("O estado salvo da ponte está incompleto ou incompatível.");
  }

  for (const destinations of Object.values(state.deliveredDestinations)) {
    if (
      !Array.isArray(destinations) ||
      !destinations.every((destination) => typeof destination === "string")
    ) {
      throw new Error("O estado salvo da ponte contém uma entrega inválida.");
    }
  }

  return state as BridgeState;
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  async loadOrCreate(now = new Date()): Promise<BridgeState> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return parseState(JSON.parse(contents) as unknown);
    } catch (error) {
      const filesystemError = error as NodeJS.ErrnoException;

      if (filesystemError.code !== "ENOENT") {
        throw new Error(
          `Não foi possível ler o estado da ponte em ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const state: BridgeState = {
      version: 1,
      cursorAt: now.toISOString(),
      cursorIds: [],
      deliveredDestinations: {},
    };
    await this.save(state);
    return state;
  }

  async save(state: BridgeState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export function isAfterCursor(
  state: BridgeState,
  event: { id: string; savedAt: string },
): boolean {
  const comparison = Date.parse(event.savedAt) - Date.parse(state.cursorAt);
  return comparison > 0 || (comparison === 0 && !state.cursorIds.includes(event.id));
}

export function advanceCursor(
  state: BridgeState,
  event: { id: string; savedAt: string },
): void {
  const comparison = Date.parse(event.savedAt) - Date.parse(state.cursorAt);

  if (comparison > 0) {
    state.cursorAt = event.savedAt;
    state.cursorIds = [event.id];
    return;
  }

  if (comparison === 0 && !state.cursorIds.includes(event.id)) {
    state.cursorIds.push(event.id);
  }
}
