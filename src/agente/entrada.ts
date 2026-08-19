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
const TIMEOUT_MIDIA_MS = 90_000;
const MAX_AUDIO_BASE64 = 12_000_000;
const MAX_IMAGEM_BYTES = 10 * 1024 * 1024;
const ESPERAS_DOWNLOAD_IMAGEM_MS = [600, 1_200, 2_500, 5_000, 8_000, 12_000, 15_000];
const TENTATIVAS_DOWNLOAD_IMAGEM = ESPERAS_DOWNLOAD_IMAGEM_MS.length + 1;
const AVISO_IMAGEM_INDISPONIVEL =
  "Não consegui abrir essa foto agora. Tenta reenviar uma vez? " +
  "O compromisso continua aqui.";
const AVISO_IMAGEM_REPETIDAMENTE_INDISPONIVEL =
  "Essa foto continua sem abrir aqui. Não precisa reenviar de novo agora — " +
  "tente outra imagem ou mais tarde.";
const JANELA_FALHAS_IMAGEM_MS = 15 * 60 * 1_000;

type ClienteDaEntrada = Partial<
  Pick<Client, "getContactLidAndPhone" | "getMessageById" | "sendMessage">
>;
type Esperar = (milissegundos: number) => Promise<void>;

const esperar: Esperar = async (milissegundos) => {
  await new Promise<void>((resolver) => setTimeout(resolver, milissegundos));
};

export class FalhaAoBaixarImagemWhatsapp extends Error {
  constructor(detalhe: string) {
    super(
      `Não foi possível baixar a imagem recebida após ${TENTATIVAS_DOWNLOAD_IMAGEM} tentativas: ${detalhe}`,
    );
    this.name = "FalhaAoBaixarImagemWhatsapp";
  }
}

export class FalhasRecentesImagem {
  private readonly falhas = new Map<string, { quantidade: number; ultimaEm: number }>();

  registrar(chave: string, agora = Date.now()): number {
    const anterior = this.falhas.get(chave);
    const quantidade =
      anterior && agora - anterior.ultimaEm <= JANELA_FALHAS_IMAGEM_MS
        ? anterior.quantidade + 1
        : 1;
    this.falhas.set(chave, { quantidade, ultimaEm: agora });
    return quantidade;
  }

  limpar(chave: string): void {
    this.falhas.delete(chave);
  }
}

export type AudioRecebido = {
  nome: string;
  tipoMime: string;
  conteudoBase64: string;
};

export type ImagemRecebida = {
  nome: string;
  tipoMime: "image/jpeg" | "image/png" | "image/webp";
  conteudoBase64: string;
  legenda: string | null;
};

