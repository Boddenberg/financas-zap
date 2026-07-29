import { Client, LocalAuth, MessageAck } from "whatsapp-web.js";
import type { Message } from "whatsapp-web.js";
import type { AppConfig } from "./config";

const SERVER_ACK_TIMEOUT_MS = 30_000;

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
    return "a leitura no aparelho de destino";
  }

  if (ack >= MessageAck.ACK_DEVICE) {
    return "a entrega ao aparelho de destino";
  }

  return "o recebimento pelo servidor do WhatsApp";
}

async function sendAndWaitForServerAcknowledgement(
  client: Client,
  destinationId: string,
  content: string,
): Promise<MessageAck> {
  const observedAcknowledgements = new Map<string, MessageAck>();
  let targetMessageId: string | undefined;
  let handleTargetAcknowledgement: ((ack: MessageAck) => void) | undefined;

  const acknowledgementListener = (message: Message, ack: MessageAck): void => {
    const messageId = message.id._serialized;
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

    targetMessageId = sentMessage.id._serialized;
    const currentAcknowledgement =
      observedAcknowledgements.get(targetMessageId) ?? sentMessage.ack;

    if (currentAcknowledgement === MessageAck.ACK_ERROR) {
      throw new Error("O WhatsApp recusou a mensagem durante o envio.");
    }

    if (currentAcknowledgement >= MessageAck.ACK_SERVER) {
      return currentAcknowledgement;
    }

    return await new Promise<MessageAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "O WhatsApp não confirmou o recebimento da mensagem em até 30 segundos. A mensagem não será considerada enviada.",
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
  } finally {
    client.off("message_ack", acknowledgementListener);
  }
}

export async function sendTestMessage(
  client: Client,
  config: AppConfig,
): Promise<{ destinationDescription: string; acknowledgementDescription: string }> {
  if (!client.info?.wid) {
    throw new Error("O cliente ainda não forneceu os dados da conta conectada.");
  }

  let destinationId: string;
  let destinationDescription: string;

  if (config.sendToSelf) {
    destinationId = client.info.wid._serialized;
    destinationDescription = "a própria conta conectada";
  } else {
    if (!config.targetPhone) {
      throw new Error("O número de destino não foi configurado.");
    }

    const registeredNumber = await client.getNumberId(config.targetPhone);

    if (!registeredNumber) {
      throw new Error(
        "O número informado em TARGET_PHONE não está registrado no WhatsApp ou não pôde ser localizado.",
      );
    }

    destinationId = registeredNumber._serialized;
    destinationDescription = `o número terminado em ${config.targetPhone.slice(-4)}`;
  }

  const acknowledgement = await sendAndWaitForServerAcknowledgement(
    client,
    destinationId,
    config.testMessage,
  );

  return {
    destinationDescription,
    acknowledgementDescription: acknowledgementDescription(acknowledgement),
  };
}
