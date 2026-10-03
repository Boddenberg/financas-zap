// O `npm audit --omit=dev --audit-level=high`, com as exceções escritas.
//
// Exceção só entra aqui quando não existe versão corrigida e o caminho
// vulnerável não roda na ponte; cada uma diz por quê. Todo o resto de nível
// alto ou crítico reprova, como antes.
import { execSync } from "node:child_process";

const EXCECOES = {
  // extract-zip: todas as versões (até 2.0.1, a última). Ele só é usado pelo
  // `@puppeteer/browsers` para descompactar o Chromium baixado na instalação,
  // e a ponte abre o Chrome do computador (`WHATSAPP_CHROME`, `config.ts`).
  "GHSA-jmr9-qjv8-65gv": "extract-zip sem correção; só na instalação do Puppeteer",
  "GHSA-7pqw-9j4j-h8q3": "extract-zip sem correção; só na instalação do Puppeteer",
};
const GRAVES = new Set(["high", "critical"]);

let saida;
try {
  saida = execSync("npm audit --omit=dev --json", { encoding: "utf8" });
} catch (erro) {
  // O npm audit sai com código 1 quando acha qualquer coisa; o JSON vem igual.
  saida = erro.stdout;
}
const relatorio = JSON.parse(saida);

const reprovam = [];
const toleradas = new Set();
for (const [pacote, vulnerabilidade] of Object.entries(relatorio.vulnerabilities ?? {})) {
  for (const causa of vulnerabilidade.via) {
    if (typeof causa !== "object" || !GRAVES.has(causa.severity)) continue;
    const id = causa.url?.split("/").pop();
    if (EXCECOES[id]) toleradas.add(`${pacote} ${id}: ${EXCECOES[id]}`);
    else reprovam.push(`${pacote} (${causa.severity}): ${causa.title} ${causa.url}`);
  }
}

for (const linha of toleradas) console.log(`tolerada  ${linha}`);
if (reprovam.length) {
  for (const linha of reprovam) console.error(`REPROVA   ${linha}`);
  process.exit(1);
}
console.log("Nenhuma vulnerabilidade alta ou crítica fora das exceções.");
