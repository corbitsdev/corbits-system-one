import type { FallbackReason, FallbackResult } from "./schemas.js";

const CLAIRIC_MODEL = "@cf/cloudflare/clairic";

export type TextField = { type: "text"; instructions?: string };
export type DateField = { type: "date"; instructions?: string };
export type NumberField = {
  type: "number";
  decimals?: number;
  unit?: string;
  instructions?: string;
};
export type ListField<Items extends string = string> = {
  type: "list";
  items: Items;
};
export type EstimateField = {
  type: "estimate";
  min?: number;
  max?: number;
  step?: number;
  instructions?: string;
};

export type ExtractionField =
  | TextField
  | DateField
  | NumberField
  | ListField
  | EstimateField;

export type TextAnswer = {
  value: string | null;
  start?: number;
  end?: number;
};

export type DateAnswer = { value: string | null };

export type NumberAnswer = { value: number | null; unit?: string };

export type ListAnswer = { value: string[] | null };

export type EstimateAnswer = {
  median: number | null;
  interval?: { p10: number; p90: number };
};

type AnswerOf<Field> = Field extends { type: "text" }
  ? TextAnswer
  : Field extends { type: "date" }
    ? DateAnswer
    : Field extends { type: "number" }
      ? NumberAnswer
      : Field extends { type: "list" }
        ? ListAnswer
        : Field extends { type: "estimate" }
          ? EstimateAnswer
          : never;

export type ExtractionAnswers<Fields extends Record<string, ExtractionField>> =
  {
    [Key in keyof Fields]: AnswerOf<Fields[Key]>;
  };

export type ExtractionSuccess<Fields extends Record<string, ExtractionField>> =
  {
    fallback: false;
    answers: ExtractionAnswers<Fields>;
    modelId: string;
    latencyMs: number;
  };

export type ExtractionResult<Fields extends Record<string, ExtractionField>> =
  | ExtractionSuccess<Fields>
  | FallbackResult;

export type ExtractInput<Fields extends Record<string, ExtractionField>> = {
  state: unknown;
  fields: Fields;
};

export type ExtractFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ExtractOptions = {
  accountId?: string;
  token?: string;
  fetch?: ExtractFetch;
};

function definedString(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return value;
}

function text(instructions?: string): TextField {
  return instructions === undefined
    ? { type: "text" }
    : { type: "text", instructions };
}

function date(instructions?: string): DateField {
  return instructions === undefined
    ? { type: "date" }
    : { type: "date", instructions };
}

function number(options?: {
  decimals?: number;
  unit?: string;
  instructions?: string;
}): NumberField {
  const field: NumberField = { type: "number" };
  if (options?.decimals !== undefined) field.decimals = options.decimals;
  if (options?.unit !== undefined) field.unit = options.unit;
  if (options?.instructions !== undefined)
    field.instructions = options.instructions;
  return field;
}

function list<const Items extends string>(items: Items): ListField<Items> {
  return { type: "list", items };
}

function estimate(options?: {
  min?: number;
  max?: number;
  step?: number;
  instructions?: string;
}): EstimateField {
  const field: EstimateField = { type: "estimate" };
  if (options?.min !== undefined) field.min = options.min;
  if (options?.max !== undefined) field.max = options.max;
  if (options?.step !== undefined) field.step = options.step;
  if (options?.instructions !== undefined)
    field.instructions = options.instructions;
  return field;
}

export { date, estimate, list, number, text };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function textAnswer(raw: unknown): TextAnswer {
  if (typeof raw === "string") return { value: raw };
  if (raw === null || raw === undefined) return { value: null };
  if (!isRecord(raw)) return { value: null };
  const direct =
    typeof raw["value"] === "string"
      ? raw["value"]
      : typeof raw["text"] === "string"
        ? raw["text"]
        : null;
  const offsets = isRecord(raw["offsets"]) ? raw["offsets"] : undefined;
  const start =
    numberOrUndefined(raw["start"]) ??
    (offsets !== undefined ? numberOrUndefined(offsets["start"]) : undefined);
  const end =
    numberOrUndefined(raw["end"]) ??
    (offsets !== undefined ? numberOrUndefined(offsets["end"]) : undefined);
  const answer: TextAnswer = { value: direct };
  if (start !== undefined) answer.start = start;
  if (end !== undefined) answer.end = end;
  return answer;
}

function dateAnswer(raw: unknown): DateAnswer {
  if (typeof raw === "string") return { value: raw };
  if (raw === null || raw === undefined) return { value: null };
  if (!isRecord(raw)) return { value: null };
  const value = raw["value"] ?? raw["date"];
  return { value: typeof value === "string" ? value : null };
}

