import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * O commit que está rodando, como o `prebuild` gravou em `dist/versao.json`
 * (`scripts/gravar-versao.mjs`). Fora do build (`npm run dev`) não há arquivo.
 */
export function descreverVersao(pasta: string = __dirname): string {
  try {
    const versao = JSON.parse(readFileSync(path.join(pasta, "versao.json"), "utf8")) as {
      commit?: unknown;
      alterado?: unknown;
      data?: unknown;
    };
    if (typeof versao.commit === "string" && versao.commit) {
      const alterado = versao.alterado === true ? " com alterações locais" : "";
      const data = typeof versao.data === "string" ? `, build de ${versao.data}` : "";
      return `${versao.commit}${alterado}${data}`;
    }
  } catch {
    // Sem build ou arquivo ilegível: a ponte sobe igual.
  }
  return "sem versão gravada (fora do build)";
}
