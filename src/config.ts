import path from "node:path";
import dotenv from "dotenv";

export type RunMode = "watch" | "test-message" | "list-groups";

export type AppConfig = {
  mode: RunMode;
  testMessage: string;
  headless: boolean;
  authDataPath: string;
  webCachePath: string;
  statePath: string;
  targetPhones: string[];
  groupId?: string;
  financesApiUrl?: string;
  financesBridgeToken?: string;
  pollIntervalMs: number;
  timeZone: string;
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

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new ConfigError(`A variável ${name} é obrigatória no modo contínuo.`);
  }

  return value;
}

function normalizeUrl(name: string, rawValue: string): string {
  let parsed: URL;

  try {
    parsed = new URL(rawValue);
  } catch {
    throw new ConfigError(`A variável ${name} deve conter uma URL HTTP válida.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ConfigError(`A variável ${name} deve começar com http:// ou https://.`);
  }

  return parsed.toString().replace(/\/+$/, "");
}

function readMode(args: string[]): RunMode {
  if (args.includes("--test-message")) {
    return "test-message";
  }

  if (args.includes("--list-groups")) {
    return "list-groups";
  }

  return "watch";
}

function readPollInterval(): number {
  const rawValue = process.env.POLL_INTERVAL_SECONDS?.trim() || "15";
  const seconds = Number(rawValue);

  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new ConfigError(
      "POLL_INTERVAL_SECONDS deve ser um número inteiro entre 5 e 3600.",
    );
  }

  return seconds * 1000;
}

function normalizeGroupId(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();

  if (!value) {
    return undefined;
  }

  if (!/^[^@\s]+@g\.us$/.test(value)) {
    throw new ConfigError(
      "WHATSAPP_GROUP_ID deve ser o identificador completo do grupo, terminado em @g.us.",
    );
  }

  return value;
}

export function normalizeInternationalPhone(
  rawPhone: string,
  defaultCountryCode = "55",
): string {
  let digits = rawPhone.replace(/\D/g, "");

  if (/^\d{10,11}$/.test(digits)) {
    digits = `${defaultCountryCode}${digits}`;
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new ConfigError(
      "Cada número em WHATSAPP_RECIPIENTS deve ter DDD e número ou o formato internacional completo.",
    );
  }

  return digits;
}

function readTargetPhones(groupId: string | undefined): string[] {
  if (groupId) {
    return [];
  }

  const defaultCountryCode =
    process.env.DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "55";
  const rawPhones = process.env.WHATSAPP_RECIPIENTS?.split(",") ?? [];
  const normalized = rawPhones
    .map((phone) => phone.trim())
    .filter(Boolean)
    .map((phone) => normalizeInternationalPhone(phone, defaultCountryCode));

  return [...new Set(normalized)];
}

function readBridgeToken(): string {
  const token = required("FINANCAS_BRIDGE_TOKEN");

  if (!token.startsWith("casa_wpp_") || token.length < 40) {
    throw new ConfigError(
      "FINANCAS_BRIDGE_TOKEN não parece uma chave gerada pelo app Casa.",
    );
  }

  return token;
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format(new Date());
  } catch {
    throw new ConfigError(
      `APP_TIMEZONE contém um fuso inválido: "${value}". Exemplo: America/Sao_Paulo.`,
    );
  }

  return value;
}

export function loadConfig(args = process.argv.slice(2)): AppConfig {
  const dotenvResult = dotenv.config({ quiet: true });
  const dotenvError = dotenvResult.error as NodeJS.ErrnoException | undefined;

  if (dotenvError && dotenvError.code !== "ENOENT") {
    throw new ConfigError(`Não foi possível ler o arquivo .env: ${dotenvError.message}`);
  }

  const mode = readMode(args);
  const groupId = normalizeGroupId(process.env.WHATSAPP_GROUP_ID);
  const targetPhones = readTargetPhones(groupId);

  if (mode !== "list-groups" && !groupId && targetPhones.length === 0) {
    throw new ConfigError(
      "Configure WHATSAPP_RECIPIENTS com pelo menos um número ou WHATSAPP_GROUP_ID com um grupo.",
    );
  }

  const watchConfig =
    mode === "watch"
      ? {
          financesApiUrl: normalizeUrl("FINANCAS_API_URL", required("FINANCAS_API_URL")),
          financesBridgeToken: readBridgeToken(),
        }
      : {};

  const testMessage = process.env.TEST_MESSAGE?.trim() || "Teste do Finanças Zap";

  return {
    mode,
    testMessage,
    headless: readBoolean("HEADLESS", true),
    authDataPath: path.resolve(process.cwd(), ".wwebjs_auth"),
    webCachePath: path.resolve(process.cwd(), ".wwebjs_cache"),
    statePath: path.resolve(
      process.cwd(),
      process.env.STATE_PATH?.trim() || ".runtime/casa-notifications.json",
    ),
    targetPhones,
    groupId,
    pollIntervalMs: readPollInterval(),
    timeZone: validateTimeZone(process.env.APP_TIMEZONE?.trim() || "America/Sao_Paulo"),
    ...watchConfig,
  };
}
