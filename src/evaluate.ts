import { type } from "arktype";

import { postEvaluate } from "./client";
import {
  DEFAULT_TIMEOUT_MS,
  GATEWAY_API_KEY_ENV,
  GATEWAY_OIDC_ENV,
  resolveEndpoint,
  SYSTEM_ONE_API_KEY_ENV,
  TYPESAFE_API_KEY_ENV,
} from "./config";
import {
  HttpError,
  NetworkError,
  SystemOneError,
  TimeoutError,
} from "./errors";
import {
  APPROXIMATE_SUM_TOLERANCE as SUM_TOLERANCE,
  EvaluateInput,
  toDecision,
  toWireQuestions,
  WireRequest,
  WireResponseBody,
  type Decision,
  type EvaluateResult,
  type FallbackReason,
  type FallbackResult,
  type Question,
  type WireAnswer,
} from "./schemas";
import {
  recordTelemetryEvent,
  type SystemOneTelemetryEvent,
} from "./telemetry";

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------
//
// One typed-decision evaluation: validate the caller input, resolve the
// endpoint and credentials, POST state + questions once, and strictly
// validate the backend's answers against the submitted questions. Anything
// the backend gets wrong — and every transport failure — comes back as a
// typed `FallbackResult`, never a throw and never raw vendor JSON.
//
// Wire notes (live Jev contract): questions serialize to an id-keyed map,
// the `boolean` alias maps to native `noul`, the top-level `model` is always
// sent, and answers arrive in an `answers` map keyed by the same ids.

// Collects secrets out of raw caller input so input-validation errors can
// scrub them from the arktype summary before throwing. Key material must
// never appear in an error message — and neither may credentials embedded in
// a custom endpoint URL (`https://user:pass@host/...` echoes into the
// summary verbatim, so the userinfo fragments are scrubbed too).
function secretsIn(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  if (!("config" in raw)) return [];
  const config = raw.config;
  if (typeof config !== "object" || config === null) return [];
  const secrets: string[] = [];
  if ("apiKey" in config) {
    const key = config.apiKey;
    if (typeof key === "string" && key !== "") secrets.push(key);
  }
  if ("endpoint" in config) {
    const endpoint = config.endpoint;
    if (
      typeof endpoint === "object" &&
      endpoint !== null &&
      "url" in endpoint
    ) {
      const url = endpoint.url;
      if (typeof url === "string" && url !== "") {
        try {
          const parsedUrl = new URL(url);
          if (parsedUrl.username !== "") secrets.push(parsedUrl.username);
          if (parsedUrl.password !== "") secrets.push(parsedUrl.password);
        } catch {
          // Not a parseable URL: only worth scrubbing when it looks
          // credential-bearing (an `@` userinfo separator).
          if (url.includes("@")) secrets.push(url);
        }
      }
    }
  }
  return secrets;
}

// A URL with any userinfo credentials removed — `backendAttempted` goes into
// `FallbackResult`, which callers log and forward, so a caller-supplied
// `https://user:pass@host/...` must not echo its credentials back out.
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@]+@/, "//");
  }
}

// Strict cross-validation of one backend answer against its submitted
// question, per the live contract: a noul answer must carry its `noul`
// probability (noul has no confidence); a choice answer must carry `choice`,
// `probabilities`, and `confidence`; a score answer must carry `score`,
// `legend`, `probabilities`, and `confidence`. Probability sums are
// approximate (backend rounds to two decimals), never exact. Returns the
// violation, if any.
function checkAnswer(
  question: Question,
  id: string,
  answer: WireAnswer,
): string | undefined {
  const expectedType = question.type === "boolean" ? "noul" : question.type;
  if (answer.type !== expectedType) {
    return `answer "${id}" type "${answer.type}" does not match question type "${question.type}"`;
  }
  if (answer.type === "noul") {
    if (answer.noul === undefined) return `answer "${id}" is missing noul`;
    return undefined;
  }
  if (answer.confidence === undefined) {
    return `answer "${id}" is missing confidence`;
  }
  if (question.type === "choice" && answer.type === "choice") {
    if (answer.choice === undefined) return `answer "${id}" is missing choice`;
    if (!(answer.choice in question.criteria)) {
      return `answer "${id}" illegal option ${JSON.stringify(answer.choice)}`;
    }
    return checkProbabilities(
      id,
      Object.keys(question.criteria),
      answer.probabilities,
    );
  }
  if (question.type === "score" && answer.type === "score") {
    const levels = question.criteria.length;
    if (answer.score === undefined) return `answer "${id}" is missing score`;
    if (
      !Number.isFinite(answer.score) ||
      answer.score < 0 ||
      answer.score > levels - 1
    ) {
      return `answer "${id}" score ${String(answer.score)} outside [0, ${levels - 1}]`;
    }
    if (answer.legend === undefined) return `answer "${id}" is missing legend`;
    const expected = new Set(
      Array.from({ length: levels }, (_, index) => String(index)),
    );
    const actual = new Set(Object.keys(answer.legend));
    if (
      expected.size !== actual.size ||
      ![...expected].every((key) => actual.has(key))
    ) {
      return `answer "${id}" legend keys ${JSON.stringify(Object.keys(answer.legend))} do not match ${levels} levels`;
    }
    return checkProbabilities(id, [...expected], answer.probabilities);
  }
  return undefined;
}

