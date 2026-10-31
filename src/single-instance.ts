import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Uma ponte por pasta.
 *
 * Duas cópias rodando ao mesmo tempo não são duas vezes mais atentas: elas
 * dividem o mesmo perfil do Chromium em `.wwebjs_auth`, brigam pela sessão do
 * WhatsApp e podem entregar a mesma mensagem duas vezes, porque cada uma guarda
 * o próprio avanço do cursor. É o pior estrago que esta ponte sabe fazer, e o
 * mais fácil de cometer sem perceber — basta esquecer um `npm run dev` aberto
 * quando a inicialização do Windows sobe a sua.
 *
 * A trava é o PID em arquivo. Se o processo anotado não existe mais, ela é de
 * quem chegou agora: um desligamento abrupto não pode deixar a ponte impedida
 * de voltar. Trava anotada antes de o computador ligar também é velha: o
 * Windows reaproveita PIDs, e depois de um desligamento o número anotado pode
 * ser de outro processo qualquer.
 */

export type OpcoesDaTrava = {
  /** Segundos desde que o computador ligou (`os.uptime`). */
  uptime?: () => number;
  agora?: () => number;
};

type Trava = {
  pid?: unknown;
  desde?: unknown;
};

export class InstanciaEmUso extends Error {
  constructor(pid: number, arquivo: string) {
    super(
      `Já existe uma ponte rodando nesta pasta (processo ${pid}). ` +
        "Duas cópias dividem a mesma sessão do WhatsApp e podem mandar a mesma " +
        "mensagem duas vezes. Encerre a outra ou, se tiver certeza de que ela " +
        `não existe mais, apague ${arquivo}.`,
    );
    this.name = "InstanciaEmUso";
  }
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM é um processo que existe e não é nosso: continua sendo "vivo".
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function anteriorAoBoot(desde: unknown, opcoes: OpcoesDaTrava): boolean {
  const anotada = typeof desde === "string" ? Date.parse(desde) : Number.NaN;
  if (!Number.isFinite(anotada)) return false;
  const agora = (opcoes.agora ?? Date.now)();
  const boot = agora - (opcoes.uptime ?? os.uptime)() * 1000;
  return anotada < boot;
}

function donoAtual(arquivo: string, opcoes: OpcoesDaTrava): number | undefined {
  let conteudo: string;

  try {
    conteudo = readFileSync(arquivo, "utf8");
  } catch {
    return undefined;
  }

  let trava: Trava;

  try {
    trava = JSON.parse(conteudo) as Trava;
  } catch {
    // Trava ilegível é trava abandonada: um desligamento no meio da escrita.
    return undefined;
  }

  const pid = typeof trava.pid === "number" ? trava.pid : undefined;

  if (
    pid === undefined ||
    pid === process.pid ||
    anteriorAoBoot(trava.desde, opcoes) ||
    !processoVivo(pid)
  ) {
    return undefined;
  }

  return pid;
}

/** Toma a trava e devolve como soltá-la. */
export function claimSingleInstance(
  arquivo: string,
  opcoes: OpcoesDaTrava = {},
): () => void {
  const pid = donoAtual(arquivo, opcoes);

  if (pid !== undefined) {
    throw new InstanciaEmUso(pid, arquivo);
  }

  mkdirSync(path.dirname(arquivo), { recursive: true });
  writeFileSync(
    arquivo,
    `${JSON.stringify({ pid: process.pid, desde: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  let liberada = false;

  return () => {
    if (liberada) {
      return;
    }

    liberada = true;

    try {
      rmSync(arquivo, { force: true });
    } catch {
      // O próximo início encontra o PID morto e assume a trava mesmo assim.
    }
  };
}
