import type { BackendPulseClient } from "./backend-pulse";
import type { AppConfig } from "./config";
import type {
  OutboxMessage,
  SupabaseOutboxClient,
} from "./supabase-outbox-client";
import {
  advanceCursor,
  isAfterCursor,
  type BridgeState,
  type StateStore,
} from "./state-store";
import {
  sendAndWaitForServerAcknowledgement,
  type Delivery,
  type WhatsAppDestination,
} from "./whatsapp-client";
import type { Client } from "whatsapp-web.js";

export function contentForDelivery(message: OutboxMessage): Delivery {
  return {
    text: message.content,
    imageBase64: message.imageBase64,
    imageName: message.imageName,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);

    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

export class MessageMonitor {
  constructor(
    private readonly whatsapp: Client,
    private readonly outbox: SupabaseOutboxClient,
    private readonly destinations: WhatsAppDestination[],
    private readonly store: StateStore,
    private readonly config: AppConfig,
    private readonly pulse?: BackendPulseClient,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const state = await this.store.loadOrCreate();
    console.log(
      `Monitorando a caixa do WhatsApp a partir de ${new Date(state.cursorAt).toLocaleString(
        "pt-BR",
        { timeZone: this.config.timeZone },
      )}.`,
    );

    while (!signal.aborted) {
      await this.beatTheClock();

      try {
        const sent = await this.processAvailable(state);

        if (sent > 0) {
          console.log(
            `${sent} ${sent === 1 ? "mensagem entregue" : "mensagens entregues"} pelo WhatsApp.`,
          );
        }
      } catch (error) {
        console.error(
          `Falha ao consultar ou entregar a caixa do WhatsApp: ${errorText(error)}`,
        );
      }

      await wait(this.config.pollIntervalMs, signal);
    }
  }

  /**
   * Avisa o Finanças que o tempo passou, antes de perguntar o que há para
   * entregar. É o que dá hora ao resumo diário e aos panoramas — mas nunca é
   * condição para entregar: uma mensagem já enfileirada precisa chegar mesmo
   * com o backend fora do ar.
   */
  private async beatTheClock(): Promise<void> {
    if (!this.pulse) {
      return;
    }

    try {
      const { queued, kinds } = await this.pulse.pulse();

      if (queued > 0) {
        console.log(
          `O Finanças fechou ${queued} ${queued === 1 ? "mensagem" : "mensagens"} (${kinds.join(", ")}).`,
        );
      }
    } catch (error) {
      console.error(`Falha ao avisar o Finanças do horário: ${errorText(error)}`);
    }
  }

  /** Uma passada só pela caixa, sem laço e sem pulso. É o modo `--demo`. */
  async entregarPendentes(): Promise<number> {
    const state = await this.store.loadOrCreate();
    const sent = await this.processAvailable(state);
    console.log(
      sent > 0
        ? `${sent} ${sent === 1 ? "mensagem entregue" : "mensagens entregues"}.`
        : "Nada pendente na caixa do WhatsApp.",
    );
    return sent;
  }

  private async processAvailable(state: BridgeState): Promise<number> {
    const messages = await this.outbox.listMessagesSince(
      state.cursorAt,
      state.cursorIds,
    );
    messages.sort(
      (first, second) =>
        Date.parse(first.createdAt) - Date.parse(second.createdAt) ||
        first.id.localeCompare(second.id),
    );
    let sent = 0;

    for (const message of messages) {
      if (!isAfterCursor(state, message)) {
        continue;
      }

      try {
        await this.deliverMessage(state, message);
      } catch (error) {
        // O cursor não avança: a mensagem volta a ser oferecida na próxima
        // leitura. Quem conta as tentativas e desiste é o Finanças.
        await this.reportFailure(message, error);
        throw error;
      }

      await this.reportDelivery(message);
      advanceCursor(state, message);
      delete state.deliveredDestinations[message.id];
      await this.store.save(state);
      sent += 1;
    }

    return sent;
  }

  private async deliverMessage(
    state: BridgeState,
    message: OutboxMessage,
  ): Promise<void> {
    const delivered = new Set(state.deliveredDestinations[message.id] ?? []);

    for (const destination of this.destinations) {
      if (delivered.has(destination.key)) {
        continue;
      }

      const acknowledgement = await sendAndWaitForServerAcknowledgement(
        this.whatsapp,
        destination.id,
        contentForDelivery(message),
      );
      console.log(
        `Mensagem ${message.id} enviada para ${destination.description} (${acknowledgement}).`,
      );
      delivered.add(destination.key);
      state.deliveredDestinations[message.id] = [...delivered];
      await this.store.save(state);
    }
  }

  private async reportDelivery(message: OutboxMessage): Promise<void> {
    try {
      await this.outbox.confirmDelivery(message.id, true);
    } catch (error) {
      // A entrega aconteceu; só o registro dela falhou. Insistir aqui
      // arriscaria reenviar a mensagem, que é o pior dos dois males.
      console.error(
        `Mensagem ${message.id} entregue, mas o Finanças não registrou: ${errorText(error)}`,
      );
    }
  }

  private async reportFailure(
    message: OutboxMessage,
    failure: unknown,
  ): Promise<void> {
    try {
      await this.outbox.confirmDelivery(message.id, false, errorText(failure));
    } catch (error) {
      console.error(
        `Não foi possível registrar a falha da mensagem ${message.id}: ${errorText(error)}`,
      );
    }
  }
}