// The probability map must cover exactly the contract keys — every option or
// every level index — with an approximate sum of 1. Extra keys are a shape
// violation, not tolerated extras: they would echo into the caller's
// decision as if they were real outcomes.
function checkProbabilities(
  id: string,
  requiredKeys: string[],
  probabilities: Record<string, number> | undefined,
): string | undefined {
  if (probabilities === undefined) {
    return `answer "${id}" is missing probabilities`;
  }
  const actual = new Set(Object.keys(probabilities));
  if (
    actual.size !== requiredKeys.length ||
    !requiredKeys.every((key) => actual.has(key))
  ) {
    return `answer "${id}" probabilities keys ${JSON.stringify([...actual])} do not match ${JSON.stringify(requiredKeys)}`;
  }
  const sum = Object.values(probabilities).reduce((total, n) => total + n, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    return `answer "${id}" probabilities sum to ${sum}, expected ~1`;
  }
  return undefined;
}

// Strict cross-validation of backend answers against the submitted
// questions: the answer key set must equal the submitted id set exactly (no
// unknowns, no drops — map keys are unique by construction), and each answer
// must satisfy its question. Returns the first violation, if any.
function checkAnswers(
  questions: Question[],
  answers: Record<string, WireAnswer>,
): string | undefined {
  const byId = new Map<string, Question>();
  for (const question of questions) byId.set(question.id, question);
  const keys = Object.keys(answers);
  if (keys.length !== questions.length) {
    return `expected ${questions.length} answers, got ${keys.length}`;
  }
  for (const id of keys) {
    const question = byId.get(id);
    if (question === undefined) return `unknown answer id "${id}"`;
    const answer = answers[id];
    if (answer === undefined)
      return `answer id "${id}" vanished during parsing`;
    const violation = checkAnswer(question, id, answer);
    if (violation !== undefined) return violation;
  }
  return undefined;
}

