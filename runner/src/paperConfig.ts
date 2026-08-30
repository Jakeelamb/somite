const MEBIBYTE = 1024 * 1024;

export const MAX_CONFIGURED_PAPER_UPLOAD_BYTES = 1024 * MEBIBYTE;
export const MAX_CONFIGURED_PAPER_TEXT_BYTES = 1024 * MEBIBYTE;
export const MAX_CONFIGURED_PAPER_PAGES = 10_000;

export type PaperIntakeConfig = Readonly<{
  maxUploadBytes: number;
  maxTextBytes: number;
  maxPdfPages: number;
  maxOcrPages: number;
  ocrLanguages: string;
}>;

export const DEFAULT_PAPER_INTAKE_CONFIG: PaperIntakeConfig = Object.freeze({
  maxUploadBytes: 100 * MEBIBYTE,
  maxTextBytes: 64 * MEBIBYTE,
  maxPdfPages: 200,
  maxOcrPages: 200,
  ocrLanguages: "eng",
});

export class PaperConfigurationError extends Error {
  readonly code = "paper_configuration_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PaperConfigurationError";
  }
}

function shown(value: string) {
  const shortened = value.length <= 80 ? value : `${value.slice(0, 77)}...`;
  return JSON.stringify(shortened);
}

function configuredInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
) {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new PaperConfigurationError(`${name} must be an integer from 1 to ${maximum}; received ${shown(raw)}. Remove ${name} to use the ${fallback} default.`);
  }
  const value = Number(raw);
  if (value < 1 || value > maximum) {
    throw new PaperConfigurationError(`${name} must be from 1 to ${maximum}; received ${shown(raw)}. Remove ${name} to use the ${fallback} default.`);
  }
  return value;
}

/** Parse one shell-free Tesseract language list such as `eng` or `eng+deu`. */
export function ocrLanguageCodes(value: string, variable = "OCR languages") {
  const normalized = value.trim();
  const codes = normalized.split("+");
  const validCode = /^[A-Za-z0-9_.-]{1,64}(?:\/[A-Za-z0-9_.-]{1,64})?$/;
  if (!normalized || normalized.length > 160 || codes.length > 8
    || codes.some((code) => !validCode.test(code)) || new Set(codes).size !== codes.length) {
    throw new PaperConfigurationError(`${variable} must be a unique Tesseract language list such as eng or eng+deu.`);
  }
  return Object.freeze(codes);
}

/** Parse paper limits once at startup so invalid deployments fail before serving requests. */
export function paperIntakeConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PaperIntakeConfig {
  const maxUploadBytes = configuredInteger(
    environment,
    "SOMITE_PAPER_MAX_UPLOAD_BYTES",
    DEFAULT_PAPER_INTAKE_CONFIG.maxUploadBytes,
    MAX_CONFIGURED_PAPER_UPLOAD_BYTES,
  );
  const maxTextBytes = configuredInteger(
    environment,
    "SOMITE_PAPER_MAX_TEXT_BYTES",
    DEFAULT_PAPER_INTAKE_CONFIG.maxTextBytes,
    MAX_CONFIGURED_PAPER_TEXT_BYTES,
  );
  const maxPdfPages = configuredInteger(
    environment,
    "SOMITE_PAPER_MAX_PAGES",
    DEFAULT_PAPER_INTAKE_CONFIG.maxPdfPages,
    MAX_CONFIGURED_PAPER_PAGES,
  );
  const maxOcrPages = configuredInteger(
    environment,
    "SOMITE_PAPER_MAX_OCR_PAGES",
    Math.min(DEFAULT_PAPER_INTAKE_CONFIG.maxOcrPages, maxPdfPages),
    MAX_CONFIGURED_PAPER_PAGES,
  );
  if (maxOcrPages > maxPdfPages) {
    throw new PaperConfigurationError(`SOMITE_PAPER_MAX_OCR_PAGES (${maxOcrPages}) cannot exceed SOMITE_PAPER_MAX_PAGES (${maxPdfPages}). Raise SOMITE_PAPER_MAX_PAGES or lower SOMITE_PAPER_MAX_OCR_PAGES.`);
  }
  const languageVariable = environment.SOMITE_OCR_LANGS !== undefined
    ? "SOMITE_OCR_LANGS"
    : environment.OMARCHY_OCR_LANGS !== undefined
      ? "OMARCHY_OCR_LANGS"
      : undefined;
  const configuredLanguages = languageVariable ? environment[languageVariable]! : DEFAULT_PAPER_INTAKE_CONFIG.ocrLanguages;
  const ocrLanguages = ocrLanguageCodes(configuredLanguages, languageVariable ?? "OCR languages").join("+");
  return Object.freeze({ maxUploadBytes, maxTextBytes, maxPdfPages, maxOcrPages, ocrLanguages });
}
