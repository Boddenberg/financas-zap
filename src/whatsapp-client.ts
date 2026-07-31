import { Client, LocalAuth, MessageAck } from "whatsapp-web.js";
import type { Chat, Message } from "whatsapp-web.js";
import type { AppConfig } from "./config";

const SERVER_ACK_TIMEOUT_MS = 30_000;

export type WhatsAppDestination = {
  key: string;
  id: string;
  description: string;
};

function sameBrazilianNumber(first: string, second: string): boolean {
  const normalizeLegacyMobile = (value: string): string =>
    /^55\d{2}9\d{8}$/.test(value)
      ? `${value.slice(0, 4)}${value.slice(5)}`
      : value;

  return normalizeLegacyMobile(first) === normalizeLegacyMobile(second);
}

export function createWhatsAppClient(config: AppConfig): Client {
  return new Client({
    authStrategy: new LocalAuth({
      dataPath: config.authDataPath,
    }),
    webVersionCache: {
      type: "local",
      path: config.webCachePath,
    },
    puppeteer: {
      headless: config.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });
}

function acknowledgementDescription(ack: MessageAck): string {
  if (ack >= MessageAck.ACK_READ) {
    return "leitura confirmada";
  }

  if (ack >= MessageAck.ACK_DEVICE) {
    return "entrega no aparelho confirmada";
  }

  return "recebimento pelo servidor confirmado";
}

export async function sendAndWaitForServerAcknowledgement(
  client: Client,
  destinationId: string,
  content: string,
): Promise<string> {
  const observedAcknowledgements = new Map<string, MessageAck>();
  let targetMessageId: string | undefined;
  let handleTargetAcknowledgement: ((ack: MessageAck) => void) | undefined;

  const acknowledgementListener = (message: Message, ack: MessageAck): void => {
    const messageId = message.id?._serialized;
    if (!messageId) {
      return;
    }
    observedAcknowledgements.set(messageId, ack);

    if (messageId === targetMessageId) {
      handleTargetAcknowledgement?.(ack);
    }
  };

  client.on("message_ack", acknowledgementListener);

  try {
    const sentMessage = await client.sendMessage(destinationId, content, {
      waitUntilMsgSent: true,
    });

    targetMessageId = sentMessage?.id?._serialized;
    if (!targetMessageId) {
      return "envio aceito pelo WhatsApp";
    }
    const currentAcknowledgement =
      observedAcknowledgements.get(targetMessageId) ?? sentMessage?.ack;

    if (currentAcknowledgement === MessageAck.ACK_ERROR) {
      throw new Error("O WhatsApp recusou a mensagem durante o envio.");
    }

    if (currentAcknowledgement >= MessageAck.ACK_SERVER) {
      return acknowledgementDescription(currentAcknowledgement);
    }

    const acknowledgement = await new Promise<MessageAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "O WhatsApp não confirmou o recebimento da mensagem em até 30 segundos.",
          ),
        );
      }, SERVER_ACK_TIMEOUT_MS);

      handleTargetAcknowledgement = (ack) => {
        if (ack === MessageAck.ACK_ERROR) {
          clearTimeout(timeout);
          reject(new Error("O WhatsApp recusou a mensagem durante o envio."));
          return;
        }

        if (ack >= MessageAck.ACK_SERVER) {
          clearTimeout(timeout);
          resolve(ack);
        }
      };
    });
    return acknowledgementDescription(acknowledgement);
  } finally {
    client.off("message_ack", acknowledgementListener);
  }
}

export async function resolveDestinations(
  client: Client,
  config: AppConfig,
): Promise<WhatsAppDestination[]> {
  if (!client.info?.wid) {
    throw new Error("O cliente ainda não forneceu os dados da conta conectada.");
  }

  if (config.groupId) {
    let chat: Chat;

    try {
      chat = await client.getChatById(config.groupId);
    } catch {
      throw new Error(
        "O grupo configurado não foi encontrado na conta conectada. Rode npm run list:groups para conferir o ID.",
      );
    }

    if (!chat.isGroup) {
      throw new Error("WHATSAPP_GROUP_ID não aponta para um grupo do WhatsApp.");
    }

    return [
      {
        key: `group:${config.groupId}`,
        id: config.groupId,
        description: `o grupo "${chat.name}"`,
      },
    ];
  }

  const destinations: WhatsAppDestination[] = [];
  const connectedPhone = client.info.wid.user.replace(/\D/g, "");

  for (const phone of config.targetPhones) {
    let registeredId = sameBrazilianNumber(phone, connectedPhone)
      ? client.info.wid._serialized
      : undefined;

    if (!registeredId) {
      try {
        registeredId = (await client.getNumberId(phone))?._serialized;
      } catch {
        // Algumas versões do WhatsApp Web quebram a consulta de existência
        // antes de devolver um resultado. O envio direto ainda é suportado e
        // confirma no servidor se o destino realmente existe.
        registeredId = `${phone}@c.us`;
      }
    }

    if (!registeredId) {
      throw new Error(
        `O número terminado em ${phone.slice(-4)} não está registrado no WhatsApp ou não pôde ser localizado.`,
      );
    }

    destinations.push({
      key: `phone:${phone}`,
      id: registeredId,
      description: `o número terminado em ${phone.slice(-4)}`,
    });
  }

  return destinations;
}

export async function sendTestMessage(
  client: Client,
  config: AppConfig,
): Promise<void> {
  const destinations = await resolveDestinations(client, config);

  for (const destination of destinations) {
    const acknowledgement = await sendAndWaitForServerAcknowledgement(
      client,
      destination.id,
      config.testMessage,
    );
    console.log(
      `Mensagem de teste enviada para ${destination.description} (${acknowledgement}).`,
    );
  }
}

export async function listGroups(client: Client): Promise<void> {
  const groups = (await client.getChats())
    .filter((chat) => chat.isGroup)
    .sort((first, second) => first.name.localeCompare(second.name, "pt-BR"));

  if (groups.length === 0) {
    console.log("A conta conectada não participa de nenhum grupo.");
    return;
  }

  console.log("Grupos disponíveis:");

  for (const group of groups) {
    console.log(`- ${group.name}: ${group.id._serialized}`);
  }
}
