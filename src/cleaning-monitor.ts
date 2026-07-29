import type { AppConfig } from "./config";
import type { CleaningEvent, FinancasClient } from "./financas-client";
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

function formatPoints(points: number): string {
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 2,
  }).format(points);
}

export function formatCleaningMessage(event: CleaningEvent): string {
  const location = event.roomName ? ` em *${event.roomName}*` : "";
  const shared = event.shared ? "\n🤝 Atividade feita em conjunto." : "";

  return [
    "🧹 *Casa cuidada!*",
    `${event.actorName} registrou *${event.activityName}*${location}.`,
    `⭐ +${formatPoints(event.points)} pontos no app Casa.${shared}`,
  ].join("\n");
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

export class CleaningMonitor {
  constructor(
    private readonly whatsapp: Client,
    private readonly finances: FinancasClient,
    private readonly destinations: WhatsAppDestination[],
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const state = await this.store.loadOrCreate();
    console.log(
      `Monitorando novas limpezas a partir de ${new Date(state.cursorAt).toLocaleString(
        "pt-BR",
        { timeZone: this.config.timeZone },
      )}.`,
    );

    while (!signal.aborted) {
      try {
        const sent = await this.processAvailable(state);

        if (sent > 0) {
          console.log(
            `${sent} ${sent === 1 ? "limpeza avisada" : "limpezas avisadas"} pelo WhatsApp.`,
          );
        }
      } catch (error) {
        console.error(
          `Falha ao consultar ou avisar uma limpeza: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      await wait(this.config.pollIntervalMs, signal);
    }
  }

  private async processAvailable(state: BridgeState): Promise<number> {
    const events = await this.finances.listEventsSince(
      state.cursorAt,
      state.cursorIds,
    );
    events.sort(
      (first, second) =>
        Date.parse(first.savedAt) - Date.parse(second.savedAt) ||
        first.id.localeCompare(second.id),
    );
    let sent = 0;

    for (const event of events) {
      if (!isAfterCursor(state, event)) {
        continue;
      }

      await this.deliverEvent(state, event);
      advanceCursor(state, event);
      delete state.deliveredDestinations[event.id];
      await this.store.save(state);
      sent += 1;
    }

    return sent;
  }

  private async deliverEvent(state: BridgeState, event: CleaningEvent): Promise<void> {
    const delivered = new Set(state.deliveredDestinations[event.id] ?? []);
    const content = formatCleaningMessage(event);

    for (const destination of this.destinations) {
      if (delivered.has(destination.key)) {
        continue;
      }

      const acknowledgement = await sendAndWaitForServerAcknowledgement(
        this.whatsapp,
        destination.id,
        content,
      );
      console.log(
        `Aviso de "${event.activityName}" enviado para ${destination.description} (${acknowledgement}).`,
      );
      delivered.add(destination.key);
      state.deliveredDestinations[event.id] = [...delivered];
      await this.store.save(state);
    }
  }
}
