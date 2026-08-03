import type { Message } from "whatsapp-web.js";

import type { AppConfig } from "../config";
import { erroDaResposta } from "./http";

/**
 * O que chegou, repassado sem uma linha de interpretação.
 *
 * Este arquivo é o lugar mais tentador do projeto para pôr um `if` sobre o
 * texto — "se começar com /", "se for só um oi". **Não ponha.** A ponte
 * desembrulha o envelope e faz um POST; quem decide o que a frase significa,
 * inclusive se ela é um código de pareamento, é o backend. Um comando
 * reconhecido aqui seria uma regra de produto morando na máquina de casa.
 *
 * O que sai daqui são fatos do envelope: quem falou, onde, e o quê.
 */

const TIMEOUT_MS = 20_000;

export type EnvelopeRecebido = {
  waId: string;
  /** Sempre **quem falou**. Num grupo, o autor — nunca o jid do grupo. */
  de: string;
  texto: string;
  conversa: "direta" | "grupo";
  grupo: string | null;
  nomeNoWhatsapp: string | null;
  enviadaEm: string | null;
};

export type Recebimento = {
  aceita: boolean;
  duplicada: boolean;
};

const SUFIXO_GRUPO = "@g.us";

function nomeDe(mensagem: Message): string | null {
  const nome = (mensagem as { notifyName?: unknown }).notifyName;
  return typeof nome === "string" && nome.trim() !== "" ? nome.slice(0, 80) : null;
}

/** Só os dígitos do jid: `5511999999999@c.us` vira `5511999999999`. */
export function numeroDoJid(jid: string | null | undefined): string {
  return (jid ?? "").split("@")[0]?.replace(/\D/g, "") ?? "";
}

/**
 * O envelope de uma mensagem do `whatsapp-web.js`, no formato do backend.
 *
 * Devolve `null` quando não há o que repassar — mensagem da própria conta (o
 * eco do que o agente acabou de mandar) ou sem texto. Áudio e imagem ficam para
 * depois: repassar um anexo vazio faria o backend responder a uma frase que
 * ninguém escreveu.
 */
export function envelopeDe(mensagem: Message): EnvelopeRecebido | null {
  if (mensagem.fromMe) return null;

  const texto = (mensagem.body ?? "").trim();
  if (!texto) return null;

  const conversaId = mensagem.from ?? "";
  const ehGrupo = conversaId.endsWith(SUFIXO_GRUPO);
  // Num grupo, `from` é o grupo e quem falou vem em `author`. Errar isto faz o
  // grupo inteiro parecer um desconhecido para o backend.
  const de = numeroDoJid(ehGrupo ? mensagem.author : conversaId);
  if (!/^[1-9][0-9]{7,14}$/.test(de)) return null;

  const grupo = ehGrupo ? numeroDoJid(conversaId) : null;

  return {
    waId: mensagem.id?._serialized ?? "",
    de,
    texto,
    conversa: ehGrupo ? "grupo" : "direta",
    grupo: grupo && grupo.length >= 5 ? grupo : null,
    // O `whatsapp-web.js` entrega o nome do contato em tempo de execução, mas
    // não o declara no tipo — daí a leitura defensiva em vez de um `any`.
    nomeNoWhatsapp: nomeDe(mensagem),
    enviadaEm: mensagem.timestamp
      ? new Date(mensagem.timestamp * 1000).toISOString()
      : null,
  };
}

export class EntradaDoAgente {
  private readonly apiUrl: string;
  private readonly chave: string;

  constructor(config: AppConfig) {
    if (!config.financasApiUrl || !config.agenteChave) {
      throw new Error("A configuração da entrada do agente está incompleta.");
    }
    this.apiUrl = config.financasApiUrl;
    this.chave = config.agenteChave;
  }

  /**
   * Entrega o envelope. Os três `202` são tratados igual: anotou, seguimos.
   *
   * "aceita: false" não é erro — número não pareado, grupo não autorizado e
   * limite estourado são casos normais, e repetir não corrigiria nenhum deles.
   */
  async entregar(envelope: EnvelopeRecebido): Promise<Recebimento> {
    const resposta = await fetch(`${this.apiUrl}/whatsapp/recebidas`, {
      method: "POST",
      headers: { "X-Ponte-Chave": this.chave, "Content-Type": "application/json" },
      body: JSON.stringify({
        wa_id: envelope.waId,
        de: envelope.de,
        texto: envelope.texto,
        conversa: envelope.conversa,
        grupo: envelope.grupo,
        nome_no_whatsapp: envelope.nomeNoWhatsapp,
        enviada_em: envelope.enviadaEm,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resposta.ok) {
      throw new Error(
        `O Finanças recusou a mensagem recebida (${resposta.status}): ${await erroDaResposta(resposta)}`,
      );
    }

    const corpo = (await resposta.json()) as { aceita?: unknown; duplicada?: unknown };
    return {
      aceita: corpo.aceita === true,
      duplicada: corpo.duplicada === true,
    };
  }

  /** O relógio do canal: o backend não tem agendador, e ela é quem bate a hora. */
  async pulsar(): Promise<{ presas: number; expiradas: number }> {
    const resposta = await fetch(`${this.apiUrl}/whatsapp/pulso`, {
      method: "POST",
      headers: { "X-Ponte-Chave": this.chave, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resposta.ok) {
      throw new Error(
        `O Finanças recusou o pulso do agente: ${await erroDaResposta(resposta)}`,
      );
    }

    const corpo = (await resposta.json()) as { presas?: unknown; expiradas?: unknown };
    return {
      presas: typeof corpo.presas === "number" ? corpo.presas : 0,
      expiradas: typeof corpo.expiradas === "number" ? corpo.expiradas : 0,
    };
  }
}
