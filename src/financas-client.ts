import type { AppConfig } from "./config";

type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type SupabaseTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
};

type ContextoCasaResponse = {
  membros?: Array<{
    usuario_id?: unknown;
    nome?: unknown;
  }>;
};

type RegistroCasaRow = {
  id?: unknown;
  usuario_id?: unknown;
  atividade_nome?: unknown;
  categoria_nome?: unknown;
  ambiente_nome?: unknown;
  pontuacao_total?: unknown;
  compartilhada?: unknown;
  observacao?: unknown;
  capturada_em?: unknown;
  salva_em?: unknown;
};

export type CleaningEvent = {
  id: string;
  actorId: string;
  actorName: string;
  activityName: string;
  categoryName: string;
  roomName?: string;
  points: number;
  shared: boolean;
  note?: string;
  capturedAt: string;
  savedAt: string;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REFRESH_MARGIN_MS = 60_000;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`A resposta do Finanças não trouxe o campo obrigatório ${field}.`);
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
      error_description?: unknown;
      msg?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const detail =
      body.error_description ?? body.msg ?? body.detail ?? body.message;

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
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly email: string;
  private readonly password: string;
  private session?: AuthSession;
  private memberNames = new Map<string, string>();

  constructor(config: AppConfig) {
    if (
      !config.financesApiUrl ||
      !config.supabaseUrl ||
      !config.supabaseAnonKey ||
      !config.supabaseEmail ||
      !config.supabasePassword
    ) {
      throw new Error("A configuração do Finanças está incompleta.");
    }

    this.apiUrl = config.financesApiUrl;
    this.supabaseUrl = config.supabaseUrl;
    this.anonKey = config.supabaseAnonKey;
    this.email = config.supabaseEmail;
    this.password = config.supabasePassword;
  }

  async connect(): Promise<void> {
    await this.signIn();
    await this.loadMemberNames();
  }

  async listEventsSince(savedAt: string): Promise<CleaningEvent[]> {
    const rows: RegistroCasaRow[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${this.supabaseUrl}/rest/v1/registros_atividades_casa`);
      url.searchParams.set(
        "select",
        [
          "id",
          "usuario_id",
          "atividade_nome",
          "categoria_nome",
          "ambiente_nome",
          "pontuacao_total",
          "compartilhada",
          "observacao",
          "capturada_em",
          "salva_em",
        ].join(","),
      );
      url.searchParams.set("excluida_em", "is.null");
      url.searchParams.set("salva_em", `gte.${savedAt}`);
      url.searchParams.set("order", "salva_em.asc,id.asc");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(page * PAGE_SIZE));

      const response = await this.authorizedFetch(url);

      if (!response.ok) {
        throw new Error(
          `Não foi possível ler as atividades da Casa: ${await responseError(response)}`,
        );
      }

      const pageRows = (await response.json()) as unknown;

      if (!Array.isArray(pageRows)) {
        throw new Error("O Supabase devolveu uma lista de atividades inválida.");
      }

      rows.push(...(pageRows as RegistroCasaRow[]));

      if (pageRows.length < PAGE_SIZE) {
        return rows.map((row) => this.mapEvent(row));
      }
    }

    throw new Error(
      `Há mais de ${PAGE_SIZE * MAX_PAGES} atividades pendentes; a ponte interrompeu a leitura para não perder a posição.`,
    );
  }

  private async authorizedFetch(
    input: URL | string,
    init: RequestInit = {},
  ): Promise<Response> {
    const accessToken = await this.accessToken();
    let response = await fetch(input, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${accessToken}`,
        ...init.headers,
      },
    });

    if (response.status === 401) {
      await this.signIn();
      response = await fetch(input, {
        ...init,
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${this.session?.accessToken}`,
          ...init.headers,
        },
      });
    }

    return response;
  }

  private async accessToken(): Promise<string> {
    if (!this.session) {
      await this.signIn();
    } else if (Date.now() + REFRESH_MARGIN_MS >= this.session.expiresAt) {
      await this.refresh();
    }

    if (!this.session) {
      throw new Error("O Supabase não criou uma sessão autenticada.");
    }

    return this.session.accessToken;
  }

  private async signIn(): Promise<void> {
    const response = await fetch(
      `${this.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: this.anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: this.email,
          password: this.password,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Não foi possível entrar no Finanças: ${await responseError(response)}`,
      );
    }

    this.session = this.parseSession((await response.json()) as SupabaseTokenResponse);
  }

  private async refresh(): Promise<void> {
    if (!this.session) {
      await this.signIn();
      return;
    }

    const response = await fetch(
      `${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: this.anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: this.session.refreshToken }),
      },
    );

    if (!response.ok) {
      await this.signIn();
      return;
    }

    this.session = this.parseSession((await response.json()) as SupabaseTokenResponse);
  }

  private parseSession(body: SupabaseTokenResponse): AuthSession {
    const accessToken = requireString(body.access_token, "access_token");
    const refreshToken = requireString(body.refresh_token, "refresh_token");
    const expiresIn = Number(body.expires_in);

    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("O Supabase devolveu uma validade de sessão inválida.");
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  private async loadMemberNames(): Promise<void> {
    const response = await this.authorizedFetch(`${this.apiUrl}/casa/contexto`);

    if (!response.ok) {
      throw new Error(
        `Não foi possível identificar os moradores da Casa: ${await responseError(response)}`,
      );
    }

    const body = (await response.json()) as ContextoCasaResponse;

    if (!Array.isArray(body.membros)) {
      throw new Error("A API do Finanças devolveu um contexto da Casa inválido.");
    }

    this.memberNames = new Map(
      body.membros.map((member) => [
        requireString(member.usuario_id, "membros.usuario_id"),
        requireString(member.nome, "membros.nome"),
      ]),
    );
  }

  private mapEvent(row: RegistroCasaRow): CleaningEvent {
    const actorId = requireString(row.usuario_id, "usuario_id");
    const points = Number(row.pontuacao_total);

    if (!Number.isFinite(points)) {
      throw new Error("Uma atividade da Casa veio com pontuação inválida.");
    }

    return {
      id: requireString(row.id, "id"),
      actorId,
      actorName: this.memberNames.get(actorId) || "Alguém da casa",
      activityName: requireString(row.atividade_nome, "atividade_nome"),
      categoryName: requireString(row.categoria_nome, "categoria_nome"),
      roomName: optionalString(row.ambiente_nome),
      points,
      shared: row.compartilhada === true,
      note: optionalString(row.observacao),
      capturedAt: requireString(row.capturada_em, "capturada_em"),
      savedAt: requireString(row.salva_em, "salva_em"),
    };
  }
}
