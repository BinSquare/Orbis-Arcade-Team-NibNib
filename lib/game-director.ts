/**
 * The AI director: turns player input into image-grounded Orbis prompts.
 *
 * Orbis steers at ~1.8s chunk boundaries and a Gemini call takes 1-3s, so a
 * synchronous call per chunk is impossible. Two layers solve that instead:
 *
 *  1. A LEXICON, generated once when the world loads. Gemini looks at the
 *     actual image and writes how each movement reads *in this scene* — not
 *     "the camera pushes forward" but what pushing forward through this
 *     specific place looks like. Composition from the lexicon is instant.
 *
 *  2. A DIRECTOR, called asynchronously per distinct input combination. Its
 *     result is cached against that combination, so the first time you hold
 *     forward-left you get the composed prompt and every time after you get
 *     Gemini's. Players hold inputs for seconds at a time, so the cache warms
 *     almost immediately and never adds latency to a boundary.
 */

import {
  describeEvents,
  describePose,
  poseBucket,
  type CameraPose,
  type WorldEvent,
} from "@/lib/game-camera";
import {
  describePrecise,
  describeZone,
  type GameAction,
  type GameInputState,
} from "@/lib/game-input";

/** Everything a prompt is built from: live input plus accumulated state. */
export type DirectorContext = {
  input: GameInputState;
  pose: CameraPose;
  events: WorldEvent[];
  /** Chunk index, used to tell a fresh interaction from a lingering one. */
  chunk: number;
};

/** The lexicon's fields, in one place so the route can build a JSON schema. */
export const LEXICON_FIELDS = [
  "forward",
  "back",
  "strafeLeft",
  "strafeRight",
  "turnLeft",
  "turnRight",
  "rise",
  "descend",
  "idle",
  "sprint",
  "interact",
  "calm",
  "anchor",
] as const;

/** Movement keys, in the fixed order clauses are read out in. */
export const MOVEMENT_ACTIONS: GameAction[] = [
  "forward",
  "back",
  "strafeLeft",
  "strafeRight",
  "turnLeft",
  "turnRight",
  "rise",
  "descend",
];

export type ActionLexicon = {
  forward: string;
  back: string;
  strafeLeft: string;
  strafeRight: string;
  turnLeft: string;
  turnRight: string;
  rise: string;
  descend: string;
  /** What the scene does when the player is not moving. */
  idle: string;
  /** Adverbial phrase applied when sprinting, e.g. "fast and urgent". */
  sprint: string;
  /** Left click. Must contain {zone}. */
  interact: string;
  /** Right click. Must contain {zone}. */
  calm: string;
  /** Short re-anchor, <= 25 words, repeated every prompt to prevent drift. */
  anchor: string;
};

/**
 * Used when Gemini is unavailable. Deliberately generic — this is the "IMAGE
 * ONLY" experience, and it is exactly the weak phrasing the lexicon replaces.
 */
export function fallbackLexicon(world: string): ActionLexicon {
  return {
    forward: "the camera pushes forward, deeper into the scene",
    back: "the camera pulls back, away from the scene",
    strafeLeft: "the camera slides to the left",
    strafeRight: "the camera slides to the right",
    turnLeft: "the view turns left, revealing what was off-frame",
    turnRight: "the view turns right, revealing what was off-frame",
    rise: "the camera rises for a higher vantage",
    descend: "the camera lowers toward the ground",
    idle: "the camera holds steady while the scene keeps moving on its own",
    sprint: "fast and urgent",
    interact:
      "whatever sits at the {zone} reacts, stirs, and moves in response",
    calm: "whatever sits at the {zone} settles, backs away, and goes still",
    anchor: world.split(/\s+/).slice(0, 25).join(" "),
  };
}

/* ------------------------------------------------------------------ */
/* Input signatures                                                    */
/* ------------------------------------------------------------------ */

/**
 * A stable key for the whole situation, not just the keys held. Pose is
 * bucketed coarsely and aim to a 3x3 zone, so small drift reuses a cached
 * prompt instead of thrashing the director — but genuinely moving somewhere
 * new correctly invalidates it.
 */
export function signatureOf(context: DirectorContext): string {
  const { input, pose, events } = context;

  const actions = MOVEMENT_ACTIONS.filter((action) => input.actions.has(action));
  if (input.actions.has("sprint")) actions.push("sprint");

  const aim = input.pointer ? describeZone(input.pointer) : "none";
  const click = input.clicks[input.clicks.length - 1];
  const act = click ? `${click.kind}@${describeZone(click)}` : "none";
  const memory = events.map((event) => `${event.kind[0]}${event.zone[0]}`).join("");

  return `${actions.join("+") || "idle"}|${aim}|${act}|${poseBucket(pose)}|${memory}`;
}

