import { createHash } from "node:crypto";
import type { Client, Message } from "whatsapp-web.js";

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
const TIMEOUT_AUDIO_MS = 90_000;
const MAX_AUDIO_BASE64 = 12_000_000;

export type AudioRecebido = {
  nome: string;
  tipoMime: string;
  conteudoBase64: string;
};

export type EnvelopeRecebido = {
  waId: string;
  /** Sempre **quem falou**. Num grupo, o autor — nunca o jid do grupo. */
  de: string;
  texto: string | null;
  audio: AudioRecebido | null;
  conversa: "direta" | "grupo";
  grupo: string | null;
  nomeNoWhatsapp: string | null;
  enviadaEm: string | null;
};

export type Recebimento = {
  aceita: boolean;
  duplicada: boolean;
  /** Por que não virou resposta. O backend só conta à ponte, nunca ao WhatsApp. */
  motivo?: string;
};

const SUFIXO_GRUPO = "@g.us";
const SUFIXO_LID = "@lid";

/**
 * O id que o WhatsApp deu à mensagem — a trava contra reentrega do outro lado.
 *
 * `id._serialized` é o caminho normal e é o que a tipagem promete, mas ele nem
 * sempre chega preenchido no evento: quando isso acontece, o campo ia vazio e o
 * backend recusava a mensagem inteira com 422. Daí a escada.
 *
 * O último degrau é derivado, e **precisa ser determinístico**: é ele que faz a
 * reentrega da mesma mensagem cair no índice único do backend em vez de virar
 * um segundo registro. Mesma conversa, mesmo segundo e mesmo texto são a mesma
 * mensagem — um id aleatório aqui quebraria exatamente a garantia que ele existe
 * para dar.
 */
export function idDaMensagem(mensagem: Message): string {
  const id = mensagem.id as
    | { _serialized?: unknown; id?: unknown; remote?: unknown; fromMe?: unknown }
    | undefined;

  const serializado = typeof id?._serialized === "string" ? id._serialized.trim() : "";
  if (serializado) return serializado.slice(0, 120);

  const bruto = typeof id?.id === "string" ? id.id.trim() : "";
  if (bruto) {
    const remoto = typeof id?.remote === "string" ? id.remote : String(id?.remote ?? "");
    return `${id?.fromMe ? "true" : "false"}_${remoto}_${bruto}`.slice(0, 120);
  }

  const duracao = (mensagem as { duration?: unknown }).duration ?? 0;
  const digest = createHash("sha1")
    .update(
      `${mensagem.from ?? ""}|${mensagem.author ?? ""}|${mensagem.timestamp ?? 0}|` +
        `${mensagem.type ?? ""}|${duracao}|${mensagem.body ?? ""}`,
    )
    .digest("hex");
  return `derivado_${digest}`;
}

function nomeDe(mensagem: Message): string | null {
  const nome = (mensagem as { notifyName?: unknown }).notifyName;
  return typeof nome === "string" && nome.trim() !== "" ? nome.slice(0, 80) : null;
}

/**
 * O telefone de quem falou, mesmo quando o envelope não o traz.
 *
 * Contas com privacidade ligada aparecem por um **LID** (`61100221534218@lid`)
 * em vez do número. O LID engana porque tem cara de telefone — quatorze dígitos
 * passam por qualquer validação de E.164 —, e seguiria adiante como se fosse
 * uma pessoa. O pareamento nunca bateria: o número que o dono digita na tela é
 * o de verdade, e o que chegaria aqui seria outro.
 *
 * Quando o jid é um LID, o número sai do contato. Se não sair, a mensagem é
 * descartada — repassar um LID criaria identidade para um telefone inexistente.
 */
export async function numeroDeQuemFalou(
  mensagem: Message,
  jid: string | null | undefined,
  client?: Pick<Client, "getContactLidAndPhone">,
): Promise<string> {
  if (!jid?.endsWith(SUFIXO_LID)) {
    return numeroDoJid(jid);
  }

  // O caminho oficial: a própria biblioteca traduz LID em telefone. O contato
  // não serve para isto — numa conta que só se apresenta por LID, o `number`
  // dele vem vazio e o `id.user` devolve o mesmo LID de volta.
  if (client) {
    try {
      const pares = await client.getContactLidAndPhone([jid]);
      const telefone = pares?.[0]?.pn;
      if (typeof telefone === "string") {
        const digitos = telefone.replace(/\D/g, "");
        if (digitos) return digitos;
      }
    } catch {
      // Cai para o contato abaixo — melhor uma segunda tentativa do que perder
      // a mensagem por causa de uma consulta que falhou.
    }
  }

  try {
    const contato = await mensagem.getContact();
    const doContato =
      (typeof contato?.number === "string" && contato.number) ||
      (typeof contato?.id?.user === "string" && contato.id.user) ||
      "";
    const digitos = doContato.replace(/\D/g, "");
    // Se o "número" do contato é o próprio LID, ele não resolve nada.
    return digitos === numeroDoJid(jid) ? "" : digitos;
  } catch {
    // Sem número não há pessoa, e um LID no lugar dele é pior do que nada.
    return "";
  }
}

