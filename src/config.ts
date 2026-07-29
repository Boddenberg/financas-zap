import path from "node:path";
import dotenv from "dotenv";

export type AppConfig = {
  testMessage: string;
  sendToSelf: boolean;
  targetPhone?: string;
  headless: boolean;
  authDataPath: string;
  webCachePath: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readBoolean(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (normalizedValue === "true") {
    return true;
  }

  if (normalizedValue === "false") {
    return false;
  }

  throw new ConfigError(
    `A variável ${name} deve ser "true" ou "false". Valor recebido: "${rawValue}".`,
  );
}

export function normalizeInternationalPhone(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, "");

  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new ConfigError(
      "TARGET_PHONE deve conter de 8 a 15 dígitos no formato internacional, começando pelo código do país. Exemplo: 5511999999999.",
    );
  }

  return digits;
}

export function loadConfig(): AppConfig {
  const dotenvResult = dotenv.config({ quiet: true });
  const dotenvError = dotenvResult.error as NodeJS.ErrnoException | undefined;

  if (dotenvError && dotenvError.code !== "ENOENT") {
    throw new ConfigError(`Não foi possível ler o arquivo .env: ${dotenvError.message}`);
  }

  const testMessage = process.env.TEST_MESSAGE ?? "Oi";
  const sendToSelf = readBoolean("SEND_TO_SELF", true);
  const headless = readBoolean("HEADLESS", true);
  const rawTargetPhone = process.env.TARGET_PHONE?.trim();

  if (testMessage.trim() === "") {
    throw new ConfigError("TEST_MESSAGE não pode ficar vazio.");
  }

  if (!sendToSelf && !rawTargetPhone) {
    throw new ConfigError(
      "TARGET_PHONE é obrigatório quando SEND_TO_SELF=false. Use o formato internacional, por exemplo: 5511999999999.",
    );
  }

  return {
    testMessage,
    sendToSelf,
    targetPhone: rawTargetPhone ? normalizeInternationalPhone(rawTargetPhone) : undefined,
    headless,
    authDataPath: path.resolve(process.cwd(), ".wwebjs_auth"),
    webCachePath: path.resolve(process.cwd(), ".wwebjs_cache"),
  };
}
