import { createHash } from "node:crypto";
import { Client, MessageMedia } from "whatsapp-web.js";

import type { AppConfig } from "../config";
import { advanceCursor, isAfterCursor, StateStore } from "../state-store";
import type { AnexoDaCaixa, CaixaDoAgente, MensagemDaCaixa } from "./caixa";
import type { EntradaDoAgente } from "./entrada";

function destinoParaLog(jid: string): string {
  return createHash("sha256").update(jid).digest("hex").slice(0, 16);
}

/**
 * O laço do canal de conversa: pulso, leitura, entrega, confirmação, cursor.
 *
 * É o mesmo desenho do monitor da Casa, com duas diferenças que vêm de o canal
 * ser uma **conversa** e não um aviso:
 *
 * - **o ritmo muda.** Quando alguém está esperando resposta, 2 segundos; parado,
 *   60. O agente pode dar três voltas de leitura numa pergunta funda, e com um
 *   poll fixo a pessoa esperaria minutos por uma frase. Isto é a única
 *   esperteza da ponte, e ela é sobre transporte — não sobre conteúdo. O ritmo
 *   parado era 15 segundos e subiu para 60 em 24/09/2026: cada volta pulsa o
 *   backend, que varre todos os módulos, e isso sozinho estourou a cota de
 *   saída do Supabase com o hub em silêncio;
 * - **o endereço vem pronto.** A caixa devolve `jid`, e é para ele que se envia.
 */

const ESPERA_MAXIMA_MS = 2 * 60 * 1000;

export class MonitorDoAgente {
  private aguardando = 0;
  private aguardandoDesde = 0;
  private readonly enderecos = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly caixa: CaixaDoAgente,
    private readonly entrada: EntradaDoAgente,
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  /**
   * Uma pergunta acabou de ser aceita pelo backend.
   *
   * Marca o relógio junto: um contador que só sobe deixaria a ponte em 2s para
   * sempre se uma resposta nunca chegasse — e isso é bateria de uma máquina que
   * fica ligada o dia inteiro.
   */
  aguardarResposta(): void {
    this.aguardando += 1;
    this.aguardandoDesde = Date.now();
  }

  private get intervalo(): number {
    if (this.aguardando > 0 && Date.now() - this.aguardandoDesde > ESPERA_MAXIMA_MS) {
      // A resposta não veio no tempo de nenhuma pergunta razoável. Provavelmente
      // o backend a ignorou (número não pareado, limite); voltar ao ritmo lento.
      this.aguardando = 0;
    }
    return this.aguardando > 0
      ? this.config.agentePollAtivoMs
      : this.config.agentePollParadoMs;
  }

  async rodar(sinal: AbortSignal): Promise<void> {
    while (!sinal.aborted) {
      try {
        await this.bater();
      } catch (erro) {
        // Uma volta sem rede não pode encerrar o canal. Em 30/09/2026 um
        // "fetch failed" aqui derrubou a ponte inteira às 05:51, e o que ficou
        // de pé foi um processo sem WhatsApp que o agendador nunca reiniciou.
        console.error(`Falha ao consultar ou entregar a caixa do agente: ${texto(erro)}`);
      }
      await this.dormir(this.intervalo, sinal);
    }
  }

  /** Uma passada: o relógio, a caixa e o que estiver pendente. */
  async bater(): Promise<number> {
    await this.pulsar();
    return this.entregarPendentes();
  }

  private async pulsar(): Promise<void> {
    try {
      await this.entrada.pulsar();
    } catch (erro) {
      // Falhar no pulso nunca cala a entrega: o que já está na caixa chega
      // mesmo com o backend fora do ar.
      console.error(`Falha ao avisar o Finanças do horário (agente): ${texto(erro)}`);
    }
  }

  /**
   * O cursor só passa por cima do que **foi entregue**.
   *
   * Antes ele avançava de qualquer jeito, e o efeito era o contrário do que o
   * `confirmar(entregue=false)` promete: a mensagem continuava `pendente` no
   * banco, mas a leitura seguinte pede `criada_em > cursor` e nunca mais a
   * traria. Ela ficava pendurada para sempre, sem ninguém para reentregá-la.
   *
   * Parar na primeira falha é a outra metade da mesma decisão. É ela que dá
   * sentido ao teto de cinco tentativas do backend: uma resposta envenenada
   * segura a fila atrás dela por algumas voltas e então é descartada sozinha.
   * Pular por cima manteria a ordem da conversa quebrada — a resposta de uma
   * pergunta chegando depois da resposta da seguinte.
   */
  private async entregarPendentes(): Promise<number> {
    const estado = await this.store.loadOrCreate();
    let entregues = 0;

    for (const mensagem of await this.caixa.ler(estado.cursorAt, estado.cursorIds)) {
      if (!isAfterCursor(estado, { id: mensagem.id, createdAt: mensagem.criadaEm })) {
        continue;
      }
      if (!(await this.enviar(mensagem))) {
        break;
      }
      entregues += 1;
      this.aguardando = Math.max(0, this.aguardando - 1);
      advanceCursor(estado, { id: mensagem.id, createdAt: mensagem.criadaEm });
      await this.store.save(estado);
    }

    return entregues;
  }

