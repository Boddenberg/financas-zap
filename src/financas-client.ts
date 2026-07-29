import type { AppConfig } from "./config";

type CleaningEventResponse = {
  id?: unknown;
  criado_por_nome?: unknown;
  atividade_nome?: unknown;
  ambiente_nome?: unknown;
  pontuacao_total?: unknown;
  compartilhada?: unknown;
  salva_em?: unknown;
};

type CleaningEventsPage = {
  eventos?: unknown;
  tem_mais?: unknown;
};

export type CleaningEvent = {
  id: string;
  actorName: string;
  activityName: string;
  roomName?: string;
  points: number;
  shared: boolean;
  savedAt: string;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`A ponte da Casa não trouxe o campo obrigatório ${field}.`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();

  if (!text) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const body = JSON.parse(text) as {
      detail?: unknown;
      message?: unknown;
    };
    const detail = body.detail ?? body.message;

    if (typeof detail === "string") {
      return detail;
    }

    if (detail) {
      return JSON.stringify(detail);
    }
  } catch {
    // A resposta não era JSON; o texto curto abaixo ainda ajuda no diagnóstico.
  }

  return text.slice(0, 500);
}

export class FinancasClient {
  private readonly apiUrl: string;
  private readonly bridgeToken: string;

  constructor(config: AppConfig) {
    if (!config.financesApiUrl || !config.financesBridgeToken) {
      throw new Error("A configuração da ponte do Finanças está incompleta.");
    }

    this.apiUrl = config.financesApiUrl;
    this.bridgeToken = config.financesBridgeToken;
  }

  async connect(): Promise<void> {
    await this.listEventsSince(new Date().toISOString(), []);
  }

  async listEventsSince(
    savedAt: string,
    cursorIds: string[],
  ): Promise<CleaningEvent[]> {
    const url = new URL(`${this.apiUrl}/casa/ponte-whatsapp/eventos`);
    url.searchParams.set("depois_de", savedAt);
    url.searchParams.set("limite", "500");
    const lastCursorId = [...cursorIds].sort().at(-1);

    if (lastCursorId) {
      url.searchParams.set("depois_de_id", lastCursorId);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Não foi possível ler as limpezas da Casa: ${await responseError(response)}`,
      );
    }

    const body = (await response.json()) as CleaningEventsPage;

    if (!Array.isArray(body.eventos)) {
      throw new Error("A API do Finanças devolveu um feed da Casa inválido.");
    }

    return (body.eventos as CleaningEventResponse[]).map((event) =>
      this.mapEvent(event),
    );
  }

  private mapEvent(event: CleaningEventResponse): CleaningEvent {
    const points = Number(event.pontuacao_total);

    if (!Number.isFinite(points)) {
      throw new Error("Uma limpeza da Casa veio com pontuação inválida.");
    }

    return {
      id: requireString(event.id, "id"),
      actorName: requireString(event.criado_por_nome, "criado_por_nome"),
      activityName: requireString(event.atividade_nome, "atividade_nome"),
      roomName: optionalString(event.ambiente_nome),
      points,
      shared: event.compartilhada === true,
      savedAt: requireString(event.salva_em, "salva_em"),
    };
  }
}
