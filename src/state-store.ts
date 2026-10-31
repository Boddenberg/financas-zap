import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Erros de um arquivo preso por outro processo (antivírus, indexador do Windows). */
const ARQUIVO_PRESO = new Set(["EPERM", "EACCES", "EBUSY"]);
const ESPERAS_DO_RENAME_MS = [100, 500];

type Renomear = (de: string, para: string) => Promise<void>;

export type OpcoesDoEstado = {
  /** Troca o `rename` do disco (testes). */
  renomear?: Renomear;
};

export class StateStore {
  private readonly renomear: Renomear;

  constructor(
    private readonly filePath: string,
    opcoes: OpcoesDoEstado = {},
  ) {
    this.renomear = opcoes.renomear ?? rename;
  }

  /**
   * O estado salvo, ou um novo com o cursor em `now`.
   *
   * Um arquivo ilegível (queda de energia no meio de uma gravação antiga, edição
   * à mão) não segura a ponte fora do ar: ele é guardado ao lado como
   * `.corrompido-<data>` e o estado recomeça, como num primeiro início.
   */
  async loadOrCreate(now = new Date()): Promise<BridgeState> {
    let contents: string | undefined;
    try {
      contents = await readFile(this.filePath, "utf8");
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

    if (contents !== undefined) {
      try {
        return parseState(JSON.parse(contents) as unknown);
      } catch (error) {
        const guardado = `${this.filePath}.corrompido-${carimbo(now)}`;
        await this.renomear(this.filePath, guardado);
        console.error(
          `O estado da ponte em ${this.filePath} estava ilegível (${
            error instanceof Error ? error.message : String(error)
          }); guardado em ${guardado} e recomeçado.`,
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

  /**
   * Grava num `.tmp` e troca pelo arquivo final com `rename`, que substitui de
   * uma vez: uma queda no meio deixa o estado anterior inteiro, nunca a metade.
   */
  async save(state: BridgeState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporario = `${this.filePath}.tmp`;
    await writeFile(temporario, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.trocar(temporario);
  }

  private async trocar(temporario: string): Promise<void> {
    for (let tentativa = 0; ; tentativa += 1) {
      try {
        await this.renomear(temporario, this.filePath);
        return;
      } catch (error) {
        const espera = ESPERAS_DO_RENAME_MS[tentativa];
        const codigo = (error as NodeJS.ErrnoException).code;
        if (espera === undefined || !codigo || !ARQUIVO_PRESO.has(codigo)) throw error;
        await new Promise((resolver) => setTimeout(resolver, espera));
      }
    }
  }
}

/** A data num nome de arquivo que o Windows aceita (sem `:`). */
function carimbo(data: Date): string {
  return data.toISOString().replace(/[:.]/g, "-");
}

export function isAfterCursor(
  state: BridgeState,
  message: { id: string; createdAt: string },
): boolean {
  const comparison = Date.parse(message.createdAt) - Date.parse(state.cursorAt);
  return comparison > 0 || (comparison === 0 && !state.cursorIds.includes(message.id));
}

export function advanceCursor(
  state: BridgeState,
  message: { id: string; createdAt: string },
): void {
  const comparison = Date.parse(message.createdAt) - Date.parse(state.cursorAt);

  if (comparison > 0) {
    state.cursorAt = message.createdAt;
    state.cursorIds = [message.id];
    return;
  }

  if (comparison === 0 && !state.cursorIds.includes(message.id)) {
    state.cursorIds.push(message.id);
  }
}