  private async enviar(mensagem: MensagemDaCaixa): Promise<boolean> {
    try {
      await this.despachar(mensagem);
    } catch (erro) {
      const motivo = texto(erro);
      console.error(`Falha ao entregar a resposta ${mensagem.id}: ${motivo}`);
      // O endereço guardado pode ser a causa; a próxima tentativa o refaz.
      this.enderecos.delete(mensagem.jid);
      try {
        await this.caixa.confirmar(mensagem.id, false, motivo);
      } catch (falha) {
        console.error(`Falha ao registrar a tentativa: ${texto(falha)}`);
      }
      return false;
    }

    // Depois que o WhatsApp aceitou, uma falha do Supabase não autoriza um
    // segundo envio. O cursor local avança e a confirmação fica como falha de
    // observabilidade; reenviar criaria duas notificações iguais no celular.
    try {
      await this.caixa.confirmar(mensagem.id, true);
    } catch (erro) {
      console.error(
        `Resposta ${mensagem.id} entregue, mas não confirmada no Finanças: ${texto(erro)}`,
      );
    }
    console.log(
      `Resposta ${mensagem.id} entregue em destino_hash=${destinoParaLog(mensagem.jid)}` +
        `${mensagem.anexos.length ? ` com ${mensagem.anexos.length} anexo(s)` : ""}.`,
    );
    return true;
  }

  /**
   * O texto e os arquivos, na ordem que cada tipo de anexo aceita.
   *
   * **Imagem tem legenda; documento não.** A arte da Casa vai com o texto na
   * legenda de propósito: duas mensagens chegariam como duas notificações, e a
   * segunda descolaria da primeira em qualquer conversa movimentada.
   *
   * Com PDF isso não funciona. O WhatsApp guarda a legenda de um documento no
   * protocolo mas não a exibe — a bolha mostra o nome do arquivo e nada mais.
   * Mandar a frase ali é perdê-la: a pessoa recebe três PDFs sem uma linha
   * dizendo o que são. Então, quando o primeiro anexo é documento, o texto vai
   * primeiro, sozinho, e os arquivos vêm logo atrás.
   */
  private async despachar(original: MensagemDaCaixa): Promise<void> {
    const mensagem = { ...original, jid: await this.endereco(original.jid) };
    const [primeiro, ...demais] = mensagem.anexos;

    if (!primeiro) {
      await this.client.sendMessage(mensagem.jid, mensagem.texto, {
        waitUntilMsgSent: true,
      });
      return;
    }

    // O cartão animado do Huntera: o vídeo curto vai como GIF (toca sozinho,
    // em loop, sem som) e a foto atrás dele é a reserva — só sai se o vídeo
    // não sair. O WhatsApp Web já quebrou mídia uma vez (17/09/2026).
    if (ehVideo(primeiro)) {
      const reserva = demais.find(ehImagem);
      try {
        // Vídeo que trava (já aconteceu com versões do WhatsApp Web) não pode
        // segurar a fila inteira: passado o limite, vai a foto.
        await comLimite(
          this.enviarAnexo(mensagem.jid, primeiro, legendaDe(mensagem.texto), true),
          VIDEO_LIMITE_MS,
        );
      } catch (erro) {
        if (!reserva) throw erro;
        console.warn(`O vídeo da resposta ${mensagem.id} não saiu (${texto(erro)}); vai a foto.`);
        await this.enviarAnexo(mensagem.jid, reserva, legendaDe(mensagem.texto));
      }
      return;
    }

    if (ehImagem(primeiro)) {
      await this.enviarAnexo(mensagem.jid, primeiro, legendaDe(mensagem.texto));
      for (const anexo of demais) {
        await this.enviarAnexo(mensagem.jid, anexo);
      }
      return;
    }

    await this.client.sendMessage(mensagem.jid, mensagem.texto, {
      waitUntilMsgSent: true,
    });
    for (const anexo of mensagem.anexos) {
      await this.enviarAnexo(mensagem.jid, anexo);
    }
  }

  /**
   * O endereço de uma pessoa como o WhatsApp o registrou.
   *
   * Quem escreveu para a ponte já chega com o endereço certo, mas um número
   * digitado (o amigo que recebe os drops do V-idle) pode estar registrado sem
   * o nono dígito — celular de antes de 2012 —, e enviar para a grafia errada
   * trava a fila atrás dele. Grupo passa direto. Se a consulta falhar, vai
   * como veio: é o mesmo envio de antes, e o servidor diz se o destino existe.
   */
  private async endereco(jid: string): Promise<string> {
    if (!jid.endsWith("@c.us")) return jid;
    const guardado = this.enderecos.get(jid);
    if (guardado) return guardado;
    const numero = jid.slice(0, -"@c.us".length);
    const lid = await this.lidDeQuemNuncaFalou(numero);
    if (lid) {
      console.log(`Número que o chip nunca viu: vai pelo LID (destino_hash=${destinoParaLog(jid)}).`);
      this.enderecos.set(jid, lid);
      return lid;
    }
    try {
      const registrado = (await this.client.getNumberId(numero))?._serialized;
      if (registrado) {
        this.enderecos.set(jid, registrado);
        return registrado;
      }
    } catch {
      // Algumas versões do WhatsApp Web quebram a consulta; o envio direto segue.
    }
    return jid;
  }

