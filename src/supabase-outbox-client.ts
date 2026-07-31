import type { AppConfig } from "./config";

type OutboxMessageResponse = {
  id?: unknown;
  mensagem?: unknown;
  imagem_base64?: unknown;
  imagem_nome?: unknown;
  criada_em?: unknown;
};

export type OutboxMessage = {
  id: string;
  content: string;
  createdAt: string;
  /** PNG do Analytics em base64, quando a mensagem leva imagem. */
  imageBase64?: string;
  imageName?: string;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`A caixa do WhatsApp não trouxe o campo obrigatório ${field}.`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

export class SupabaseOutboxClient {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly bridgeToken: string;

  constructor(config: AppConfig) {
    if (!config.supabaseUrl || !config.supabaseAnonKey || !config.bridgeToken) {
      throw new Error("A configuração da caixa do WhatsApp está incompleta.");
    }

    this.supabaseUrl = config.supabaseUrl;
    this.anonKey = config.supabaseAnonKey;
    this.bridgeToken = config.bridgeToken;
  }

  async connect(): Promise<void> {
    await this.listMessagesSince(new Date().toISOString(), []);
  }

  async listMessagesSince(
    createdAt: string,
    cursorIds: string[],
  ): Promise<OutboxMessage[]> {
    const url = `${this.supabaseUrl}/rest/v1/rpc/ler_mensagens_whatsapp_casa`;
    const lastCursorId = [...cursorIds].sort().at(-1);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: this.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_chave: this.bridgeToken,
        p_depois_de: createdAt,
        p_depois_de_id: lastCursorId ?? null,
        p_limite: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Não foi possível ler a caixa do WhatsApp: ${await responseError(response)}`,
      );
    }

    const body = (await response.json()) as unknown;

    if (!Array.isArray(body)) {
      throw new Error("O Supabase devolveu uma caixa do WhatsApp inválida.");
    }

    return (body as OutboxMessageResponse[]).map((message) =>
      this.mapMessage(message),
    );
  }

  /**
   * Devolve ao Finanças o que aconteceu com a mensagem.
   *
   * Sem isso a caixa de saída não sabe distinguir "entregue" de "ainda não
   * tentei", e uma mensagem que o WhatsApp recusa ficaria sendo reoferecida
   * para sempre, segurando a fila atrás dela. O backend conta as tentativas e
   * descarta a que não tem conserto.
   */
  async confirmDelivery(
    messageId: string,
    delivered: boolean,
    failure?: string,
  ): Promise<void> {
    const url = `${this.supabaseUrl}/rest/v1/rpc/confirmar_mensagem_whatsapp_casa`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: this.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_chave: this.bridgeToken,
        p_id: messageId,
        p_entregue: delivered,
        p_erro: failure ? failure.slice(0, 500) : null,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Não foi possível registrar a entrega no Finanças: ${await responseError(response)}`,
      );
    }
  }

  private mapMessage(message: OutboxMessageResponse): OutboxMessage {
    return {
      id: requireString(message.id, "id"),
      content: requireString(message.mensagem, "mensagem"),
      createdAt: requireString(message.criada_em, "criada_em"),
      imageBase64: optionalString(message.imagem_base64),
      imageName: optionalString(message.imagem_nome),
    };
  }
}
