import { Client, LocalAuth } from "whatsapp-web.js";
import type { AppConfig } from "./config";

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

export async function sendTestMessage(
  client: Client,
  config: AppConfig,
): Promise<{ destinationDescription: string }> {
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

  await client.sendMessage(destinationId, config.testMessage);

  return { destinationDescription };
}
