import { type } from "arktype";

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
export type ListItemKind = "text" | "number" | "date";

export type ListField<Items extends ListItemKind = ListItemKind> = {
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

type ListValue<Items extends string> = Items extends "number" ? number : string;

export type ListAnswer<Items extends string = "text"> = {
  value: ListValue<Items>[] | null;
};

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
      : Field extends { type: "list"; items: infer Items extends string }
        ? ListAnswer<Items>
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

function list<const Items extends ListItemKind>(
  items: Items,
): ListField<Items> {
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

type ParseError = { parseError: string };

const finiteNumber = type("number").narrow((value) => Number.isFinite(value));

const finiteOrNull = type("number | null").narrow(
  (value) => value === null || Number.isFinite(value),
);

const TextWire = type({
  "type?": "string",
  "value?": "string | null",
  "text?": "string | null",
  "start?": finiteNumber,
  "end?": finiteNumber,
  "span?": [finiteNumber, finiteNumber],
  "offsets?": {
    "start?": finiteNumber,
    "end?": finiteNumber,
  },
});

const DateWire = type("string").or(
  type({
    "type?": "string",
    "value?": "string | null",
    "date?": "string | null",
  }),
);

const NumberWire = finiteNumber.or(
  type({
    "type?": "string",
    "value?": finiteOrNull,
    "number?": finiteOrNull,
    "unit?": "string",
  }),
);

const stringItems = type("string[]").or("null");

const numberItems = finiteNumber.array().or("null");

const StringListWire = type("string[]").or(
  type({
    "type?": "string",
    "value?": stringItems,
    "items?": stringItems,
  }),
);

const NumberListWire = finiteNumber.array().or(
  type({
    "type?": "string",
    "value?": numberItems,
    "items?": numberItems,
  }),
);

const EstimateInterval = type([finiteNumber, finiteNumber]).or(
  type({
    "p10?": finiteNumber,
    "low?": finiteNumber,
    "p90?": finiteNumber,
    "high?": finiteNumber,
  }),
);

const EstimateWire = type({
  "type?": "string",
  "value?": finiteOrNull,
  "median?": finiteOrNull,
  "p10?": finiteNumber,
  "p90?": finiteNumber,
  "interval?": EstimateInterval,
});

function isParseError(value: unknown): value is ParseError {
  return (
    typeof value === "object" &&
    value !== null &&
    "parseError" in value &&
    typeof value.parseError === "string"
  );
}

function textAnswer(raw: unknown): TextAnswer | ParseError {
  if (typeof raw === "string") return { value: raw };
  if (raw === null || raw === undefined) return { value: null };
  const parsed = TextWire(raw);
  if (parsed instanceof type.errors) return { parseError: parsed.summary };
  const value =
    typeof parsed.value === "string"
      ? parsed.value
      : typeof parsed.text === "string"
        ? parsed.text
        : null;
  const start = parsed.start ?? parsed.span?.[0] ?? parsed.offsets?.start;
  const end = parsed.end ?? parsed.span?.[1] ?? parsed.offsets?.end;
  const answer: TextAnswer = { value };
  if (start !== undefined) answer.start = start;
  if (end !== undefined) answer.end = end;
  return answer;
}

function dateAnswer(raw: unknown): DateAnswer | ParseError {
  if (raw === null || raw === undefined) return { value: null };
  const parsed = DateWire(raw);
  if (parsed instanceof type.errors) return { parseError: parsed.summary };
  if (typeof parsed === "string") return { value: parsed };
  const value =
    typeof parsed.value === "string"
      ? parsed.value
      : typeof parsed.date === "string"
        ? parsed.date
        : null;
  return { value };
}

function numberAnswer(raw: unknown): NumberAnswer | ParseError {
  if (raw === null || raw === undefined) return { value: null };
  const parsed = NumberWire(raw);
  if (parsed instanceof type.errors) return { parseError: parsed.summary };
  if (typeof parsed === "number") return { value: parsed };
  const value =
    typeof parsed.value === "number"
      ? parsed.value
      : typeof parsed.number === "number"
        ? parsed.number
        : null;
  const answer: NumberAnswer = { value };
  if (parsed.unit !== undefined) answer.unit = parsed.unit;
  return answer;
}

function listValues(
  parsed:
    | { value?: string[] | number[] | null; items?: string[] | number[] | null }
    | string[]
    | number[],
): string[] | number[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed.value !== undefined) return parsed.value;
  return parsed.items ?? null;
}

function listAnswer(
  items: ListItemKind,
  raw: unknown,
): ListAnswer<"text"> | ListAnswer<"number"> | ParseError {
  if (raw === null || raw === undefined) return { value: null };
  const parsed = (items === "number" ? NumberListWire : StringListWire)(raw);
  if (parsed instanceof type.errors) return { parseError: parsed.summary };
  const values = listValues(parsed);
  if (values === null) return { value: null };
  if (items === "number") {
    if (!values.every((item) => typeof item === "number")) {
      return { parseError: "list items must be numbers" };
    }
    return { value: values };
  }
  if (!values.every((item) => typeof item === "string")) {
    return { parseError: "list items must be strings" };
  }
  return { value: values };
}

function isNumberPair(
  value:
    | readonly [number, number]
    | { p10?: number; low?: number; p90?: number; high?: number },
): value is readonly [number, number] {
  return Array.isArray(value);
}

function estimateInterval(parsed: {
  p10?: number;
  p90?: number;
  interval?:
    | readonly [number, number]
    | { p10?: number; low?: number; p90?: number; high?: number };
}): { p10: number; p90: number } | undefined {
  if (parsed.p10 !== undefined && parsed.p90 !== undefined) {
    return { p10: parsed.p10, p90: parsed.p90 };
  }
  const interval = parsed.interval;
  if (interval === undefined) return undefined;
  if (isNumberPair(interval)) {
    const low = interval[0];
    const high = interval[1];
    if (low === undefined || high === undefined) return undefined;
    return { p10: low, p90: high };
  }
  const low = interval.p10 ?? interval.low;
  const high = interval.p90 ?? interval.high;
  if (low === undefined || high === undefined) return undefined;
  return { p10: low, p90: high };
}

function estimateAnswer(raw: unknown): EstimateAnswer | ParseError {
  if (raw === null || raw === undefined) return { median: null };
  const parsed = EstimateWire(raw);
  if (parsed instanceof type.errors) return { parseError: parsed.summary };
  const median = parsed.median ?? parsed.value ?? null;
  const answer: EstimateAnswer = { median };
  const interval = estimateInterval(parsed);
  if (interval !== undefined) answer.interval = interval;
  return answer;
}

function mapAnswer(
  field: ExtractionField,
  raw: unknown,
):
  | TextAnswer
  | DateAnswer
  | NumberAnswer
  | ListAnswer<"text">
  | ListAnswer<"number">
  | EstimateAnswer
  | ParseError {
  if (field.type === "text") return textAnswer(raw);
  if (field.type === "date") return dateAnswer(raw);
  if (field.type === "number") return numberAnswer(raw);
  if (field.type === "list") return listAnswer(field.items, raw);
  return estimateAnswer(raw);
}

function isExtractionAnswers<Fields extends Record<string, ExtractionField>>(
  fields: Fields,
  answers: Record<string, unknown>,
): answers is ExtractionAnswers<Fields> {
  return Object.keys(fields).every((key) => Object.hasOwn(answers, key));
}

function answersOf<Fields extends Record<string, ExtractionField>>(
  fields: Fields,
  raw: unknown,
): ExtractionAnswers<Fields> | ParseError {
  const envelope =
    isRecord(raw) && isRecord(raw["result"]) ? raw["result"] : raw;
  if (!isRecord(envelope) || !isRecord(envelope["answers"])) {
    return { parseError: "response has no answers" };
  }
  const source = envelope["answers"];
  const answers: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const parsed = mapAnswer(field, source[name]);
    if (isParseError(parsed)) {
      return {
        parseError: `answer "${name}" failed schema validation: ${parsed.parseError}`,
      };
    }
    answers[name] = parsed;
  }
  if (!isExtractionAnswers(fields, answers)) {
    return { parseError: "response has no answers" };
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
  if (isParseError(answers)) {
    return fallback("parse-error", started, {
      detail: answers.parseError.slice(0, 240),
    });
  }

  return {
    fallback: false,
    answers,
    modelId: "clairic",
    latencyMs: Math.max(0, Date.now() - started),
  };
}
