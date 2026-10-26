import { type } from "arktype";

import { contentTypeOf, Image, serializeRequest } from "./assets.js";
import type { EvaluateDeps } from "./client.js";
import { evaluate, type EvaluateOptions } from "./evaluate.js";
import { SystemOneError } from "./errors.js";
import {
  DecisionQuestionRecord,
  QuestionList,
  type Decision,
  type Description,
  type EvaluateConfig,
  type FallbackResult,
  type State,
} from "./schemas.js";

type ChoiceCriteria = Record<string, Description | null>;

type NoulCriteria = {
  true?: Description;
  false?: Description;
};

export function choice<const Criteria extends ChoiceCriteria>(
  instructions: unknown,
  criteria: Criteria,
): { type: "choice"; instructions: unknown; criteria: Criteria } {
  if (Array.isArray(criteria)) {
    throw new SystemOneError(
      "parse-error",
      "Choice criteria must be a map of labels to descriptions, not a list.",
    );
  }
  return { type: "choice", instructions, criteria };
}

export function noul(
  instructions: unknown,
  criteria?: NoulCriteria,
): { type: "noul"; instructions: unknown; criteria?: NoulCriteria } {
  const question: {
    type: "noul";
    instructions: unknown;
    criteria?: NoulCriteria;
  } = { type: "noul", instructions };
  if (criteria !== undefined) question.criteria = criteria;
  return question;
}

export function score<const Criteria extends readonly Description[]>(
  instructions: unknown,
  criteria: Criteria,
): { type: "score"; instructions: unknown; criteria: Criteria } {
  if (!Array.isArray(criteria)) {
    throw new SystemOneError(
      "parse-error",
      "Score criteria must be a list of descriptions indexed by score from zero, not a map.",
    );
  }
  return { type: "score", instructions, criteria };
}

/**
 * Locate what `instructions` describe. The answer's `box` edges are fractions
 * of the image. Box questions need the `jev-preview` model; pass it as
 * `model` (or on the endpoint). This client does not reject other models.
 */
export function box(instructions: unknown): {
  type: "box";
  instructions: unknown;
} {
  return { type: "box", instructions };
}

type ChoiceAnswer<Criteria extends ChoiceCriteria> = {
  type: "choice";
  choice: keyof Criteria & string;
  probabilities: Record<keyof Criteria & string, number>;
  confidence: number;
};

type NoulAnswer = { type: "noul"; noul: number };

type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

type BoxAnswer = {
  type: "box";
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number | null;
};

type AnswerOf<QuestionSpec> = QuestionSpec extends {
  type: "choice";
  criteria: infer Criteria extends ChoiceCriteria;
}
  ? ChoiceAnswer<Criteria>
  : QuestionSpec extends { type: "noul" }
    ? NoulAnswer
    : QuestionSpec extends { type: "score" }
      ? ScoreAnswer
      : QuestionSpec extends { type: "box" }
        ? BoxAnswer
        : never;

export type SystemOneAnswers<Questions extends Record<string, unknown>> = {
  [Key in keyof Questions]: AnswerOf<Questions[Key]>;
};

export type SystemOneSuccess<Questions extends Record<string, unknown>> = {
  fallback: false;
  answers: SystemOneAnswers<Questions>;
  modelId: string;
  backend: "corbits-system-one" | "gateway" | "custom";
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
};

export type SystemOneResult<Questions extends Record<string, unknown>> =
  | SystemOneSuccess<Questions>
  | FallbackResult;

export type SystemOneInput<Questions extends Record<string, unknown>> = {
  state: unknown;
  questions: Questions;
  assets?: Record<string, Image>;
  model?: string;
  config?: EvaluateConfig;
};

function withModel(
  config: EvaluateConfig | undefined,
  model: string | undefined,
): EvaluateConfig {
  const next: EvaluateConfig = {};
  if (config?.apiKey !== undefined) next.apiKey = config.apiKey;
  if (config?.timeoutMs !== undefined) next.timeoutMs = config.timeoutMs;
  const endpoint = config?.endpoint;
  if (model !== undefined) {
    next.endpoint = { ...(endpoint ?? { kind: "official" }), model };
  } else if (endpoint !== undefined) {
    next.endpoint = endpoint;
  }
  return next;
}

