import { type } from "arktype";

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
// (`'choice' | 'score' | 'noul'`), a required `instructions` string the model
// actually reads, and per-kind `criteria`. `boolean` is a caller-side alias
// for `noul` (the REST contract has no boolean kind) and is mapped at build
// time — see `toWireQuestions`.

// A multiple-choice question. `criteria` maps each option to its
// description (or null when an option needs no detail); at least one option
// and at most 255 per the vendor contract.
export const ChoiceQuestion = type({
  id: "string",
  type: "'choice'",
  instructions: "string",
  criteria: { "[string]": "string | null" },
  "+": "reject",
}).narrow(
  (q) =>
    q.instructions.length >= 1 &&
    Object.keys(q.criteria).length >= 1 &&
    Object.keys(q.criteria).length <= 255,
);
export type ChoiceQuestion = typeof ChoiceQuestion.infer;

// A scored question. `criteria` is the ordered level descriptions (2–10);
// the backend answers with a fractional position across those indexes.
export const ScoreQuestion = type({
  id: "string",
  type: "'score'",
  instructions: "string",
  criteria: "string[]",
  "+": "reject",
}).narrow(
  (q) =>
    q.instructions.length >= 1 &&
    q.criteria.length >= 2 &&
    q.criteria.length <= 10,
);
export type ScoreQuestion = typeof ScoreQuestion.infer;

// A yes/no gate. `criteria` optionally describes what true/false mean.
export const NoulQuestion = type({
  id: "string",
  type: "'noul'",
  instructions: "string",
  "criteria?": {
    "true?": "string",
    "false?": "string",
    "+": "reject",
  },
  "+": "reject",
}).narrow((q) => q.instructions.length >= 1);
export type NoulQuestion = typeof NoulQuestion.infer;

// Caller-side alias for `noul`: same shape, mapped to native noul on the
// wire. Exists so callers never have to spell the vendor's double-negative.
export const BooleanQuestion = type({
  id: "string",
  type: "'boolean'",
  instructions: "string",
  "criteria?": {
    "true?": "string",
    "false?": "string",
    "+": "reject",
  },
  "+": "reject",
}).narrow((q) => q.instructions.length >= 1);
export type BooleanQuestion = typeof BooleanQuestion.infer;

// The question union a caller may ask in one evaluation. `.or` chains keep
// each branch's literal `type`, so the union still discriminates on it.
export const Question = ChoiceQuestion.or(ScoreQuestion)
  .or(NoulQuestion)
  .or(BooleanQuestion);
export type Question = typeof Question.infer;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Caller-supplied evaluation state: a JSON record (string keys, unknown
// values), never a class instance or function — it must survive a JSON round
// trip to the backend. An array state is one state, not a batch.
export const JsonRecord = type({ "[string]": "unknown" });
export type JsonRecord = typeof JsonRecord.infer;

// Which backend an evaluation targets. `official` is the System One endpoint,
// `gateway` the proxy endpoint, `custom` a caller-supplied URL.
export const EndpointConfig = type({
  kind: "'official' | 'gateway' | 'custom'",
  "url?": "string",
  "model?": "string",
  "+": "reject",
});
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

// One evaluation request: state plus at least one question, so an evaluation
// always asks something. Question ids must be unique: a duplicate would make
// the backend's per-id echo permanently ambiguous, so it is rejected here at
// the input edge (typed `SystemOneError`) rather than surfacing later as a
// parse-error fallback.
export const EvaluateInput = type({
  state: JsonRecord,
  questions: Question.array().atLeastLength(1),
  "config?": EvaluateConfig,
  "+": "reject",
}).narrow(
  (input) =>
    new Set(input.questions.map((q) => q.id)).size === input.questions.length,
);
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
  instructions: "string",
  "criteria?": "unknown",
  "+": "reject",
});
export type WireQuestion = typeof WireQuestion.infer;

/** The exact POST body: model + state + id-keyed questions. */
export const WireRequest = type({
  model: "string",
  state: JsonRecord,
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
    if (question.type === "boolean") {
      const mapped: WireQuestion = {
        type: "noul",
        instructions: question.instructions,
      };
      if (question.criteria !== undefined) mapped.criteria = question.criteria;
      wire[question.id] = mapped;
    } else if (question.type === "noul") {
      const mapped: WireQuestion = {
        type: "noul",
        instructions: question.instructions,
      };
      if (question.criteria !== undefined) mapped.criteria = question.criteria;
      wire[question.id] = mapped;
    } else {
      wire[question.id] = {
        type: question.type,
        instructions: question.instructions,
        criteria: question.criteria,
      };
    }
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

// One backend answer in wire form. `noul` carries no confidence key — its
// absence is valid, not a violation. No `"+": "reject"`: the backend may
// attach per-answer metadata that callers strip with `toDecision`.
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

// The backend response envelope: answers keyed by question id, the
// responding (possibly versioned) model id, and optional usage. No
// `"+": "reject"`: top-level extras (usage, request ids) validate but are
// never returned.
export const WireResponseBody = type({
  "model?": "string",
  answers: { "[string]": WireAnswer },
});
export type WireResponseBody = typeof WireResponseBody.infer;

// A caller-facing decision: the wire answer plus its id, with unknown
// backend extras dropped by `toDecision` (validated but never echoed).
export const Decision = type({
  id: "string",
  type: "'noul' | 'choice' | 'score'",
  "choice?": "string",
  "score?": "number",
  "noul?": Confidence,
  "probabilities?": ProbabilityMap,
  "confidence?": Confidence,
  "legend?": { "[string]": "string" },
  "+": "reject",
});
export type Decision = typeof Decision.infer;

/**
 * Builds a clean caller-facing decision from a validated wire answer:
 * known fields only, so backend-attached extras are ignored, never echoed.
 */
export function toDecision(id: string, answer: WireAnswer): Decision {
  const decision: Decision = { id, type: answer.type };
  if (answer.choice !== undefined) decision.choice = answer.choice;
  if (answer.score !== undefined) decision.score = answer.score;
  if (answer.noul !== undefined) decision.noul = answer.noul;
  if (answer.probabilities !== undefined)
    decision.probabilities = answer.probabilities;
  if (answer.confidence !== undefined) decision.confidence = answer.confidence;
  if (answer.legend !== undefined) decision.legend = answer.legend;
  return decision;
}

// Backwards-compatible alias: the envelope shared by `evaluate()` and the
// provider adapter.
export const EvaluateResponseBody = WireResponseBody;
export type EvaluateResponseBody = typeof EvaluateResponseBody.infer;

// stripDecisionExtras is superseded by `toDecision` (explicit construction
// instead of post-validation stripping) and will be removed in the next
// clean break. Kept so the current suite keeps passing during the migration.
export function stripDecisionExtras(decision: Decision): Decision {
  return toDecision(decision.id, {
    type: decision.type,
    ...(decision.choice !== undefined ? { choice: decision.choice } : {}),
    ...(decision.score !== undefined ? { score: decision.score } : {}),
    ...(decision.noul !== undefined ? { noul: decision.noul } : {}),
    ...(decision.probabilities !== undefined
      ? { probabilities: decision.probabilities }
      : {}),
    ...(decision.confidence !== undefined
      ? { confidence: decision.confidence }
      : {}),
    ...(decision.legend !== undefined ? { legend: decision.legend } : {}),
  });
}

export const EvaluateResult = type({
  decisions: Decision.array(),
  modelId: "string",
  backend: "'system-one' | 'gateway' | 'custom'",
  latencyMs: "number",
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
  backendAttempted: "string",
  "+": "reject",
});
export type FallbackResult = typeof FallbackResult.infer;
