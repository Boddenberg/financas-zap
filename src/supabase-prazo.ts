/**
 * Os prazos de uma chamada ao Supabase: 30 s até o cabeçalho e mais 2 min para
 * o corpo descer. Um prazo único cortaria a leitura com anexos em base64 num
 * link lento em toda volta; sem prazo, o `fetch` espera 5 min pelo cabeçalho.
 */
export const PRAZO_DO_CABECALHO_MS = 30_000;
export const PRAZO_DO_CORPO_MS = 2 * 60_000;

/** O corpo não desceu no prazo: o lote é grande demais para o link. */
export class CorpoLento extends Error {
  constructor(ms: number) {
    super(`A resposta do Supabase não terminou de chegar em ${ms / 1000} s.`);
    this.name = "CorpoLento";
  }
}

/** Erros em que uma leitura com menos linhas pode passar. */
export function lotePedeMenos(erro: unknown): boolean {
  return erro instanceof CorpoLento || (erro instanceof Error && /statement timeout/i.test(erro.message));
}

/** `fetch` com os dois prazos; `ler` consome a resposta dentro do prazo do corpo. */
export async function chamarComPrazo<T>(
  url: string,
  init: RequestInit,
  ler: (resposta: Response) => Promise<T>,
  prazoDoCorpoMs = PRAZO_DO_CORPO_MS,
): Promise<T> {
  const controle = new AbortController();
  const cabecalho = AbortSignal.timeout(PRAZO_DO_CABECALHO_MS);
  const largar = (): void => controle.abort(cabecalho.reason);
  if (cabecalho.aborted) largar();
  else cabecalho.addEventListener("abort", largar, { once: true });
  let relogio: ReturnType<typeof setTimeout> | undefined;

  try {
    const resposta = await fetch(url, { ...init, signal: controle.signal });
    cabecalho.removeEventListener("abort", largar);
    relogio = setTimeout(() => controle.abort(new CorpoLento(prazoDoCorpoMs)), prazoDoCorpoMs);
    return await ler(resposta);
  } finally {
    cabecalho.removeEventListener("abort", largar);
    clearTimeout(relogio);
  }
}