function numberAnswer(raw: unknown): NumberAnswer {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
  if (raw === null || raw === undefined || !isRecord(raw))
    return { value: null };
  const value = numberOrUndefined(raw["value"] ?? raw["number"]);
  const unit = typeof raw["unit"] === "string" ? raw["unit"] : undefined;
  const answer: NumberAnswer = { value: value ?? null };
  if (unit !== undefined) answer.unit = unit;
  return answer;
}

function listAnswer(raw: unknown): ListAnswer {
  if (Array.isArray(raw)) {
    return {
      value: raw.filter((item): item is string => typeof item === "string"),
    };
  }
  if (raw === null || raw === undefined || !isRecord(raw))
    return { value: null };
  const value = raw["value"] ?? raw["items"];
  if (value === null) return { value: null };
  if (!Array.isArray(value)) return { value: null };
  return {
    value: value.filter((item): item is string => typeof item === "string"),
  };
}

function estimateAnswer(raw: unknown): EstimateAnswer {
  if (raw === null || raw === undefined || !isRecord(raw)) {
    return { median: null };
  }
  const median = numberOrUndefined(raw["median"] ?? raw["value"]);
  const intervalRaw = raw["interval"];
  let interval: { p10: number; p90: number } | undefined;
  if (Array.isArray(intervalRaw) && intervalRaw.length >= 2) {
    const p10 = numberOrUndefined(intervalRaw[0]);
    const p90 = numberOrUndefined(intervalRaw[1]);
    if (p10 !== undefined && p90 !== undefined) interval = { p10, p90 };
  } else if (isRecord(intervalRaw)) {
    const p10 = numberOrUndefined(intervalRaw["p10"] ?? intervalRaw["low"]);
    const p90 = numberOrUndefined(intervalRaw["p90"] ?? intervalRaw["high"]);
    if (p10 !== undefined && p90 !== undefined) interval = { p10, p90 };
  }
  const answer: EstimateAnswer = { median: median ?? null };
  if (interval !== undefined) answer.interval = interval;
  return answer;
}

function mapAnswer(field: ExtractionField, raw: unknown): unknown {
  if (field.type === "text") return textAnswer(raw);
  if (field.type === "date") return dateAnswer(raw);
  if (field.type === "number") return numberAnswer(raw);
  if (field.type === "list") return listAnswer(raw);
  return estimateAnswer(raw);
}

function answersOf(
  fields: Record<string, ExtractionField>,
  raw: unknown,
): Record<string, unknown> | undefined {
  const envelope =
    isRecord(raw) && isRecord(raw["result"]) ? raw["result"] : raw;
  if (!isRecord(envelope) || !isRecord(envelope["answers"])) return undefined;
  const source = envelope["answers"];
  const answers: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    answers[name] = mapAnswer(field, source[name]);
  }
  return answers;
}

function fallback(
  reason: FallbackReason,
  started: number,
  extra?: { httpStatus?: number; detail?: string },
): FallbackResult {
  const result: FallbackResult = {
    fallback: true,
    reason,
    latencyMs: Math.max(0, Date.now() - started),
    backendAttempted: "cloudflare-workers-ai",
  };
  if (extra?.httpStatus !== undefined) result.httpStatus = extra.httpStatus;
  if (extra?.detail !== undefined) result.detail = extra.detail;
  return result;
}

/**
 * Keyed extraction against Cloudflare Workers AI Clairic. Missing credentials,
 * non-2xx responses, and bodies that are not JSON return `fallback` and do
 * not throw.
 */
export async function extract<
  const Fields extends Record<string, ExtractionField>,
>(
  input: ExtractInput<Fields>,
  options?: ExtractOptions,
): Promise<ExtractionResult<Fields>> {
  const started = Date.now();
  const accountId =
    definedString(options?.accountId) ??
    definedString(process.env["CLOUDFLARE_ACCOUNT_ID"]);
  const token =
    definedString(options?.token) ??
    definedString(process.env["CLOUDFLARE_API_TOKEN"]);
  if (accountId === undefined || token === undefined) {
    return fallback("no-key", started, {
      detail:
        "no Cloudflare credentials; set accountId and token or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
    });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLAIRIC_MODEL}`;
  const fetchImpl = options?.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "clairic",
        state: input.state,
        fields: input.fields,
      }),
    });
  } catch (cause) {
    return fallback("network", started, {
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (!response.ok) {
    return fallback("http-error", started, { httpStatus: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return fallback("parse-error", started, {
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const answers = answersOf(input.fields, body);
  if (answers === undefined) {
    return fallback("parse-error", started, {
      detail: "response has no answers",
    });
  }

  return {
    fallback: false,
    answers: answers as ExtractionAnswers<Fields>,
    modelId: "clairic",
    latencyMs: Math.max(0, Date.now() - started),
  };
}
