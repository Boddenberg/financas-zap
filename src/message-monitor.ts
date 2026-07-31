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
  type WhatsAppDestination,
} from "./whatsapp-client";
import type { Client } from "whatsapp-web.js";

export function contentForDelivery(message: OutboxMessage): string {
  return message.content;
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
      try {
        const sent = await this.processAvailable(state);

        if (sent > 0) {
          console.log(
            `${sent} ${sent === 1 ? "mensagem entregue" : "mensagens entregues"} pelo WhatsApp.`,
          );
        }
      } catch (error) {
        console.error(
          `Falha ao consultar ou entregar a caixa do WhatsApp: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      await wait(this.config.pollIntervalMs, signal);
    }
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

      await this.deliverMessage(state, message);
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
}
