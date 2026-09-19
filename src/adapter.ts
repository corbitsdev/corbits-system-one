import { type } from "arktype";

import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
  type ProviderAdapter,
} from "@intx/inference";
import type {
  ContentBlock,
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  PartialMessage,
  TokenUsage,
} from "@intx/types/runtime";

import { resolveEndpoint } from "./config";
import {
  Decision,
  toDecision,
  toWireQuestions,
  WireResponseBody,
  JsonRecord,
  Question,
  type EvaluateConfig,
} from "./schemas";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
//
// A thin Interchange `ProviderAdapter` bridge over the Jev evaluate wire
// protocol (`evaluate()`'s contract: state + questions in, decisions out).
// `buildRequest` encodes the conversation transcript as the evaluation
// state; a caller that already has Jev-shaped payloads passes them per call
// through `providerOptions.systemOne` (`{ state?, questions? }`), validated
// here with arktype. Decisions come back as `inference.text.delta` events
// carrying each decision's JSON, followed by an `inference.usage` event —
// the Jev protocol has no token counts, so usage is zeros. Auth never
// touches key material here: the request carries the bearer sentinel and
// the host's harness injects the real credential.

/** Provider id this package serves. */
export const SYSTEM_ONE_PROVIDER = "system-one";

// Per-call Jev payload overrides via `InferenceOptions.providerOptions`.
// `state` replaces the transcript-derived default; `questions` replaces the
// single-question default. Both are validated, never cast.
const SystemOneProviderOptions = type({
  "state?": JsonRecord,
  "questions?": Question.array().atLeastLength(1),
  "+": "reject",
});

// The Jev evaluate response body is the shared `WireResponseBody` envelope
// (see schemas.ts): answers arrive in an id-keyed map with per-kind shapes.
// Extra backend fields validate but are never echoed: `toDecision` builds
// clean decisions, so they never become false protocol mismatches nor echoed
// tokens.

const EMPTY_PARTIAL: PartialMessage = { text: "" };

const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

// The bridge default question, used when the caller supplies no questions
// via `providerOptions.systemOne`: a conversation has no inherent Jev
// questions, so the adapter asks the one boolean every transcript answers —
// whether the turn responds — and lets the host interpret the decision.
const DEFAULT_QUESTIONS: Question[] = [
  {
    type: "boolean",
    id: "response",
    instructions: "Does this turn respond to the conversation?",
  },
];

function transcriptText(turns: ConversationTurn[]): string {
  const texts: string[] = [];
  for (const turn of turns) {
    const parts: string[] = [];
    const content: ContentBlock[] = turn.content;
    for (const block of content) {
      if (block.type === "text") parts.push(block.text);
    }
    if (parts.length > 0) texts.push(`${turn.role}: ${parts.join("")}`);
  }
  return texts.join("\n");
}

function parseDecisions(body: string, provider: string): Decision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new ProtocolMismatchError(
      `${provider} parseJSONResponse: malformed JSON response body: ${cause instanceof Error ? cause.message : String(cause)}`,
      body,
    );
  }
  const envelope = WireResponseBody(parsed);
  if (envelope instanceof type.errors) {
    throw new ProtocolMismatchError(
      `${provider} parseJSONResponse: response failed schema validation: ${envelope.summary}`,
      parsed,
    );
  }
  return Object.keys(envelope.answers).map((id) => {
    const answer = envelope.answers[id];
    if (answer === undefined) {
      throw new ProtocolMismatchError(
        `${provider} parseJSONResponse: answer id "${id}" vanished during parsing`,
        parsed,
      );
    }
    return toDecision(id, answer);
  });
}

/**
 * Builds the Interchange `ProviderAdapter` for System One against the
 * host's single copy of `@intx/inference` (peer dependency, never vendored).
 * The optional `config` pins the endpoint (official by default, gateway, or
 * a custom URL) and the per-call model default; the inference call's own
 * `model` argument wins for the request body.
 */
export function createSystemOneAdapter(
  config?: EvaluateConfig,
): ProviderAdapter {
  const endpoint = resolveEndpoint(config?.endpoint);
  const source = {
    sourceId: SYSTEM_ONE_PROVIDER,
    provider: SYSTEM_ONE_PROVIDER,
    model: endpoint.model ?? "unknown",
  };

  const buildRequest = (
    messages: ConversationTurn[],
    model: string,
    options: InferenceOptions,
  ): { url: string; headers: Record<string, string>; body: string } => {
    source.model = model;
    let state: JsonRecord = { transcript: transcriptText(messages) };
    let questions: Question[] = DEFAULT_QUESTIONS;
    const rawOverrides = options.providerOptions?.["systemOne"];
    if (rawOverrides !== undefined) {
      const overrides = SystemOneProviderOptions(rawOverrides);
      if (overrides instanceof type.errors) {
        throw new ProtocolMismatchError(
          `${SYSTEM_ONE_PROVIDER} buildRequest: invalid providerOptions.systemOne: ${overrides.summary}`,
          rawOverrides,
        );
      }
      if (overrides.state !== undefined) state = overrides.state;
      if (overrides.questions !== undefined) questions = overrides.questions;
    }
    const requestModel = model || endpoint.model || "unknown";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: BEARER_CREDENTIAL_SENTINEL,
    };
    return {
      url: endpoint.url,
      headers,
      body: JSON.stringify({
        state,
        questions: toWireQuestions(questions),
        model: requestModel,
      }),
    };
  };

  const parseJSONResponse = (responseBody: string): InferenceEvent[] => {
    const decisions = parseDecisions(responseBody, SYSTEM_ONE_PROVIDER);
    const events: InferenceEvent[] = [];
    let index = 0;
    for (const decision of decisions) {
      const token = JSON.stringify(decision);
      events.push({
        type: "inference.text.delta",
        seq: 0,
        data: { token, partial: EMPTY_PARTIAL, index },
      });
      index += 1;
    }
    events.push({
      type: "inference.usage",
      seq: 0,
      data: { usage: ZERO_USAGE, source: { ...source } },
    });
    return events;
  };

  // The Jev evaluate protocol is non-streaming: a streaming chunk is just a
  // complete body arriving early, so the SSE path decodes the same JSON.
  const parseResponse = (sseData: string): InferenceEvent[] =>
    parseJSONResponse(sseData);

  return { buildRequest, parseResponse, parseJSONResponse };
}
