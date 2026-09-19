import { type } from "arktype";

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
//
// Everything the (not yet implemented) System One backend needs to turn a
// caller-supplied state record into typed decisions, expressed as data. Every
// schema here parses a trust boundary — caller input before it is sent, and
// backend output before it is returned — so `as T` casts never appear on
// these shapes.

// A multiple-choice question. `options` carries at least two candidates so a
// decision is always a selection, never a tautology.
export const ChoiceQuestion = type({
  kind: "'choice'",
  id: "string",
  options: "string[]",
  "label?": "string",
  "+": "reject",
}).narrow((q) => q.options.length >= 2);
export type ChoiceQuestion = typeof ChoiceQuestion.infer;

export const ScoreQuestion = type({
  kind: "'score'",
  id: "string",
  min: "number",
  max: "number",
  "label?": "string",
  "+": "reject",
});
export type ScoreQuestion = typeof ScoreQuestion.infer;

export const BooleanQuestion = type({
  kind: "'boolean'",
  id: "string",
  "label?": "string",
  "+": "reject",
});
export type BooleanQuestion = typeof BooleanQuestion.infer;

// The question union a caller may ask in one evaluation. `.or` chains keep
// each branch's literal `kind`, so the union still discriminates on it.
export const Question = ChoiceQuestion.or(ScoreQuestion).or(BooleanQuestion);
export type Question = typeof Question.infer;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Caller-supplied evaluation state: a JSON record (string keys, unknown
// values), never a class instance or function — it must survive a JSON round
// trip to the backend.
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
export const EvaluateConfig = type({
  "endpoint?": EndpointConfig,
  "timeoutMs?": "number",
  "apiKey?": "string",
  "+": "reject",
});
export type EvaluateConfig = typeof EvaluateConfig.infer;

// One evaluation request: state plus at least one question, so an evaluation
// always asks something.
export const EvaluateInput = type({
  state: JsonRecord,
  questions: Question.array().atLeastLength(1),
  "config?": EvaluateConfig,
  "+": "reject",
});
export type EvaluateInput = typeof EvaluateInput.infer;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

// A calibrated 0..1 confidence. Narrowed, not clamped: an out-of-range
// backend value is a shape violation, never silently squeezed into range.
export const Confidence = type("number").narrow((n) => n >= 0 && n <= 1);
export type Confidence = typeof Confidence.infer;

export const Decision = type({
  id: "string",
  kind: "string",
  "value?": "unknown",
  // TODO(evaluate-core): pin the distribution wire shape once the backend
  // contract lands; `unknown` keeps the scaffold honest about not knowing it.
  "distribution?": "unknown",
  confidence: Confidence,
  "+": "reject",
});
export type Decision = typeof Decision.infer;

export const EvaluateResult = type({
  decisions: Decision.array(),
  modelId: "string",
  backend: "'system-one' | 'gateway'",
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
