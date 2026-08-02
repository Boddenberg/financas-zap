import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { claimSingleInstance, InstanciaEmUso } from "./single-instance";

function travaTemporaria(): string {
  const pasta = path.join(
    mkdtempSync(path.join(tmpdir(), "financas-zap-trava-")),
    ".runtime",
  );
  mkdirSync(pasta, { recursive: true });
  return path.join(pasta, "financas-zap.lock");
}

function apagar(arquivo: string): void {
  rmSync(path.dirname(path.dirname(arquivo)), { recursive: true, force: true });
}

test("a trava anota quem subiu", () => {
  const arquivo = travaTemporaria();
  const liberar = claimSingleInstance(arquivo);

  assert.equal(
    (JSON.parse(readFileSync(arquivo, "utf8")) as { pid: number }).pid,
    process.pid,
  );

  liberar();
  assert.equal(existsSync(arquivo), false);
  apagar(arquivo);
});

test("a segunda cópia não sobe enquanto a primeira estiver de pé", () => {
  const arquivo = travaTemporaria();
  const outraPonte = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], {
    stdio: "ignore",
  });

  try {
    writeFileSync(arquivo, JSON.stringify({ pid: outraPonte.pid }), "utf8");

    assert.throws(
      () => claimSingleInstance(arquivo),
      (error) =>
        error instanceof InstanciaEmUso &&
        error.message.includes(String(outraPonte.pid)),
    );
  } finally {
    outraPonte.kill();
    apagar(arquivo);
  }
});

test("uma trava esquecida por um processo morto não impede a volta", () => {
  const arquivo = travaTemporaria();

  // Um desligamento abrupto deixa o arquivo para trás com o PID de quem já
  // morreu. Este processo nasceu e terminou aqui mesmo, nesta linha.
  const encerrado = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(arquivo, JSON.stringify({ pid: encerrado.pid }), "utf8");

  const liberar = claimSingleInstance(arquivo);

  assert.ok(existsSync(arquivo));
  liberar();
  apagar(arquivo);
});

test("uma trava ilegível é tratada como abandonada", () => {
  const arquivo = travaTemporaria();
  writeFileSync(arquivo, "{ isto não é json", "utf8");

  claimSingleInstance(arquivo)();
  apagar(arquivo);
});
