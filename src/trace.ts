/**
 * O fio que liga a mensagem no WhatsApp ao que o backend fez com ela.
 *
 * Esta era a última lacuna do diagnóstico de observabilidade do hub (§3, item
 * 12): a ponte falava em `console.log` puro, e não havia como dizer que a foto
 * que não chegou às 14:31 é a interação que estourou no backend às 14:31 e
 * pouco. Duas máquinas, dois diários, nenhum id em comum.
 *
 * O que resolve isso é pequeno de propósito: um id de 128 bits por mensagem,
 * mandado no `X-Trace-Id` (que o backend já lê e adota), e um diário em JSON
 * por linha que carrega esse id. Não há SDK, não há coletor, não há dependência
 * nova — o formato é o do W3C Trace Context, o mesmo que o backend usa, então
 * um exporter futuro é escrita, não reinstrumentação.
 *
 * **O que não vai daqui:** o texto da mensagem, o telefone e o nome de quem
 * escreveu. O diário desta máquina registra a *forma* — quem em hash, o que em
 * tipo e tamanho —, pela mesma razão que o backend registra: um diário de
 * ponte com o conteúdo da conversa é uma segunda cópia do dado sensível, com
 * retenção própria e sem tela que a governe.
 */

import { createHash, randomBytes } from "node:crypto";

/** Um trace novo: 16 bytes em hexadecimal, como manda o W3C Trace Context. */
export function novoTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * O pseudônimo estável de um telefone ou de um grupo.
 *
 * Serve para agrupar ("as mensagens desta conversa") sem guardar o número. Não
 * é segredo — a ponte não tem um para usar como chave, e inventar um aqui daria
 * a impressão de anonimato forte que 16 hex de sha256 sobre um telefone não
 * têm. É pseudonimização honesta: some da vista, não resiste a quem tem a lista
 * de números e paciência.
 */
export function apelido(identificador: string | undefined): string | null {
  if (!identificador) return null;
  return createHash("sha256").update(identificador).digest("hex").slice(0, 16);
}

type Campos = Record<string, string | number | boolean | null | undefined>;

/**
 * Uma linha de diário, em JSON, com o trace junto.
 *
 * Continua saindo pelo `console` de propósito: `log-file.ts` já captura o que
 * vai para lá e o guarda em disco com teto de tamanho. Um segundo canal de
 * escrita seria um segundo arquivo para rodar e um segundo lugar para procurar.
 */
export function registrar(evento: string, campos: Campos = {}): void {
  const linha: Campos & { evento: string; em: string } = {
    evento,
    em: new Date().toISOString(),
    ...campos,
  };
  for (const chave of Object.keys(linha)) {
    if (linha[chave] === undefined) delete linha[chave];
  }
  console.log(JSON.stringify(linha));
}
