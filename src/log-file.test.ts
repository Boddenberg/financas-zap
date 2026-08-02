import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mirrorConsoleToFile } from "./log-file";

function pastaTemporaria(): string {
  return mkdtempSync(path.join(tmpdir(), "financas-zap-diario-"));
}

test("sem caminho, o terminal continua sendo o único destino", () => {
  const originalLog = console.log;
  const restaurar = mirrorConsoleToFile(undefined);

  assert.equal(console.log, originalLog);
  restaurar();
});

test("o que iria para a tela também fica em disco, com hora", () => {
  const pasta = pastaTemporaria();
  const arquivo = path.join(pasta, "sub", "financas-zap.log");
  const naTela: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...argumentos: unknown[]) => {
    naTela.push(String(argumentos[0]));
  };
  console.error = () => undefined;

  const restaurar = mirrorConsoleToFile(arquivo);

  try {
    console.log("Mensagem %s entregue.", "abc");
    console.error("Falha ao avisar o Finanças.");
  } finally {
    restaurar();
    console.log = originalLog;
    console.error = originalError;
  }

  const [primeira, segunda] = readFileSync(arquivo, "utf8").trim().split("\n");
  rmSync(pasta, { recursive: true, force: true });

  assert.match(primeira ?? "", /^\[\d{2}\/\d{2}\/\d{4}.+\] Mensagem abc entregue\.$/);
  assert.match(segunda ?? "", /erro: Falha ao avisar o Finanças\.$/);
  assert.deepEqual(naTela, ["Mensagem %s entregue."]);
});

test("um erro repetido não vira um arquivo sem fim", () => {
  const pasta = pastaTemporaria();
  const arquivo = path.join(pasta, "financas-zap.log");
  const original = console.log;
  console.log = () => undefined;
  const restaurar = mirrorConsoleToFile(arquivo, 200);

  try {
    for (let tentativa = 0; tentativa < 40; tentativa += 1) {
      console.log(`Falha ao consultar a caixa do WhatsApp (${tentativa}).`);
    }
  } finally {
    restaurar();
    console.log = original;
  }

  const atual = readFileSync(arquivo, "utf8");

  assert.ok(atual.length <= 200, `o diário passou do teto: ${atual.length} bytes`);
  assert.ok(existsSync(`${arquivo}.anterior`), "o trecho anterior foi guardado");
  assert.match(atual, /\(39\)/);

  rmSync(pasta, { recursive: true, force: true });
});
