import type { ActionLexicon } from "@/lib/game-director";

/**
 * The world description is prepended to *every* steering directive, so it has
 * to stay short and stay stable — it is the anchor that stops a long run from
 * drifting away from the player's image.
 */
export const WORLD_SYSTEM_INSTRUCTION = `You are a level designer describing a
playable world to a real-time image-to-video model.

Look at the attached image and describe it as a living, explorable place in
present tense. Name the setting, the main subjects and their appearance, the
materials, the lighting, the mood, and the depth of the space — what lies
nearer the camera and what lies further back.

Hard requirements:
- Under 70 words. Finish every sentence.
- Describe only what is visible. Invent nothing that contradicts the image.
- Describe the place, never a specific camera move and never a specific action.
  The player controls those; your text must stay true no matter where they go.
- No meta-language: never write "the image shows" or "this photo".
- Plain text only. No Markdown, no headings, no labels, no commentary.`;

/** Used when Gemini is unavailable so the game still runs on the image alone. */
export function fallbackWorld(imageName: string): string {
  return `A living, explorable scene built from ${imageName || "the uploaded image"}. Every subject, material, color, and light source in the source image stays exactly as it appears, and the space extends naturally in all directions with consistent depth and atmosphere. Photorealistic, cinematic, richly detailed.`;
}

export type WorldResult = {
  world: string;
  /** False when the fallback was used, so the UI can say so honestly. */
  grounded: boolean;
};

/** Asks the server to turn the image into a world description. */
export async function requestWorld(image: File): Promise<WorldResult> {
  const body = new FormData();
  body.append("image", image);

  try {
    const response = await fetch("/api/world", { method: "POST", body });
    const result = (await response.json()) as {
      world?: string;
      error?: string;
    };
    if (response.ok && result.world) {
      return { world: result.world, grounded: true };
    }
    console.warn("World grounding unavailable:", result.error);
  } catch (caught) {
    console.warn("World grounding request failed", caught);
  }

  // Grounding is a nicety, not a dependency — never block play on it.
  return { world: fallbackWorld(image.name), grounded: false };
}

/** Everything a run needs: the image, its world text, and its movement lexicon. */
export type WorldCartridge = {
  image: File;
  world: string;
  /** True when Gemini wrote the world text rather than the fallback. */
  worldGrounded: boolean;
  lexicon: ActionLexicon;
  /** True when Gemini wrote the movement lexicon rather than the fallback. */
  lexiconGrounded: boolean;
};
