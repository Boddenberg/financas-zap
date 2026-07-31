import type { AppConfig } from "./config";

/**
 * O pulso: "agora são tais horas".
 *
 * O Finanças não tem agendador. O resumo do dia, o panorama da semana, o do mês
 * e o fechamento de um bloco de registros acontecem porque esta ponte, que já
 * pergunta de tempos em tempos se há mensagem nova, avisa o backend antes de
 * perguntar. A ponte continua sem interpretar nada: ela não sabe o que venceu,
 * não monta texto e não lê tabela de domínio — só bate o relógio.
 *
 * Falhar aqui nunca pode calar a entrega. Uma mensagem que já esteja na caixa
 * precisa chegar mesmo com o backend fora do ar, então o erro é registrado e o
 * ciclo segue para a leitura.
 */

const PULSE_TIMEOUT_MS = 30_000;
const DEMO_TIMEOUT_MS = 120_000;

export type PulseResult = {
  queued: number;
  kinds: string[];
};

async function responseError(response: Response): Promise<string> {
  const text = await response.text();

  if (!text) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const body = JSON.parse(text) as { detail?: unknown };

    if (typeof body.detail === "string") {
      return body.detail;
    }
  } catch {
    // A resposta não era JSON; o texto curto abaixo ainda ajuda no diagnóstico.
  }

  return text.slice(0, 300);
}

export class BackendPulseClient {
  private readonly apiUrl: string;
  private readonly bridgeToken: string;

  constructor(config: AppConfig) {
    if (!config.financasApiUrl || !config.bridgeToken) {
      throw new Error("A configuração do pulso do Finanças está incompleta.");
    }

    this.apiUrl = config.financasApiUrl;
    this.bridgeToken = config.bridgeToken;
  }

  async pulse(): Promise<PulseResult> {
    const body = await this.post("/casa/whatsapp/pulso", PULSE_TIMEOUT_MS);
    const resultado = body as { enfileiradas?: unknown; tipos?: unknown };

    return {
      queued: typeof resultado.enfileiradas === "number" ? resultado.enfileiradas : 0,
      kinds: Array.isArray(resultado.tipos)
        ? resultado.tipos.filter((kind): kind is string => typeof kind === "string")
        : [],
    };
  }

  /** Pede ao backend um envio de demonstração, com dados assumidamente falsos. */
  async requestDemo(): Promise<boolean> {
    const body = await this.post("/casa/whatsapp/demonstracao", DEMO_TIMEOUT_MS);
    return (body as { enfileirada?: unknown }).enfileirada === true;
  }

  private async post(path: string, timeoutMs: number): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "X-Casa-Ponte": this.bridgeToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `O Finanças recusou o pulso da Casa: ${await responseError(response)}`,
      );
    }

    return (await response.json()) as unknown;
  }
}
