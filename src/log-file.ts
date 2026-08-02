import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

/**
 * O diário da ponte quando ela sobe sozinha com o Windows.
 *
 * Ligada pela inicialização, a ponte não tem janela: se algo der errado às três
 * da manhã, o console onde ela reclamaria não existe para ninguém. Aqui o que
 * ela diria na tela também fica em disco, com hora, para que a pergunta "o
 * resumo saiu?" tenha resposta no dia seguinte.
 *
 * O arquivo tem teto. Um erro que se repita a cada minuto não pode virar um
 * arquivo de vários gigabytes na máquina que este projeto promete não pesar.
 */
const LIMITE_DE_BYTES = 512 * 1024;

type Registro = "log" | "warn" | "error";

const PREFIXO: Record<Registro, string> = {
  log: "",
  warn: "aviso: ",
  error: "erro: ",
};

function tamanhoAtual(arquivo: string): number {
  try {
    return statSync(arquivo).size;
  } catch {
    return 0;
  }
}

function agora(): string {
  return new Date().toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

/**
 * Passa a escrever no arquivo tudo o que for para o console, sem tirar nada da
 * tela. Devolve como voltar atrás — é o que os testes usam, e o que mantém o
 * modo terminal exatamente como era.
 *
 * Sem caminho, não faz nada: quem roda no terminal já está vendo tudo.
 */
export function mirrorConsoleToFile(
  caminho: string | undefined,
  limiteDeBytes = LIMITE_DE_BYTES,
): () => void {
  if (!caminho?.trim()) {
    return () => undefined;
  }

  const arquivo = path.resolve(process.cwd(), caminho.trim());

  try {
    mkdirSync(path.dirname(arquivo), { recursive: true });
  } catch (error) {
    // Um diário que não abre não pode impedir a ponte de entregar mensagem.
    console.error(
      `Não foi possível abrir o diário em ${arquivo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return () => undefined;
  }

  let bytes = tamanhoAtual(arquivo);
  const original: Record<Registro, typeof console.log> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  const escrever = (registro: Registro, argumentos: unknown[]): void => {
    const linha = `[${agora()}] ${PREFIXO[registro]}${format(...argumentos)}\n`;
    const peso = Buffer.byteLength(linha);

    try {
      if (bytes + peso > limiteDeBytes) {
        renameSync(arquivo, `${arquivo}.anterior`);
        bytes = 0;
      }

      appendFileSync(arquivo, linha, { encoding: "utf8", mode: 0o600 });
      bytes += peso;
    } catch {
      // Disco cheio ou arquivo travado por outro programa: a tela continua.
    }
  };

  for (const registro of ["log", "warn", "error"] as const) {
    console[registro] = (...argumentos: unknown[]): void => {
      original[registro](...argumentos);
      escrever(registro, argumentos);
    };
  }

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}
