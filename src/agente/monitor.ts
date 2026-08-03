import { Client, MessageMedia } from "whatsapp-web.js";

import type { AppConfig } from "../config";
import { advanceCursor, isAfterCursor, StateStore } from "../state-store";
import type { AnexoDaCaixa, CaixaDoAgente, MensagemDaCaixa } from "./caixa";
import type { EntradaDoAgente } from "./entrada";

/**
 * O laço do canal de conversa: pulso, leitura, entrega, confirmação, cursor.
 *
 * É o mesmo desenho do monitor da Casa, com duas diferenças que vêm de o canal
 * ser uma **conversa** e não um aviso:
 *
 * - **o ritmo muda.** Quando alguém está esperando resposta, 2 segundos; parado,
 *   15. O agente pode dar três voltas de leitura numa pergunta funda, e com um
 *   poll fixo de 15s a pessoa esperaria até trinta por uma frase. Isto é a única
 *   esperteza da ponte, e ela é sobre transporte — não sobre conteúdo;
 * - **o endereço vem pronto.** A caixa devolve `jid`, e é para ele que se envia.
 */

const ESPERA_MAXIMA_MS = 2 * 60 * 1000;

export class MonitorDoAgente {
  private aguardando = 0;
  private aguardandoDesde = 0;

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
      await this.bater();
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
      await this.caixa.confirmar(mensagem.id, true);
      console.log(
        `Resposta ${mensagem.id} entregue em ${mensagem.jid}` +
          `${mensagem.anexos.length ? ` com ${mensagem.anexos.length} anexo(s)` : ""}.`,
      );
      return true;
    } catch (erro) {
      const motivo = texto(erro);
      console.error(`Falha ao entregar a resposta ${mensagem.id}: ${motivo}`);
      try {
        await this.caixa.confirmar(mensagem.id, false, motivo);
      } catch (falha) {
        console.error(`Falha ao registrar a tentativa: ${texto(falha)}`);
      }
      return false;
    }
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
  private async despachar(mensagem: MensagemDaCaixa): Promise<void> {
    const [primeiro, ...demais] = mensagem.anexos;

    if (!primeiro) {
      await this.client.sendMessage(mensagem.jid, mensagem.texto, {
        waitUntilMsgSent: true,
      });
      return;
    }

    if (ehImagem(primeiro)) {
      await this.enviarAnexo(mensagem.jid, primeiro, mensagem.texto);
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

  private async enviarAnexo(
    jid: string,
    anexo: AnexoDaCaixa,
    legenda?: string,
  ): Promise<void> {
    await this.client.sendMessage(
      jid,
      new MessageMedia(anexo.mime, anexo.conteudoBase64, anexo.nome),
      {
        waitUntilMsgSent: true,
        ...(legenda === undefined ? {} : { caption: legenda }),
        sendMediaAsDocument: !ehImagem(anexo),
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
