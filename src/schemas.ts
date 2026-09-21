import { type } from "arktype";

import { SystemOneError } from "./errors";

// ---------------------------------------------------------------------------
// Shared JSON shapes
// ---------------------------------------------------------------------------

// A plain JSON object: string keys, unknown values. The narrow rejects class
// instances, Maps, and arrays — all of which match an index signature but
// serialize wrong (`new Map()` stringifies to `{}`).
const isPlainObject = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const JsonRecord = type({ "[string]": "unknown" }).narrow(isPlainObject);
export type JsonRecord = typeof JsonRecord.infer;

// Anywhere the contract allows "string | object | array": question
// instructions, option/level descriptions, and noul criteria all accept a
// structured form (the model reads named fields via backtick references).
export const Description = type("string | unknown[]").or(JsonRecord);
export type Description = typeof Description.infer;

// Evaluation state: a string for text, or an object/array for structured
// records — never a class instance or function, it must survive a JSON round
// trip to the backend.
export const State = Description;
export type State = typeof State.infer;

const nonEmpty = (d: Description): boolean =>
  typeof d === "string"
    ? d.length >= 1
    : Array.isArray(d)
      ? d.length >= 1
      : Object.keys(d).length >= 1;

// ---------------------------------------------------------------------------
// Questions (public edge)
// ---------------------------------------------------------------------------
//
// Caller-facing questions: an array with caller-chosen ids. The wire sends
// them as a map keyed by id (see `toWireQuestions`) — ids must be unique so
// the backend's per-id echo stays unambiguous. Every schema here parses a
// trust boundary, so `as T` casts never appear on these shapes.
//
// The shapes follow the live Jev contract: discriminator `type`
// (`'choice' | 'score' | 'noul'`), a required `instructions` (string or
// structured), and per-kind `criteria`. `boolean` is a caller-side alias for
// `noul` (the REST contract has no boolean kind) and is mapped at build time
// — see `toWireQuestions`.

// A multiple-choice question. `criteria` maps each option to its
// description (or null when an option needs no detail); at least one option
// and at most 255 per the vendor contract.
export const ChoiceQuestion = type({
  id: "string",
  type: "'choice'",
  instructions: Description,
  criteria: { "[string]": Description.or("null") },
  "+": "reject",
}).narrow(
  (q) =>
    nonEmpty(q.instructions) &&
    Object.keys(q.criteria).length >= 1 &&
    Object.keys(q.criteria).length <= 255,
);
export type ChoiceQuestion = typeof ChoiceQuestion.infer;

// A scored question. `criteria` is the ordered level descriptions (2–10);
// the backend answers with a fractional position across those indexes.
export const ScoreQuestion = type({
  id: "string",
  type: "'score'",
  instructions: Description,
  criteria: Description.array(),
  "+": "reject",
}).narrow(
  (q) =>
    nonEmpty(q.instructions) &&
    q.criteria.length >= 2 &&
    q.criteria.length <= 10,
);
export type ScoreQuestion = typeof ScoreQuestion.infer;

// A yes/no gate. `criteria` optionally describes what true/false mean.
export const NoulQuestion = type({
  id: "string",
  type: "'noul'",
  instructions: Description,
  "criteria?": {
    "true?": Description,
    "false?": Description,
    "+": "reject",
  },
  "+": "reject",
}).narrow((q) => nonEmpty(q.instructions));
export type NoulQuestion = typeof NoulQuestion.infer;

// Caller-side alias for `noul`: same shape, mapped to native noul on the
// wire. Exists so callers never have to spell the vendor's double-negative.
export const BooleanQuestion = type({
  id: "string",
  type: "'boolean'",
  instructions: Description,
  "criteria?": {
    "true?": Description,
    "false?": Description,
    "+": "reject",
  },
  "+": "reject",
}).narrow((q) => nonEmpty(q.instructions));
export type BooleanQuestion = typeof BooleanQuestion.infer;

// The question union a caller may ask in one evaluation. `.or` chains keep
// each branch's literal `type`, so the union still discriminates on it.
export const Question = ChoiceQuestion.or(ScoreQuestion)
  .or(NoulQuestion)
  .or(BooleanQuestion);
export type Question = typeof Question.infer;