function envKey(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Runs one typed-decision evaluation against System One (or its gateway)
 * and returns either the backend's decisions or a typed fallback. One POST
 * per call no matter how many questions are asked. Credential precedence:
 * a non-empty per-call `apiKey` (an empty string falls through to the
 * environment, never shadowing it), then the endpoint's environment key —
 * `TYPESAFE_API_KEY` for official, `AI_GATEWAY_API_KEY` then
 * `VERCEL_OIDC_TOKEN` for gateway — then the legacy `SYSTEM_ONE_API_KEY`
 * fallback, then a fail-closed `'no-key'` fallback with zero fetch calls.
 * A `timeoutMs` that is not a finite number >= 0 falls back to
 * `DEFAULT_TIMEOUT_MS`. Transport failures map to matching fallback reasons
 * (`'timeout'`, `'network'`, `'http-error'`); backend output that fails
 * strict validation maps to `'parse-error'` with the violation in `detail`.
 * Only caller-side misuse (invalid input, a `custom` endpoint without a
 * `url`) throws, as a typed `SystemOneError`.
 */
export async function evaluate(
  input: EvaluateInput,
): Promise<EvaluateResult | FallbackResult> {
  const start = Date.now();
  const parsed = EvaluateInput(input);
  if (parsed instanceof type.errors) {
    let summary = parsed.summary;
    for (const secret of secretsIn(input)) {
      summary = summary.split(secret).join("[redacted]");
    }
    throw new SystemOneError(
      "parse-error",
      `evaluate: invalid input: ${summary}`,
    );
  }
  const endpoint = resolveEndpoint(parsed.config?.endpoint);
  const backendAttempted = sanitizeUrl(endpoint.url);
  const rawTimeoutMs: unknown = parsed.config?.timeoutMs;
  const timeoutMs =
    typeof rawTimeoutMs === "number" &&
    Number.isFinite(rawTimeoutMs) &&
    rawTimeoutMs >= 0
      ? rawTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  const rawApiKey = parsed.config?.apiKey;
  let apiKey: string | undefined;
  let keySources: string;
  if (rawApiKey !== undefined && rawApiKey !== "") {
    apiKey = rawApiKey;
    keySources = "config.apiKey";
  } else if (endpoint.backend === "system-one") {
    apiKey = envKey(TYPESAFE_API_KEY_ENV) ?? envKey(SYSTEM_ONE_API_KEY_ENV);
    keySources = `${TYPESAFE_API_KEY_ENV} or ${SYSTEM_ONE_API_KEY_ENV}`;
  } else if (endpoint.backend === "gateway") {
    apiKey =
      envKey(GATEWAY_API_KEY_ENV) ??
      envKey(GATEWAY_OIDC_ENV) ??
      envKey(SYSTEM_ONE_API_KEY_ENV);
    keySources = `${GATEWAY_API_KEY_ENV}, ${GATEWAY_OIDC_ENV}, or ${SYSTEM_ONE_API_KEY_ENV}`;
  } else {
    apiKey = envKey(SYSTEM_ONE_API_KEY_ENV);
    keySources = SYSTEM_ONE_API_KEY_ENV;
  }
  const model = endpoint.model ?? "typesafe-ai/jev";

  const fallback = (
    reason: FallbackReason,
    extra?: { httpStatus?: number; detail?: string },
  ): FallbackResult => {
    const result: FallbackResult = {
      fallback: true,
      reason,
      latencyMs: Date.now() - start,
      backendAttempted,
    };
    if (extra?.httpStatus !== undefined) result.httpStatus = extra.httpStatus;
    if (extra?.detail !== undefined) result.detail = extra.detail;
    const event: SystemOneTelemetryEvent = {
      event: "evaluate.fallback",
      backend: endpoint.backend,
      latencyMs: result.latencyMs,
      reason,
      modelId: model,
    };
    if (extra?.detail !== undefined) event.detail = extra.detail;
    recordTelemetryEvent(event);
    return result;
  };

  const startEvent: SystemOneTelemetryEvent = {
    event: "evaluate.start",
    backend: endpoint.backend,
    latencyMs: 0,
    modelId: model,
  };
  recordTelemetryEvent(startEvent);

  if (apiKey === undefined || apiKey === "") {
    return fallback("no-key", {
      detail: `no API key supplied; set config.apiKey or ${keySources}`,
    });
  }

  const wire = WireRequest({
    model,
    state: parsed.state,
    questions: toWireQuestions(parsed.questions),
  });
  if (wire instanceof type.errors) {
    throw new SystemOneError(
      "parse-error",
      `evaluate: internal wire serialization failed: ${wire.summary}`,
    );
  }

  let data: unknown;
  let transportLatencyMs: number;
  try {
    const response = await postEvaluate(endpoint.url, wire, {
      timeoutMs,
      apiKey,
    });
    data = response.data;
    transportLatencyMs = response.latencyMs;
  } catch (cause) {
    if (cause instanceof HttpError) {
      return fallback("http-error", { httpStatus: cause.httpStatus });
    }
    if (cause instanceof TimeoutError) return fallback("timeout");
    if (cause instanceof NetworkError) return fallback("network");
    throw cause;
  }

  const envelope = WireResponseBody(data);
  if (envelope instanceof type.errors) {
    return fallback("parse-error", {
      detail: `response failed schema validation: ${envelope.summary.slice(0, 240)}`,
    });
  }
  const violation = checkAnswers(parsed.questions, envelope.answers);
  if (violation !== undefined) {
    return fallback("parse-error", { detail: violation });
  }

  const modelId = envelope.model ?? model;
  const decisions: Decision[] = [];
  for (const question of parsed.questions) {
    const answer = envelope.answers[question.id];
    if (answer === undefined) {
      return fallback("parse-error", {
        detail: `answer "${question.id}" vanished during parsing`,
      });
    }
    try {
      decisions.push(toDecision(question.id, answer));
    } catch (cause) {
      return fallback("parse-error", {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  const result: EvaluateResult = {
    decisions,
    modelId,
    backend: endpoint.backend,
    latencyMs: transportLatencyMs,
    fallback: false,
  };
  if (envelope.usage !== undefined) {
    result.usage = {
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
    };
  }
  const successEvent: SystemOneTelemetryEvent = {
    event: "evaluate.success",
    backend: endpoint.backend,
    latencyMs: result.latencyMs,
    modelId,
  };
  recordTelemetryEvent(successEvent);
  return result;
}
