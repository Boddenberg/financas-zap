import type { AppConfig } from "../config";
import { erroDaResposta } from "./http";

/**
 * A caixa de saída do agente — a segunda porta da ponte no Supabase.
 *
 * É irmã da caixa da Casa (`supabase-outbox-client.ts`) e igualmente burra: duas
 * RPC, campos fixos, nada do banco além disso. O que muda é o que vem dentro.
 *
 * **O endereço vem pronto.** A caixa devolve `jid`, e a ponte não monta o dela:
 * uma resposta do grupo termina em `@g.us`, e concatenar `@c.us` no telefone
 * mandaria a conversa do casal para um número que não existe. `telefone`
 * continua na resposta só pela janela de compatibilidade.
 */

export type AnexoDaCaixa = {
  nome: string;
  mime: string;
  conteudoBase64: string;
};

export type MensagemDaCaixa = {
  id: string;
  /** Para onde enviar, já pronto: `…@c.us` ou `…@g.us`. */
  jid: string;
  texto: string;
  criadaEm: string;
  anexos: AnexoDaCaixa[];
};

type LinhaDaCaixa = {
  id?: unknown;
  telefone?: unknown;
  jid?: unknown;
  mensagem?: unknown;
  anexos?: unknown;
  criada_em?: unknown;
};

function texto(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new Error(`A caixa do agente não trouxe o campo obrigatório ${campo}.`);
  }
  return valor;
}

/**
 * Um anexo só entra inteiro.
 *
 * Metade de um arquivo não é um arquivo: um item malformado é descartado com o
 * resto da lista intacto, e a mensagem chega sem ele em vez de não chegar.
 */
function anexos(valor: unknown): AnexoDaCaixa[] {
  if (!Array.isArray(valor)) return [];
  return valor.flatMap((item): AnexoDaCaixa[] => {
    const anexo = item as { nome?: unknown; mime?: unknown; conteudo_base64?: unknown };
    if (
      typeof anexo.nome !== "string" ||
      typeof anexo.mime !== "string" ||
      typeof anexo.conteudo_base64 !== "string" ||
      anexo.conteudo_base64 === ""
    ) {
      return [];
    }
    return [{ nome: anexo.nome, mime: anexo.mime, conteudoBase64: anexo.conteudo_base64 }];
  });
}

export class CaixaDoAgente {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly chave: string;

  constructor(config: AppConfig) {
    if (!config.supabaseUrl || !config.supabaseAnonKey || !config.agenteChave) {
      throw new Error("A configuração da caixa do agente está incompleta.");
    }
    this.supabaseUrl = config.supabaseUrl;
    this.anonKey = config.supabaseAnonKey;
    this.chave = config.agenteChave;
  }

  /** Uma leitura vazia no início: confirma a chave antes de o laço começar. */
  async conectar(): Promise<void> {
    await this.ler(new Date().toISOString(), []);
  }

  async ler(criadaEm: string, cursorIds: string[]): Promise<MensagemDaCaixa[]> {
    const ultimoId = [...cursorIds].sort().at(-1);
    const corpo = await this.rpc("ler_caixa_whatsapp", {
      p_chave: this.chave,
      p_depois_de: criadaEm,
      p_depois_de_id: ultimoId ?? null,
      p_limite: 50,
    });

    if (!Array.isArray(corpo)) {
      throw new Error("O Supabase devolveu uma caixa do agente inválida.");
    }

    return (corpo as LinhaDaCaixa[]).map((linha) => ({
      id: texto(linha.id, "id"),
      // `jid` é a coluna nova; o telefone só cobre o intervalo em que o backend
      // já subiu e a migration do grupo ainda não.
      jid:
        typeof linha.jid === "string" && linha.jid.trim() !== ""
          ? linha.jid
          : `${texto(linha.telefone, "telefone")}@c.us`,
      texto: texto(linha.mensagem, "mensagem"),
      criadaEm: texto(linha.criada_em, "criada_em"),
      anexos: anexos(linha.anexos),
    }));
  }

  /**
   * Diz ao backend o que aconteceu com a mensagem.
   *
   * Falha conta tentativa e a mensagem volta na leitura seguinte; na quinta o
   * backend a descarta sozinho, para uma resposta envenenada não segurar a fila
   * inteira atrás dela.
   */
  async confirmar(id: string, entregue: boolean, erro?: string): Promise<void> {
    await this.rpc("confirmar_caixa_whatsapp", {
      p_chave: this.chave,
      p_id: id,
      p_entregue: entregue,
      p_erro: erro ? erro.slice(0, 500) : null,
    });
  }

  private async rpc(funcao: string, argumentos: Record<string, unknown>): Promise<unknown> {
    const resposta = await fetch(`${this.supabaseUrl}/rest/v1/rpc/${funcao}`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(argumentos),
    });

    if (!resposta.ok) {
      throw new Error(
        `Não foi possível falar com a caixa do agente (${funcao}): ${await erroDaResposta(resposta)}`,
      );
    }

    return (await resposta.json()) as unknown;
  }
}