// A non-empty question list with unique ids: a duplicate would make the
// backend's per-id echo permanently ambiguous, so it is rejected at the
// input edge (typed `SystemOneError` / `ProtocolMismatchError`) rather than
// surfacing later as a silently collapsed wire map.
export const QuestionList = Question.array()
  .atLeastLength(1)
  .narrow((qs) => new Set(qs.map((q) => q.id)).size === qs.length);
export type QuestionList = typeof QuestionList.infer;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Which backend an evaluation targets. `official` is the System One endpoint,
// `gateway` the proxy endpoint, `custom` a caller-supplied URL. `url` only
// exists on `custom` — a `url` on another kind would be silently ignored,
// so the schema rejects it instead of accepting misleading config.
export const EndpointConfig = type({
  kind: "'custom'",
  url: "string",
  "model?": "string",
  "+": "reject",
}).or(
  type({
    kind: "'official' | 'gateway'",
    "model?": "string",
    "+": "reject",
  }),
);
export type EndpointConfig = typeof EndpointConfig.infer;

// Per-evaluation knobs. An absent `endpoint` resolves to `official` at the
// `evaluate` edge, not here — schemas parse, they never fill in defaults.
// `timeoutMs` is deliberately `unknown`: any non-finite or negative value
// falls back to `DEFAULT_TIMEOUT_MS` at the edge (documented normalization,
// not a validation error), so the schema must not reject it first.
export const EvaluateConfig = type({
  "endpoint?": EndpointConfig,
  "timeoutMs?": "unknown",
  "apiKey?": "string",
  "+": "reject",
});
export type EvaluateConfig = typeof EvaluateConfig.infer;

// One evaluation request: state plus at least one uniquely-id'd question,
// so an evaluation always asks something.
export const EvaluateInput = type({
  state: State,
  questions: QuestionList,
  "config?": EvaluateConfig,
  "+": "reject",
});
export type EvaluateInput = typeof EvaluateInput.infer;

// ---------------------------------------------------------------------------
// Wire shapes (backend contract)
// ---------------------------------------------------------------------------
//
// The serialized request the backend actually receives: questions as a map
// keyed by caller id (ids echo back as answer keys and are never sent to the
// model), plus the required top-level `model`. Built by `toWireQuestions` +
// `toWireRequest`, never hand-assembled by callers.

/** One question in wire form: no id (the map key carries it). */
export const WireQuestion = type({
  type: "'noul' | 'choice' | 'score'",
  instructions: Description,
  "criteria?": "unknown",
  "+": "reject",
});
export type WireQuestion = typeof WireQuestion.infer;

/** The exact POST body: model + state + id-keyed questions. */
export const WireRequest = type({
  model: "string",
  state: State,
  questions: { "[string]": WireQuestion },
  "+": "reject",
}).narrow((body) => Object.keys(body.questions).length >= 1);
export type WireRequest = typeof WireRequest.infer;

/**
 * Maps caller-facing questions to the wire map. The `boolean` alias becomes
 * native `noul`; everything else passes through with its id as the key.
 */
