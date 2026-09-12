/**
 * Provider-agnostic text and JSON generation for the game's AI layers.
 *
 * The game needs three things from a model: read an image, write prose, and
 * return a fixed-shape JSON object. OpenAI and Gemini both do all three, so
 * the routes talk to this module and whichever key is present wins. That keeps
 * the original starter's Gemini path working while letting an OpenAI key drive
 * the same features.
 */

import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";

export type AiProvider = "openai" | "gemini";

/** Model ids are overridable so a key with limited access can still work. */
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

function keyFor(name: string): string | null {
  const value = process.env[name];
  // The starter ships placeholder values; treat those as absent.
  if (!value || value.startsWith("replace_with") || value.startsWith("your_")) {
    return null;
  }
  return value;
}

/** OpenAI wins when both are set, since it is the more common hackathon key. */
export function activeProvider(): AiProvider | null {
  if (keyFor("OPENAI_API_KEY")) return "openai";
  if (keyFor("GEMINI_API_KEY")) return "gemini";
  return null;
}

export function providerModel(provider: AiProvider): string {
  return provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL;
}

/** The error every route returns when no usable key is configured. */
export const NO_KEY_ERROR =
  "No AI key configured. Set OPENAI_API_KEY or GEMINI_API_KEY in .env.local.";

export type AiImage = {
  mimeType: string;
  base64: string;
};

export type GenerateOptions = {
  system: string;
  user: string;
  image?: AiImage;
  maxTokens?: number;
  /**
   * Honoured by Gemini only. The GPT-5.6 family rejects any value but its
   * default — "Unsupported value: 'temperature' does not support 0.7 with this
   * model" — so the OpenAI path never sends it.
   */
  temperature?: number;
};

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export async function generateText(options: GenerateOptions): Promise<string> {
  const provider = activeProvider();
  if (!provider) throw new Error(NO_KEY_ERROR);

  return provider === "openai"
    ? openAiText(options)
    : geminiText(options);
}

async function openAiText({
  system,
  user,
  image,
  maxTokens = 512,
}: GenerateOptions): Promise<string> {
  const client = new OpenAI({ apiKey: keyFor("OPENAI_API_KEY")! });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: user },
  ];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    });
  }

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    max_completion_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

async function geminiText({
  system,
  user,
  image,
  maxTokens = 512,
  temperature = 0.5,
}: GenerateOptions): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: keyFor("GEMINI_API_KEY")! });

  const contents: object[] = [{ text: user }];
  if (image) {
    contents.push({
      inlineData: { mimeType: image.mimeType, data: image.base64 },
    });
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: system,
      temperature,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("The model hit its output limit before finishing");
  }

  try {
    return response.text?.trim() || "";
  } catch {
    // Gemini throws on text access when it returns no usable candidate.
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

/**
 * Both providers want a schema, in different dialects. Every JSON response the
 * game needs is a flat object of required strings, so callers pass field names
 * and this builds whichever shape the active provider expects.
 */
export async function generateStringMap(
  options: GenerateOptions & { fields: readonly string[]; schemaName: string },
): Promise<Record<string, string>> {
  const provider = activeProvider();
  if (!provider) throw new Error(NO_KEY_ERROR);

  const raw =
    provider === "openai"
      ? await openAiStringMap(options)
      : await geminiStringMap(options);

  if (!raw) throw new Error("The model returned no JSON");
  return JSON.parse(raw) as Record<string, string>;
}

async function openAiStringMap({
  system,
  user,
  image,
  fields,
  schemaName,
  maxTokens = 2_048,
}: GenerateOptions & {
  fields: readonly string[];
  schemaName: string;
}): Promise<string> {
  const client = new OpenAI({ apiKey: keyFor("OPENAI_API_KEY")! });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: user },
  ];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    });
  }

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    max_completion_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema: {
          type: "object",
          // strict mode requires every property listed and no extras.
          properties: Object.fromEntries(
            fields.map((field) => [field, { type: "string" }]),
          ),
          required: [...fields],
          additionalProperties: false,
        },
      },
    },
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

async function geminiStringMap({
  system,
  user,
  image,
  fields,
  maxTokens = 2_048,
  temperature = 0.6,
}: GenerateOptions & {
  fields: readonly string[];
  schemaName: string;
}): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: keyFor("GEMINI_API_KEY")! });

  const contents: object[] = [{ text: user }];
  if (image) {
    contents.push({
      inlineData: { mimeType: image.mimeType, data: image.base64 },
    });
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: system,
      temperature,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: Object.fromEntries(
          fields.map((field) => [field, { type: Type.STRING }]),
        ),
        required: [...fields],
      },
    },
  });

  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("The model hit its output limit before finishing");
  }

  try {
    return response.text?.trim() || "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageCheck =
  | { ok: true; image: AiImage }
  | { ok: false; error: string; status: number };

/** Shared validation so every route rejects bad uploads identically. */
export async function readImage(value: FormDataEntryValue | null): Promise<ImageCheck> {
  if (!(value instanceof File) || !value.type.startsWith("image/")) {
    return { ok: false, error: "A valid image is required", status: 400 };
  }
  if (value.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: "The image must be 10 MB or smaller", status: 413 };
  }
  return {
    ok: true,
    image: {
      mimeType: value.type,
      base64: Buffer.from(await value.arrayBuffer()).toString("base64"),
    },
  };
}
