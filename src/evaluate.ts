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

// Strict cross-validation of one backend answer against its submitted
// question. Choice values must be criteria options with full probability
// coverage; scores must land inside the level range with a complete legend;
// noul carries no confidence key — its absence is valid, not a violation.
// Probability sums are approximate (backend rounds to two decimals), never
// exact. Returns the violation, if any.
function checkAnswer(
  question: Question,
  id: string,
  answer: WireAnswer,
): string | undefined {
  if (question.type === "boolean") {
    if (answer.type !== "noul") {
      return `answer "${id}" type "${answer.type}" does not map to boolean (noul) question`;
    }
    return undefined;
  }
  if (answer.type !== question.type) {
    return `answer "${id}" type "${answer.type}" does not match question type "${question.type}"`;
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

function checkProbabilities(
  id: string,
  requiredKeys: string[],
  probabilities: Record<string, number> | undefined,
): string | undefined {
  if (probabilities === undefined) {
    return `answer "${id}" is missing probabilities`;
  }
  for (const key of requiredKeys) {
    if (!(key in probabilities)) {
      return `answer "${id}" probabilities are missing key "${key}"`;
    }
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
 * strict validation maps to `'parse-error'`. Only caller-side misuse
 * (invalid input, a `custom` endpoint without a `url`) throws, as a typed
 * `SystemOneError`.
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
  const rawTimeoutMs: unknown = parsed.config?.timeoutMs;
  const timeoutMs =
    typeof rawTimeoutMs === "number" &&
    Number.isFinite(rawTimeoutMs) &&
    rawTimeoutMs >= 0
      ? rawTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  const rawApiKey = parsed.config?.apiKey;
  let apiKey: string | undefined;
  if (rawApiKey !== undefined && rawApiKey !== "") {
    apiKey = rawApiKey;
  } else if (endpoint.backend === "system-one") {
    apiKey = envKey(TYPESAFE_API_KEY_ENV) ?? envKey(SYSTEM_ONE_API_KEY_ENV);
  } else if (endpoint.backend === "gateway") {
    apiKey =
      envKey(GATEWAY_API_KEY_ENV) ??
      envKey(GATEWAY_OIDC_ENV) ??
      envKey(SYSTEM_ONE_API_KEY_ENV);
  } else {
    apiKey = envKey(SYSTEM_ONE_API_KEY_ENV);
  }
  const model = endpoint.model ?? "typesafe-ai/jev";

  const fallback = (
    reason: FallbackReason,
    httpStatus?: number,
  ): FallbackResult => {
    const result: FallbackResult = {
      fallback: true,
      reason,
      latencyMs: Date.now() - start,
      backendAttempted: endpoint.url,
    };
    if (httpStatus !== undefined) result.httpStatus = httpStatus;
    const event: SystemOneTelemetryEvent = {
      event: "evaluate.fallback",
      backend: endpoint.backend,
      latencyMs: result.latencyMs,
      reason,
      modelId: model,
    };
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
    return fallback("no-key");
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
      return fallback("http-error", cause.httpStatus);
    }
    if (cause instanceof TimeoutError) return fallback("timeout");
    if (cause instanceof NetworkError) return fallback("network");
    throw cause;
  }

  const envelope = WireResponseBody(data);
  if (envelope instanceof type.errors) {
    return fallback("parse-error");
  }
  const violation = checkAnswers(parsed.questions, envelope.answers);
  if (violation !== undefined) {
    return fallback("parse-error");
  }

  const modelId = envelope.model ?? model;
  const decisions = [];
  for (const question of parsed.questions) {
    const answer = envelope.answers[question.id];
    if (answer === undefined) {
      return fallback("parse-error");
    }
    decisions.push(toDecision(question.id, answer));
  }
  const result: EvaluateResult = {
    decisions,
    modelId,
    backend: endpoint.backend,
    latencyMs: transportLatencyMs,
    fallback: false,
  };
  const successEvent: SystemOneTelemetryEvent = {
    event: "evaluate.success",
    backend: endpoint.backend,
    latencyMs: result.latencyMs,
    modelId,
  };
  recordTelemetryEvent(successEvent);
  return result;
}

export { SUM_TOLERANCE as APPROXIMATE_SUM_TOLERANCE };