export type EnvelopeRecebido = {
  waId: string;
  /** Sempre **quem falou**. Num grupo, o autor — nunca o jid do grupo. */
  de: string;
  texto: string | null;
  audio: AudioRecebido | null;
  imagem: ImagemRecebida | null;
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
    | {
        _serialized?: unknown;
        $1?: unknown;
        id?: unknown;
        remote?: unknown;
        fromMe?: unknown;
      }
    | undefined;

  const serializado =
    (typeof id?._serialized === "string" && id._serialized.trim()) ||
    (typeof id?.$1 === "string" && id.$1.trim()) ||
    "";
  if (serializado) {
    normalizarIdParaBiblioteca(id, serializado);
    return serializado.slice(0, 120);
  }

  const bruto = typeof id?.id === "string" ? id.id.trim() : "";
  if (bruto) {
    const remoto = typeof id?.remote === "string" ? id.remote : String(id?.remote ?? "");
    const reconstruido = `${id?.fromMe ? "true" : "false"}_${remoto}_${bruto}`;
    normalizarIdParaBiblioteca(id, reconstruido);
    return reconstruido.slice(0, 120);
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

export function idDaMensagemParaLog(mensagem: Message): string {
  const bruto = (mensagem.id as { id?: unknown } | undefined)?.id;
  if (typeof bruto === "string" && bruto.trim()) return bruto.trim().slice(0, 80);
  return createHash("sha256").update(idDaMensagem(mensagem)).digest("hex").slice(0, 16);
}

export function conversaParaLog(conversa: string): string {
  return createHash("sha256").update(conversa).digest("hex").slice(0, 16);
}

function normalizarIdParaBiblioteca(
  id:
    | { _serialized?: unknown; id?: unknown; remote?: unknown; fromMe?: unknown }
    | undefined,
  serializado: string,
): void {
  if (!id || (typeof id._serialized === "string" && id._serialized)) return;
  // Em julho de 2026 o WhatsApp Web renomeou este campo para `$1`. A versão
  // atual do whatsapp-web.js ainda consulta `_serialized` em downloadMedia();
  // recolocá-lo no objeto preserva a API da biblioteca sem mexer em node_modules.
  try {
    Object.defineProperty(id, "_serialized", {
      value: serializado,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Um id congelado continua tendo o valor devolvido para a idempotência; o
    // download registrará a falha exata em vez de esconder este caso.
  }
}

function detalheDoErro(erro: unknown): string {
  if (erro instanceof Error) return `${erro.name}: ${erro.message}`;
  return String(erro);
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
  client?: Partial<Pick<Client, "getContactLidAndPhone">>,
): Promise<string> {
  if (!jid?.endsWith(SUFIXO_LID)) {
    return numeroDoJid(jid);
  }

  // O caminho oficial: a própria biblioteca traduz LID em telefone. O contato
  // não serve para isto — numa conta que só se apresenta por LID, o `number`
  // dele vem vazio e o `id.user` devolve o mesmo LID de volta.
  if (client?.getContactLidAndPhone) {
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

const EXTENSAO_IMAGEM: Record<ImagemRecebida["tipoMime"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

async function baixarImagem(
  mensagem: Message,
  client: ClienteDaEntrada | undefined,
  aguardar: Esperar,
) {
  let ultimaFalha: unknown;
  let mensagemAtual = mensagem;
  const waId = idDaMensagem(mensagem);
  const messageIdLog = idDaMensagemParaLog(mensagem);

  for (let tentativa = 1; tentativa <= TENTATIVAS_DOWNLOAD_IMAGEM; tentativa += 1) {
    try {
      idDaMensagem(mensagemAtual);
      const media = await mensagemAtual.downloadMedia();
      if (media) {
        console.log(
          `whatsapp_media_download message_id=${messageIdLog} tentativa=${tentativa} resultado=sucesso mime=${media.mimetype} base64_chars=${media.data?.length ?? 0}`,
        );
        return media;
      }
      ultimaFalha = new Error("o WhatsApp devolveu a imagem vazia");
    } catch (erro) {
      ultimaFalha = erro;
    }
    console.warn(
      `whatsapp_media_download message_id=${messageIdLog} tentativa=${tentativa} resultado=falha etapa=downloadMedia erro=${detalheDoErro(ultimaFalha)}`,
    );

    if (tentativa < TENTATIVAS_DOWNLOAD_IMAGEM) {
      await aguardar(ESPERAS_DOWNLOAD_IMAGEM_MS[tentativa - 1] ?? 15_000);

      // O objeto emitido pelo evento pode continuar apontando para o estágio
      // inicial da mídia. Reabrir a mensagem pelo id traz o modelo que o
      // WhatsApp Web atualizou enquanto esperávamos.
      if (waId && client?.getMessageById) {
        try {
          mensagemAtual = await client.getMessageById(waId);
        } catch {
          // A consulta é uma ajuda, não uma nova condição: a mensagem original
          // ainda pode conseguir baixar na tentativa seguinte.
        }
      }
    }
  }
  const detalhe = detalheDoErro(ultimaFalha);
  throw new FalhaAoBaixarImagemWhatsapp(detalhe);
}

function base64Valido(conteudo: string): Buffer | null {
  const limpo = conteudo.replace(/\s/g, "");
  if (!limpo || !/^[A-Za-z0-9+/]*={0,2}$/.test(limpo) || limpo.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(limpo, "base64");
  const normalizado = bytes.toString("base64").replace(/=+$/, "");
  return normalizado === limpo.replace(/=+$/, "") ? bytes : null;
}

async function imagemDe(
  mensagem: Message,
  legenda: string,
  client: ClienteDaEntrada | undefined,
  aguardar: Esperar,
): Promise<ImagemRecebida | null> {
  if (!mensagem.hasMedia || mensagem.type !== "image") {
    return null;
  }
  const media = await baixarImagem(mensagem, client, aguardar);
  const [tipoBruto = ""] = media.mimetype.split(";", 1);
  const tipo = tipoBruto.trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(tipo)) {
    throw new Error("O formato da imagem recebida não é suportado.");
  }
  const conteudoBase64 = media.data.trim();
  const bytes = base64Valido(conteudoBase64);
  if (!bytes) {
    throw new Error("A imagem recebida está corrompida.");
  }
  if (bytes.length > MAX_IMAGEM_BYTES) {
    throw new Error("A imagem recebida ultrapassa o limite de 10 MB.");
  }
  const tipoMime = tipo as ImagemRecebida["tipoMime"];
  const nomeInformado = media.filename?.trim();
  return {
    nome: (
      nomeInformado || `imagem-whatsapp.${EXTENSAO_IMAGEM[tipoMime]}`
    ).slice(0, 160),
    tipoMime,
    conteudoBase64,
    legenda: legenda || null,
  };
}

/**
 * O envelope de uma mensagem do `whatsapp-web.js`, no formato do backend.
 *
 * Devolve `null` quando não há o que repassar — mensagem da própria conta (o
 * eco do que o agente acabou de mandar) ou sem texto, áudio nem imagem.
 * Documentos continuam fora. A ponte relata a imagem e a legenda; não decide
 * se ela é pendência, ocorrência, recibo ou documento.
 */
export async function envelopeDe(
  mensagem: Message,
  client?: ClienteDaEntrada,
  aguardar: Esperar = esperar,
): Promise<EnvelopeRecebido | null> {
  if (mensagem.fromMe) return null;
  // Corrige o identificador antes de áudio ou imagem chamarem downloadMedia().
  const waId = idDaMensagem(mensagem);

  const texto = (mensagem.body ?? "").trim();
  const audio = await audioDe(mensagem);
  const imagem = await imagemDe(mensagem, texto, client, aguardar);
  if (!texto && !audio && !imagem) return null;

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
    waId,
    de,
    texto: audio || imagem ? null : texto,
    audio,
    imagem,
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

/**
 * Dá um desfecho visível quando nem a espera longa recuperou os bytes.
 *
 * Esta frase pertence ao transporte: não tenta interpretar a foto nem altera
 * o assunto salvo no backend. Assim, o reenvio seguinte ainda encontra o
 * compromisso que estava aguardando a capa.
 */
export async function avisarImagemIndisponivel(
  client: ClienteDaEntrada,
  mensagem: Message,
  repetida = false,
): Promise<void> {
  const destino = mensagem.from?.trim();
  if (!destino || !client.sendMessage) {
    throw new Error("Não foi possível identificar onde avisar sobre a foto.");
  }
  await client.sendMessage(
    destino,
    repetida
      ? AVISO_IMAGEM_REPETIDAMENTE_INDISPONIVEL
      : AVISO_IMAGEM_INDISPONIVEL,
    {
      waitUntilMsgSent: true,
    },
  );
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
        imagem: envelope.imagem
          ? {
              nome: envelope.imagem.nome,
              tipo_mime: envelope.imagem.tipoMime,
              conteudo_base64: envelope.imagem.conteudoBase64,
              legenda: envelope.imagem.legenda,
            }
          : null,
        conversa: envelope.conversa,
        grupo: envelope.grupo,
        nome_no_whatsapp: envelope.nomeNoWhatsapp,
        enviada_em: envelope.enviadaEm,
      }),
      signal: AbortSignal.timeout(
        envelope.audio || envelope.imagem ? TIMEOUT_MIDIA_MS : TIMEOUT_MS,
      ),
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
