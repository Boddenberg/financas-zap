import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type BridgeState = {
  version: 1;
  cursorAt: string;
  cursorIds: string[];
  deliveredDestinations: Record<string, string[]>;
  /**
   * O que o WhatsApp já aceitou: id → `criada_em` da mensagem. É o que impede
   * o reenvio quando a leitura volta atrás do cursor (`inicioDaLeitura`).
   * Opcional porque o estado de antes não o tinha.
   */
  entregues?: Record<string, string>;
};

/**
 * Quanto a leitura volta antes do cursor. Uma mensagem com anexo nasce
 * `montando` e só vira `pendente` depois, com o `criada_em` de quando nasceu:
 * se outra, mais nova, saiu nesse meio-tempo, o cursor já passou por cima dela.
 * O backend a solta em até 5 minutos (`liberar_presas`); 15 dá folga.
 */
export const JANELA_PARA_TRAS_MS = 15 * 60 * 1000;

/** Quanto tempo atrás do cursor uma entrega continua anotada. */
const GUARDA_DAS_ENTREGUES_MS = 48 * 60 * 60 * 1000;

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

  if (
    state.entregues !== undefined &&
    (!state.entregues ||
      typeof state.entregues !== "object" ||
      Array.isArray(state.entregues) ||
      !Object.values(state.entregues).every(isValidDate))
  ) {
    throw new Error("O estado salvo da ponte contém uma entrega inválida.");
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

/** De onde a leitura começa: um pouco antes do cursor (`JANELA_PARA_TRAS_MS`). */
export function inicioDaLeitura(state: BridgeState): string {
  return new Date(Date.parse(state.cursorAt) - JANELA_PARA_TRAS_MS).toISOString();
}

/**
 * Se o WhatsApp já aceitou esta mensagem. Os `cursorIds` contam junto: são as
 * entregas de antes de existir `entregues`, no instante do cursor.
 */
export function jaEntregue(
  state: BridgeState,
  message: { id: string; createdAt: string },
): boolean {
  return (
    state.entregues?.[message.id] !== undefined ||
    (Date.parse(message.createdAt) === Date.parse(state.cursorAt) &&
      state.cursorIds.includes(message.id))
  );
}

/** Anota a entrega e esquece as que ficaram 48 h atrás do cursor. */
export function marcarEntregue(
  state: BridgeState,
  message: { id: string; createdAt: string },
): void {
  const entregues = (state.entregues ??= {});
  entregues[message.id] = message.createdAt;
  const limite = Date.parse(state.cursorAt) - GUARDA_DAS_ENTREGUES_MS;

  for (const [id, criadaEm] of Object.entries(entregues)) {
    if (Date.parse(criadaEm) < limite) {
      delete entregues[id];
    }
  }
}
