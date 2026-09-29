// Conserta o envio de imagem do whatsapp-web.js 1.34.7 depois de cada install.
//
// Desde as versões do WhatsApp Web de 17/09/2026, toda mídia falha com "Data
// passed to getter must include an id property (it's how we memoize) but got
// undefined": o `sendMessage` injetado espalha o modelo da mídia na mensagem,
// e junto vai o campo privado `__x_id: undefined`, que apaga o id quando o
// WhatsApp monta a mensagem. Texto passa; foto não — e o resumo da Casa e o
// cartão do Huntera são foto.
//
// A correção é a da comunidade (wwebjs/whatsapp-web.js#201921, OpenWA#1670):
// tirar o `__x_id` logo depois de montar a mensagem. Aplicada aqui no
// postinstall até sair uma versão que já traga a correção; numa versão sem o
// trecho esperado, só avisa.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let pasta
try {
  pasta = dirname(require.resolve('whatsapp-web.js/package.json'))
} catch {
  process.exit(0)
}
const arquivo = join(pasta, 'src', 'util', 'Injected', 'Utils.js')
const versao = JSON.parse(readFileSync(join(pasta, 'package.json'), 'utf8')).version
const codigo = readFileSync(arquivo, 'utf8')
const CORRECAO = 'delete message.__x_id;'
const ANCORA = /(\n([ \t]*)\/\/ Bot's won't reply if canonicalUrl is set \(linking\)\n[ \t]*if \(botOptions\) \{\n[ \t]*delete message\.canonicalUrl;\n[ \t]*\}\n)/

if (codigo.includes(CORRECAO)) process.exit(0)
const achado = codigo.match(ANCORA)
if (!achado) {
  console.warn(`[financas-zap] whatsapp-web.js ${versao}: não achei onde tirar o __x_id da mídia. Se foto voltar a falhar com "must include an id property", veja scripts/corrigir-wwebjs-midia.mjs.`)
  process.exit(0)
}
const recuo = achado[2]
const novo = codigo.replace(ANCORA, `$1\n${recuo}// financas-zap: o id privado da mídia apaga o da mensagem (WhatsApp Web de 17/09/2026).\n${recuo}${CORRECAO}\n`)
writeFileSync(arquivo, novo)
console.log(`[financas-zap] whatsapp-web.js ${versao}: envio de mídia corrigido.`)
