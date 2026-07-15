import {
  assertJsonValue,
  type JsonValue,
} from '../persistence/json-value.js';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|x-api-key|api-key|apikey|access-token|access_token|refresh-token|refresh_token|token|secret|password|passwd|credential)$/i;

export interface RedactorOptions {
  readonly secrets?: readonly string[];
  readonly environmentVariableNames?: readonly string[];
  readonly environmentValues?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly minSecretLength?: number;
}

export interface RedactionResult {
  readonly value: JsonValue;
  readonly redactionApplied: boolean;
}

function redactPatterns(input: string): string {
  return input
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    )
    .replace(
      /([?&](?:access_token|refresh_token|api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:authorization|proxy-authorization|x-api-key|api-key|apikey|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    );
}

export class Redactor {
  private readonly secrets: readonly string[];

  public constructor(options: RedactorOptions = {}) {
    const minimum = options.minSecretLength ?? 8;
    if (!Number.isSafeInteger(minimum) || minimum < 1) {
      throw new Error('minSecretLength must be a positive integer');
    }
    const environment = options.environment ?? process.env;
    const candidates = [
      ...(options.secrets ?? []),
      ...(options.environmentValues ?? []),
      ...(options.environmentVariableNames ?? []).map((name) => environment[name]),
    ];
    this.secrets = [...new Set(
      candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.length >= minimum,
      ),
    )].sort((left, right) => right.length - left.length);
  }

  public redact(input: unknown): RedactionResult {
    try {
      assertJsonValue(input);
    } catch {
      throw new Error('invalid JSON value for redaction');
    }
    let applied = false;

    const redactString = (value: string): string => {
      let redacted = value;
      for (const secret of this.secrets) {
        redacted = redacted.replaceAll(secret, REDACTED);
      }
      redacted = redactPatterns(redacted);
      if (redacted !== value) applied = true;
      return redacted;
    };

    const visit = (value: JsonValue, key?: string): JsonValue => {
      if (key !== undefined && SENSITIVE_KEY.test(key)) {
        applied = true;
        return REDACTED;
      }
      if (typeof value === 'string') {
        return redactString(value);
      }
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map((entry) => visit(entry));
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey),
        ]),
      );
    };

    return { value: visit(input), redactionApplied: applied };
  }
}
