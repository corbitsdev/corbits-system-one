import { SystemOneError } from "./errors.js";

const CONTENT_TYPES = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
] as const;

const REFERENCE = /<image:[0-9a-f]{32}>/g;

const IMAGE = Symbol.for("@typesafe-ai/sdk/image");
const TEXT_WITH_ASSETS = Symbol.for("@typesafe-ai/sdk/text-with-assets");

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const isImage = (value: object): value is Image => IMAGE in value;

const isTextWithAssets = (value: object): value is TextWithAssets =>
  TEXT_WITH_ASSETS in value;

function fail(message: string): never {
  throw new SystemOneError("parse-error", message);
}

const toBytes = (data: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (
    !ArrayBuffer.isView(data) &&
    Object.prototype.toString.call(data) !== "[object ArrayBuffer]"
  ) {
    fail("Image data must be file bytes or a Blob.");
  }
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
};

export const contentTypeOf = (bytes: Uint8Array): string => {
  for (const [contentType, signature] of CONTENT_TYPES) {
    if (signature.every((byte, index) => bytes[index] === byte)) {
      return contentType;
    }
  }
  return "application/octet-stream";
};

/** A PNG or JPEG image. Create one with `image` or `Image.fromBase64`. */
export class Image {
  readonly type = "image";
  readonly data: Uint8Array | Blob;
  readonly #reference = `<image:${randomHex()}>`;

  constructor(data: Blob | ArrayBuffer | ArrayBufferView) {
    this.data = data instanceof Blob ? data : toBytes(data);
    const size =
      this.data instanceof Blob ? this.data.size : this.data.byteLength;
    if (size === 0) fail("Image data is empty.");
  }

  /** Decode base64 file bytes. Do not include a `data:` URL prefix. */
  static fromBase64(text: string): Image {
    let binary: string;
    try {
      binary = atob(text);
    } catch (cause) {
      const error = new SystemOneError(
        "parse-error",
        "Image data must contain valid base64 text.",
      );
      error.cause = cause;
      throw error;
    }
    return new Image(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  toString(): string {
    return this.#reference;
  }

  toJSON(): string {
    return this.#reference;
  }
}

Object.defineProperty(Image.prototype, IMAGE, { value: true });

class TextWithAssets {
  readonly text: string;
  readonly assets: Image[];

  constructor(text: string, assets: Image[]) {
    this.text = text;
    this.assets = assets;
  }

  toString(): string {
    return this.text;
  }

  toJSON(): string {
    return this.text;
  }
}

Object.defineProperty(TextWithAssets.prototype, TEXT_WITH_ASSETS, {
  value: true,
});

export type TextWithAssetsValue = TextWithAssets;

/** Create an image from file bytes or a Blob. PNG and JPEG only, checked before send. */
export const image = (data: Blob | ArrayBuffer | ArrayBufferView): Image =>
  new Image(data);

const collectAssets = (
  value: unknown,
  found: Map<string, Image>,
  visited: Set<object>,
): void => {
  if (typeof value !== "object" || value === null || visited.has(value)) return;
  visited.add(value);
  if (isImage(value)) found.set(String(value), value);
  else if (isTextWithAssets(value)) {
    for (const asset of value.assets) found.set(String(asset), asset);
  } else {
    for (const item of Object.values(value))
      collectAssets(item, found, visited);
  }
};

const textWithAssets = (text: string, values: unknown): TextWithAssets => {
  const interpolated = new Map<string, Image>();
  collectAssets(values, interpolated, new Set());
  const assets = new Map<string, Image>();
  for (const [reference] of text.matchAll(REFERENCE)) {
    const asset = interpolated.get(reference);
    if (asset !== undefined) assets.set(reference, asset);
  }
  return new TextWithAssets(text, [...assets.values()]);
};

/**
 * Tag a template so interpolated images are sent with the text.
 * An image in an untagged template is rejected before the request is sent.
 */
export const withAssets = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): TextWithAssets =>
    textWithAssets(
      strings.reduce(
        (joined, piece, index) => joined + String(values[index - 1]) + piece,
      ),
      values,
    ),
  {
    join: (values: readonly unknown[], separator: string): TextWithAssets =>
      textWithAssets(values.join(separator), values),
  },
);

export type SerializedRequest = {
  json: string;
  assets: Record<string, Image> | undefined;
};

/** Replace images with references and reject dangling or unused asset names. */
export function serializeRequest(
  payload: unknown,
  assets: Record<string, Image> = {},
): SerializedRequest {
  const names = new Map<Image, string>(
    Object.entries(assets).map(([name, asset]) => [asset, name]),
  );
  const known = new Map<string, Image>(
    Object.values(assets).map((asset) => [String(asset), asset]),
  );
  const json = JSON.stringify(payload, function (key, value: unknown) {
    if (typeof value === "number" && !Number.isFinite(value))
      return String(value);
    const holder = this as Record<string, unknown>;
    const original = holder[key];
    if (typeof original !== "object" || original === null) return value;
    if (isImage(original)) {
      const name = names.get(original);
      if (name !== undefined) return name;
      known.set(String(original), original);
    } else if (isTextWithAssets(original)) {
      let text = original.text;
      for (const asset of original.assets) {
        const name = names.get(asset);
        if (name === undefined) known.set(String(asset), asset);
        else text = text.replaceAll(String(asset), name);
      }
      return text;
    }
    return value;
  });
  const unreferenced = Object.keys(assets).filter(
    (name) => !json.includes(JSON.stringify(name).slice(1, -1)),
  );
  if (unreferenced.length > 0) {
    fail(
      `Assets not referenced in the request: ${unreferenced.join(", ")}. Write each name in \`assets\` into state, question instructions, or criteria.`,
    );
  }
  const sent = new Map<string, Image>(Object.entries(assets));
  const missing = new Set<string>();
  for (const [reference] of json.matchAll(REFERENCE)) {
    if (sent.has(reference)) continue;
    const asset = known.get(reference);
    if (asset === undefined) missing.add(reference);
    else sent.set(reference, asset);
  }
  if (missing.size > 0) {
    fail(
      `Image references without an attached image: ${[...missing].join(", ")}. Tag template literals that interpolate images with \`withAssets\`.`,
    );
  }
  return {
    json,
    assets: sent.size === 0 ? undefined : Object.fromEntries(sent),
  };
}
