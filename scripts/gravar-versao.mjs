// Grava em dist/versao.json o commit e a hora do build, no `prebuild`.
//
// A ponte não tem deploy automático: ela roda o que foi compilado no PC. Com
// este arquivo, a subida escreve no diário qual commit está rodando.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(...argumentos) {
  try {
    return execFileSync('git', argumentos, { cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const versao = {
  commit: git('rev-parse', '--short', 'HEAD') || 'desconhecido',
  // Código diferente do commit (editado à mão no PC) aparece no diário.
  alterado: git('status', '--porcelain', '--untracked-files=no') !== '',
  data: new Date().toISOString(),
}

mkdirSync(join(raiz, 'dist'), { recursive: true })
writeFileSync(join(raiz, 'dist', 'versao.json'), `${JSON.stringify(versao, null, 2)}\n`)
console.log(`[financas-zap] versão ${versao.commit}${versao.alterado ? ' (com alterações locais)' : ''}.`)
