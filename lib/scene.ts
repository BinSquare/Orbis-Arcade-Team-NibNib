/**
 * THE TUNING FILE. Hand-edit this; it holds no logic.
 *
 * Everything the model is ever told about the world lives here. The rule that
 * makes prompt morphing work instead of cutting: SETTING and CAMERA must be
 * byte-identical on every single send. Only PHASE changes. If you retype the
 * setting slightly differently between sends, the model treats it as a new
 * scene and you get a cut.
 *
 * Constraints worth remembering while you tune (from the API reference):
 *  - Generation is 832x480 before upscaling. No faces, no text, no fine detail.
 *  - Water, light, sky, landscape. Things that move without needing to be sharp.
 *  - A prompt lands at the next chunk boundary, ~1.8s. Nothing here is instant.
 */

export const SETTING =
  "a wide shallow tidal lagoon at dawn, pale sand below clear water, " +
  "low mist on the far shoreline, soft overcast light";

export const CAMERA =
  "a locked-off wide shot, camera perfectly still, horizon level and low";

/** Closing clause. Also byte-identical every send — it is what buys continuity. */
export const CONTINUITY = "Continuous slow motion, no cuts, a single unbroken take.";

/**
 * PHASES are the only thing that varies. Each is one clause describing the
 * water's motion. They are ordered from fastest/most agitated to slowest/most
 * still, so the entrainment loop at Gate 4 can index into them by breath rate.
 *
 * Keep every phrase the same grammatical shape. The model is steadier when the
 * only thing that changes between two prompts is the adjectives.
 */
export const PHASES = [
  "The water moves in quick shallow ripples, many small crests crossing each other",
  "The ripples lengthen and begin to travel in one direction",
  "Long low swells roll through slowly, one after another",
  "The swells arrive further apart, the surface smoothing between them",
  "The surface is almost still, one slow swell passing through and fading",
  "The water is glassy and barely moves, the mist settling onto it",
] as const;

/**
 * The prompt template. SETTING and CAMERA are interpolated verbatim, never
 * reworded. This is the single place a prompt string is ever built.
 */
export function buildPrompt(phase: string) {
  return `The same ${SETTING}, the same ${CAMERA}. ${phase}. ${CONTINUITY}`;
}

/** The fixed opening prompt. Sent once before start; Gate 2 morphs away from it. */
export const OPENING_PROMPT = buildPrompt(PHASES[0]);

/**
 * One-sentence SOUND caption, not a scene description (the API reference is
 * explicit about this, and only ~128 tokens are read).
 *
 * UNVERIFIED as a live lever: audio_prompt_accepted is documented as applying
 * "from the next start", which implies it does NOT hot-swap mid-run. Gate 2
 * spends 30 seconds testing that and then either uses it or drops it for good.
 */
export const AUDIO_PROMPT =
  "Slow shallow water lapping over sand, distant and soft, no music, no voices.";