function answersFrom(decisions: Decision[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const decision of decisions) {
    if (decision.type === "choice") {
      answers[decision.id] = {
        type: "choice",
        choice: decision.choice,
        probabilities: decision.probabilities,
        confidence: decision.confidence,
      };
    } else if (decision.type === "noul") {
      answers[decision.id] = { type: "noul", noul: decision.noul };
    } else if (decision.type === "score") {
      answers[decision.id] = {
        type: "score",
        score: decision.score,
        legend: decision.legend,
        probabilities: decision.probabilities,
        confidence: decision.confidence,
      };
    } else {
      answers[decision.id] = {
        type: "box",
        box: decision.box,
        confidence: decision.confidence,
      };
    }
  }
  return answers;
}

async function loadImages(
  assets: Record<string, Image>,
): Promise<NonNullable<EvaluateOptions["images"]>> {
  const parts: NonNullable<EvaluateOptions["images"]>["parts"] = [];
  const wire: NonNullable<EvaluateOptions["images"]>["assets"] = {};
  let index = 0;
  for (const [alias, asset] of Object.entries(assets)) {
    let bytes: Uint8Array;
    if (asset.data instanceof Blob) {
      bytes = new Uint8Array(await asset.data.arrayBuffer());
    } else {
      bytes = asset.data;
    }
    const contentType = contentTypeOf(bytes);
    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      throw new SystemOneError(
        "parse-error",
        `Image "${alias}" must be PNG or JPEG.`,
      );
    }
    const name = `asset-${index}`;
    parts.push({
      name,
      bytes,
      contentType,
    });
    wire[alias] = { type: "image", part: name };
    index += 1;
  }
  return { assets: wire, parts };
}

/**
 * Keyed decisions call. `choice`, `noul`, `score`, and `box` compile to the
 * question list `evaluate` already sends. Transport failures return
 * `fallback` and `reason` and do not throw.
 */
export async function systemOne<
  const Questions extends Record<string, unknown>,
>(
  input: SystemOneInput<Questions>,
  options?: Pick<EvaluateOptions, "deps" | "onTelemetry">,
): Promise<SystemOneResult<Questions>> {
  const parsed = DecisionQuestionRecord(input.questions);
  if (parsed instanceof type.errors) {
    throw new SystemOneError(
      "parse-error",
      `systemOne: invalid questions: ${parsed.summary}`,
    );
  }
  const serialized = serializeRequest(
    { state: input.state, questions: input.questions },
    input.assets,
  );
  let payload: { state?: unknown; questions?: unknown };
  try {
    payload = JSON.parse(serialized.json) as {
      state?: unknown;
      questions?: unknown;
    };
  } catch (cause) {
    throw new SystemOneError(
      "parse-error",
      `systemOne: request is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const questions = QuestionList(
    Object.entries(
      payload.questions !== null &&
        typeof payload.questions === "object" &&
        !Array.isArray(payload.questions)
        ? payload.questions
        : {},
    ).map(([id, question]) =>
      typeof question === "object" && question !== null
        ? { id, ...question }
        : { id },
    ),
  );
  if (questions instanceof type.errors) {
    throw new SystemOneError(
      "parse-error",
      `systemOne: invalid questions: ${questions.summary}`,
    );
  }
  const state = payload.state;
  if (state === undefined) {
    throw new SystemOneError("parse-error", "systemOne: state is required");
  }
  const images =
    serialized.assets === undefined
      ? undefined
      : await loadImages(serialized.assets);
  const config = withModel(input.config, input.model);
  const result = await evaluate(
    {
      state: state as State,
      questions,
      ...(input.config !== undefined || input.model !== undefined
        ? { config }
        : {}),
    },
    {
      ...(options?.deps !== undefined ? { deps: options.deps } : {}),
      ...(options?.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
      ...(images !== undefined ? { images } : {}),
    },
  );
  if (result.fallback) return result;
  return {
    fallback: false,
    answers: answersFrom(result.decisions) as SystemOneAnswers<Questions>,
    modelId: result.modelId,
    backend: result.backend,
    latencyMs: result.latencyMs,
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

export type { EvaluateDeps };