/** Plain-English situation report handed to the live director. */
export function describeSituation(context: DirectorContext): string {
  const { input, pose, events, chunk } = context;
  const parts: string[] = [];

  const moving = MOVEMENT_ACTIONS.filter((action) => input.actions.has(action));
  parts.push(
    moving.length
      ? `Camera movement this instant: ${moving.join(", ")}${
          input.actions.has("sprint") ? " (fast)" : ""
        }.`
      : "Camera movement this instant: none, holding position.",
  );

  // The pose is the difference between a coherent run and a reset every chunk.
  parts.push(describePose(pose));

  if (input.pointer) {
    parts.push(`Attention is on the ${describeZone(input.pointer)}.`);
  }

  const memory = describeEvents(events, chunk);
  if (memory) parts.push(memory);

  const click = input.clicks[input.clicks.length - 1];
  if (click) {
    parts.push(
      `The player just ${click.kind === "primary" ? "acted on" : "calmed"} the point ${describePrecise(click)}.`,
    );
  }

  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(", ")} while ${clauses[clauses.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Builds a full Orbis prompt from the lexicon and the accumulated state.
 *
 * Order matters: the motion being applied leads (it is what changed), then
 * where the camera has got to, then what is still disturbed, then the anchor.
 * Leading with the world buried the only part that varies between chunks.
 */
export function composeFromLexicon(
  lexicon: ActionLexicon,
  context: DirectorContext,
): string {
  const { input, pose, events, chunk } = context;
  const moving = MOVEMENT_ACTIONS.filter((action) => input.actions.has(action));
  const sentences: string[] = [];

  if (moving.length) {
    const clauses = moving.map((action) => lexicon[action]);
    const speed = input.actions.has("sprint") ? `, ${lexicon.sprint}` : "";
    sentences.push(`${capitalize(joinClauses(clauses))}${speed}.`);
  } else {
    sentences.push(`${capitalize(lexicon.idle)}.`);
  }

  sentences.push(describePose(pose));

  if (input.pointer) {
    sentences.push(`The ${describeZone(input.pointer)} stays clearly in view.`);
  }

  const click = input.clicks[input.clicks.length - 1];
  if (click) {
    const template = click.kind === "primary" ? lexicon.interact : lexicon.calm;
    sentences.push(
      `${capitalize(template.replaceAll("{zone}", describeZone(click)))}.`,
    );
  }

  const memory = describeEvents(events, chunk);
  // The freshest click is already spoken for by the lexicon line above.
  if (memory && !click) sentences.push(memory);

  sentences.push(lexicon.anchor);
  sentences.push("Continuous shot, no cuts, consistent world and subjects.");

  return sentences.join(" ");
}

/* ------------------------------------------------------------------ */
/* Client helpers                                                      */
/* ------------------------------------------------------------------ */

export type LexiconResult = {
  lexicon: ActionLexicon;
  /** False when the fallback was used, so the UI can say so honestly. */
  grounded: boolean;
};

/** One call at world load: how does this image move? */
export async function requestLexicon(
  image: File,
  world: string,
): Promise<LexiconResult> {
  const body = new FormData();
  body.append("image", image);
  body.append("world", world);

  try {
    const response = await fetch("/api/lexicon", { method: "POST", body });
    const result = (await response.json()) as {
      lexicon?: ActionLexicon;
      error?: string;
    };
    if (response.ok && result.lexicon?.forward) {
      return { lexicon: result.lexicon, grounded: true };
    }
    console.warn("Lexicon unavailable:", result.error);
  } catch (caught) {
    console.warn("Lexicon request failed", caught);
  }

  return { lexicon: fallbackLexicon(world), grounded: false };
}

/**
 * Asks Gemini for a bespoke prompt for one input combination. Best-effort: the
 * caller always has the composed prompt to fall back on, so a failure here
 * costs nothing but a slightly less vivid chunk.
 */
export async function requestDirection(
  world: string,
  situation: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch("/api/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world, situation }),
      signal,
    });
    const result = (await response.json()) as {
      prompt?: string;
      error?: string;
    };
    if (response.ok && result.prompt) return result.prompt;
    return null;
  } catch {
    return null;
  }
}