export function toWireQuestions(
  questions: Question[],
): Record<string, WireQuestion> {
  const wire: Record<string, WireQuestion> = {};
  for (const question of questions) {
    const mapped: WireQuestion = {
      type: question.type === "boolean" ? "noul" : question.type,
      instructions: question.instructions,
    };
    if (question.criteria !== undefined) mapped.criteria = question.criteria;
    wire[question.id] = mapped;
  }
  return wire;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

// A calibrated 0..1 confidence. Narrowed, not clamped: an out-of-range
// backend value is a shape violation, never silently squeezed into range.
export const Confidence = type("number").narrow((n) => n >= 0 && n <= 1);
export type Confidence = typeof Confidence.infer;

// Per-outcome probabilities as a record of finite 0..1 numbers keyed by
// outcome label (option ids for choice, level indexes as strings for score).
// The backend rounds to two decimals, so sums are approximate —
// `APPROXIMATE_SUM_TOLERANCE` below, not exact equality, is the check.
export const ProbabilityMap = type({ "[string]": "number" }).narrow((m) =>
  Object.values(m).every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
);
export type ProbabilityMap = typeof ProbabilityMap.infer;

/** Tolerance for probability-sum checks (backend rounds to 2 decimals). */
export const APPROXIMATE_SUM_TOLERANCE = 0.02;

// One backend answer in wire form. All kind-specific fields are optional
// here; `checkAnswer` (evaluate) and `toDecision` enforce which ones a given
// `type` must carry. No `"+": "reject"`: the backend may attach per-answer
// metadata that `toDecision` strips.
export const WireAnswer = type({
  type: "'noul' | 'choice' | 'score'",
  "choice?": "string",
  "score?": "number",
  "noul?": Confidence,
  "probabilities?": ProbabilityMap,
  "confidence?": Confidence,
  "legend?": { "[string]": "string" },
});
export type WireAnswer = typeof WireAnswer.infer;

// Token usage reported on the response envelope.
export const WireUsage = type({
  input_tokens: "number",
  output_tokens: "number",
});
export type WireUsage = typeof WireUsage.infer;

// The backend response envelope: answers keyed by question id, the
// responding (possibly versioned) model id, and token usage. `model` and
// `usage` are optional — a gateway or custom backend may omit them, and
// neither is worth failing an otherwise-valid evaluation over. No
// `"+": "reject"`: top-level extras validate but are never returned.
export const WireResponseBody = type({
  "model?": "string",
  "usage?": WireUsage,
  answers: { "[string]": WireAnswer },
});
export type WireResponseBody = typeof WireResponseBody.infer;

// A caller-facing decision: one per kind, discriminated by `type`, with each
// kind's contract-required fields required here. `toDecision` builds these
// from validated wire answers; backend extras are never echoed.
export const Decision = type({
  id: "string",
  type: "'noul'",
  noul: Confidence,
  "+": "reject",
})
  .or(
    type({
      id: "string",
      type: "'choice'",
      choice: "string",
      probabilities: ProbabilityMap,
      confidence: Confidence,
      "+": "reject",
    }),
  )
  .or(
    type({
      id: "string",
      type: "'score'",
      score: "number",
      legend: { "[string]": "string" },
      probabilities: ProbabilityMap,
      confidence: Confidence,
      "+": "reject",
    }),
  );
export type Decision = typeof Decision.infer;

/**
 * Builds a caller-facing decision from a wire answer: the kind's contract
 * fields only, so cross-kind extras are dropped and a malformed answer
 * (e.g. a choice answer missing `choice`) throws a typed `SystemOneError`
 * instead of producing a half-empty decision.
 */
export function toDecision(id: string, answer: WireAnswer): Decision {
  let candidate: unknown;
  if (answer.type === "noul") {
    candidate = { id, type: "noul", noul: answer.noul };
  } else if (answer.type === "choice") {
    candidate = {
      id,
      type: "choice",
      choice: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  } else {
    candidate = {
      id,
      type: "score",
      score: answer.score,
      legend: answer.legend,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  const parsed = Decision(candidate);
  if (parsed instanceof type.errors) {
    throw new SystemOneError(
      "parse-error",
      `toDecision: answer "${id}" failed its kind's contract: ${parsed.summary}`,
    );
  }
  return parsed;
}

// Token usage on a caller-facing result (camelCase like the rest of the
// public surface).
export const Usage = type({
  inputTokens: "number",
  outputTokens: "number",
  "+": "reject",
});
export type Usage = typeof Usage.infer;

// Backwards-compatible alias: the envelope shared by `evaluate()` and the
// provider adapter.
export const EvaluateResponseBody = WireResponseBody;
export type EvaluateResponseBody = typeof EvaluateResponseBody.infer;

export const EvaluateResult = type({
  decisions: Decision.array(),
  modelId: "string",
  backend: "'corbits-system-one' | 'gateway' | 'custom'",
  latencyMs: "number",
  "usage?": Usage,
  fallback: "false",
  "+": "reject",
});
export type EvaluateResult = typeof EvaluateResult.infer;

// Every reason an evaluation can come back as data instead of decisions.
// Shared with the thrown taxonomy (see `SystemOneErrorCode` in errors.ts).
export const FallbackReason = type(
  "'no-key' | 'timeout' | 'network' | 'http-error' | 'parse-error' | 'backend-unreachable'",
);
export type FallbackReason = typeof FallbackReason.infer;

export const FallbackResult = type({
  fallback: "true",
  reason: FallbackReason,
  latencyMs: "number",
  "httpStatus?": "number",
  "detail?": "string",
  backendAttempted: "string",
  "+": "reject",
});
export type FallbackResult = typeof FallbackResult.infer;