  /**
   * O LID de um número que este WhatsApp nunca viu, com o par gravado.
   *
   * O WhatsApp passou a endereçar as pessoas por um identificador interno, o
   * LID, e o envio só sai quando o WhatsApp Web tem gravado o **par** número ↔
   * LID. Ele tem o de quem já conversou com o chip; para os outros, o
   * `sendMessage` do whatsapp-web.js 1.34.7 morre em "No LID for user". Foi o
   * que calou o código de confirmação do Huntrack para todo cliente novo entre
   * 06 e 08/10/2026: cinco tentativas, descarte, e a fila inteira parada cinco
   * minutos atrás de cada um. A biblioteca não tem correção (issue #3834).
   *
   * Saber o LID não basta: a primeira versão desta correção mandava para o
   * `…@lid` sem o par e caiu no mesmo erro. Primeiro vai a consulta do próprio
   * WhatsApp Web (a do `getNumberId`), que nas versões de outubro de 2026 grava
   * o par; se ele não ficar, a ponte o grava como o WhatsApp Web faz, a partir
   * da sincronização de contatos. `null` quando o número já é conhecido (o
   * caminho de sempre funciona), quando não está no WhatsApp ou quando a
   * consulta não existe nesta versão — aí o envio segue como antes, e o motivo
   * aparece no diário.
   */
  private async lidDeQuemNuncaFalou(numero: string): Promise<string | null> {
    const pagina = this.client.pupPage;
    if (!pagina) return null;
    try {
      return await pagina.evaluate(async (numero: string) => {
        const wa = window as unknown as { require(modulo: string): any };
        const contatos = wa.require("WAWebApiContact");
        const wid = wa.require("WAWebWidFactory").createWid(`${numero}@c.us`);
        if (contatos.getCurrentLid(wid)) return null;

        const existe = (await wa.require("WAWebQueryExistsJob").queryWidExists(wid))?.wid;
        if (!existe) return null;
        const lid = existe.server === "lid" ? existe : contatos.getCurrentLid(existe);
        if (lid && contatos.getPhoneNumber(lid)) return `${lid.user}@lid`;

        const achado = (
          await wa.require("WAWebContactSyncUtils")
            .constructUsyncDeltaQuery([{ type: "add", phoneNumber: numero }])
            .execute()
        )?.list?.[0];
        if (achado?.id?.server !== "lid" || !achado.pn) return null;
        await wa.require("WAWebDBCreateLidPnMappings").createLidPnMappings({
          mappings: [{ pn: achado.pn, lid: achado.id }],
          flushImmediately: true,
          learningSource: "usync",
        });
        return contatos.getPhoneNumber(achado.id) ? `${achado.id.user}@lid` : null;
      }, numero);
    } catch (erro) {
      console.warn(`Não deu para gravar o LID de um número novo: ${texto(erro)}`);
      return null;
    }
  }

  private async enviarAnexo(
    jid: string,
    anexo: AnexoDaCaixa,
    legenda?: string,
    comoGif = false,
  ): Promise<void> {
    await this.client.sendMessage(
      jid,
      new MessageMedia(anexo.mime, anexo.conteudoBase64, anexo.nome),
      {
        waitUntilMsgSent: true,
        ...(legenda === undefined ? {} : { caption: legenda }),
        ...(comoGif ? { sendVideoAsGif: true } : { sendMediaAsDocument: !ehImagem(anexo) }),
      },
    );
  }

  private dormir(ms: number, sinal: AbortSignal): Promise<void> {
    return new Promise((resolver) => {
      const relogio = setTimeout(pronto, ms);
      sinal.addEventListener("abort", pronto, { once: true });

      function pronto() {
        clearTimeout(relogio);
        sinal.removeEventListener("abort", pronto);
        resolver();
      }
    });
  }
}

function texto(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function ehImagem(anexo: AnexoDaCaixa): boolean {
  return anexo.mime.startsWith("image/");
}

const VIDEO_LIMITE_MS = 90_000;

function comLimite<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_, recusar) => {
    relogio = setTimeout(() => recusar(new Error(`O WhatsApp não mandou o vídeo em ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promessa, estouro]).finally(() => clearTimeout(relogio));
}

function ehVideo(anexo: AnexoDaCaixa): boolean {
  return anexo.mime === "video/mp4";
}

/**
 * A legenda de uma imagem, ou nenhuma. O banco pede ao menos um caractere de
 * texto, então uma foto que é a mensagem inteira (o cartão do fim de caçada do
 * Huntera) chega com um espaço de largura zero: legenda feita só disso fica de
 * fora, em vez de uma linha em branco embaixo da imagem.
 */
function legendaDe(texto: string): string | undefined {
  return texto.replace(/[\s​-‍⁠﻿]/g, "") ? texto : undefined;
}