/** Só os dígitos do jid: `5511999999999@c.us` vira `5511999999999`. */
export function numeroDoJid(jid: string | null | undefined): string {
  return (jid ?? "").split("@")[0]?.replace(/\D/g, "") ?? "";
}

function extensaoDoAudio(tipoMime: string): string {
  const extensoes: Record<string, string> = {
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav",
  };
  return extensoes[tipoMime] ?? "ogg";
}

async function audioDe(mensagem: Message): Promise<AudioRecebido | null> {
  if (!mensagem.hasMedia || !["audio", "ptt"].includes(mensagem.type)) {
    return null;
  }
  const media = await mensagem.downloadMedia();
  const tipoMime = (media?.mimetype ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const conteudoBase64 = media?.data?.trim() ?? "";
  if (!tipoMime?.startsWith("audio/") || !conteudoBase64) {
    return null;
  }
  if (conteudoBase64.length > MAX_AUDIO_BASE64) {
    throw new Error("O áudio recebido ultrapassa o limite de 8 MB.");
  }
  const nomeInformado = media.filename?.trim();
  return {
    nome: (nomeInformado || `audio-whatsapp.${extensaoDoAudio(tipoMime)}`).slice(0, 160),
    tipoMime,
    conteudoBase64,
  };
}

/**
 * O envelope de uma mensagem do `whatsapp-web.js`, no formato do backend.
 *
 * Devolve `null` quando não há o que repassar — mensagem da própria conta (o
 * eco do que o agente acabou de mandar) ou sem texto nem áudio. Imagens e
 * documentos continuam fora: repassar um anexo vazio faria o backend responder
 * a uma frase que ninguém escreveu.
 */
export async function envelopeDe(
  mensagem: Message,
  client?: Pick<Client, "getContactLidAndPhone">,
): Promise<EnvelopeRecebido | null> {
  if (mensagem.fromMe) return null;

  const texto = (mensagem.body ?? "").trim();
  const audio = await audioDe(mensagem);
  if (!texto && !audio) return null;

  const conversaId = mensagem.from ?? "";
  const ehGrupo = conversaId.endsWith(SUFIXO_GRUPO);
  // Num grupo, `from` é o grupo e quem falou vem em `author`. Errar isto faz o
  // grupo inteiro parecer um desconhecido para o backend.
  const de = await numeroDeQuemFalou(
    mensagem,
    ehGrupo ? mensagem.author : conversaId,
    client,
  );
  if (!/^[1-9][0-9]{7,14}$/.test(de)) return null;

  const grupo = ehGrupo ? numeroDoJid(conversaId) : null;

  return {
    waId: idDaMensagem(mensagem),
    de,
    texto: audio ? null : texto,
    audio,
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
        audio: envelope.audio
          ? {
              nome: envelope.audio.nome,
              tipo_mime: envelope.audio.tipoMime,
              conteudo_base64: envelope.audio.conteudoBase64,
            }
          : null,
        conversa: envelope.conversa,
        grupo: envelope.grupo,
        nome_no_whatsapp: envelope.nomeNoWhatsapp,
        enviada_em: envelope.enviadaEm,
      }),
      signal: AbortSignal.timeout(envelope.audio ? TIMEOUT_AUDIO_MS : TIMEOUT_MS),
    });

    if (!resposta.ok) {
      throw new Error(
        `O Finanças recusou a mensagem recebida (${resposta.status}): ${await erroDaResposta(resposta)}`,
      );
    }

    const corpo = (await resposta.json()) as {
      aceita?: unknown;
      duplicada?: unknown;
      motivo?: unknown;
    };
    return {
      aceita: corpo.aceita === true,
      duplicada: corpo.duplicada === true,
      motivo: typeof corpo.motivo === "string" ? corpo.motivo : undefined,
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
