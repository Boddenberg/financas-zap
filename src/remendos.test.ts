import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

/**
 * O remendo do `postinstall` (`scripts/corrigir-wwebjs-midia.mjs`) só avisa
 * quando não acha onde entrar, e sai com 0. Um bump do whatsapp-web.js passaria
 * verde e a foto voltaria a falhar com "must include an id property". Este
 * teste é o alarme: o CI roda o `postinstall` no `npm ci`.
 */
test("o envio de mídia do whatsapp-web.js está remendado (sem o __x_id)", () => {
  const require = createRequire(__filename);
  const pasta = path.dirname(require.resolve("whatsapp-web.js/package.json"));
  const codigo = readFileSync(path.join(pasta, "src", "util", "Injected", "Utils.js"), "utf8");

  assert.ok(
    codigo.includes("delete message.__x_id"),
    "o remendo do postinstall não entrou; veja scripts/corrigir-wwebjs-midia.mjs",
  );
});
