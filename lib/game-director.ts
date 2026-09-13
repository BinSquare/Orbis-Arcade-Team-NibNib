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
  describeDouse,
  describeFires,
  describePose,
  fireSignature,
  poseBucket,
  type CameraPose,
  type Fire,
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
  /** Fires currently burning, lit by clicks and put out by right clicks. */
  fires: Fire[];
  /** Set on the chunk a douse happens, so it can be shown going out. */
  dousedZone?: string;
  /** Chunk index, which drives how fierce each fire reads. */
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
  "ignite",
  "douse",
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
  /** Left click: what catches fire at {zone}. Must contain {zone}. */
  ignite: string;
  /** Right click: the fire going out at {zone}. Must contain {zone}. */
  douse: string;
  /** Short re-anchor, <= 25 words, repeated every prompt to prevent drift. */
  anchor: string;
};

/**
 * Used when Gemini is unavailable. Deliberately generic — this is the "IMAGE
 * ONLY" experience, and it is exactly the weak phrasing the lexicon replaces.
 */
export function fallbackLexicon(world: string): ActionLexicon {
  return {
    // Scenery fragments only — the camera verb is prepended by the composer.
    forward: "deeper into the scene, past whatever stands nearest",
    back: "away from the scene, the surroundings opening out",
    strafeLeft: "sideways past what stands to the left",
    strafeRight: "sideways past what stands to the right",
    turnLeft: "swinging what was off-frame to the left into view",
    turnRight: "swinging what was off-frame to the right into view",
    rise: "up and over, revealing more of the space below",
    descend: "down toward the ground and what rests on it",
    idle: "the scene keeps moving on its own",
    sprint: "fast and urgent",
    ignite:
      "flames erupt at the {zone} and catch fast, smoke rising in a bright column",
    douse: "the flames at the {zone} collapse into steam and blackened remains",
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
  const { input, pose, fires } = context;

  const actions = MOVEMENT_ACTIONS.filter((action) => input.actions.has(action));
  if (input.actions.has("sprint")) actions.push("sprint");

  const aim = input.pointer ? describeZone(input.pointer) : "none";
  const click = input.clicks[input.clicks.length - 1];
  const act = click ? `${click.kind}@${describeZone(click)}` : "none";
  return `${actions.join("+") || "idle"}|${aim}|${act}|${poseBucket(pose)}|${fireSignature(fires, context.chunk)}`;
}

/** Plain-English situation report handed to the live director. */
export function describeSituation(context: DirectorContext): string {
  const { input, pose, fires, dousedZone, chunk } = context;
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

  const fire = describeFires(fires, chunk);
  if (fire) parts.push(fire);
  if (dousedZone) parts.push(describeDouse(dousedZone));

  const click = input.clicks[input.clicks.length - 1];
  if (click && click.kind === "primary") {
    parts.push(`A fire has just been lit at ${describePrecise(click)}.`);
  }

  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * Film-grammar camera terms, hardcoded rather than left to the lexicon.
 *
 * A video model reacts to "dolly in" far more strongly than to a description
 * of what the shot would contain. The first version asked the model to write
 * scenery ("the retriever's mouth fills the view"), which reads as a static
 * state and rendered as one — the camera never actually moved.
 */
const CAMERA_MOVES: Record<string, string> = {
  forward: "dolly in",
  back: "dolly out",
  strafeLeft: "truck left",
  strafeRight: "truck right",
  turnLeft: "pan left",
  turnRight: "pan right",
  rise: "crane up",
  descend: "crane down",
};

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(", ")} while ${clauses[clauses.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The lexicon returns bare fragments; make one a sentence. */
function sentence(text: string): string {
  const trimmed = capitalize(text.trim());
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Builds a full Orbis prompt.
 *
 * Kept deliberately short and motion-dominant. The first version was 65 words
 * of which ~60 were unchanging scene description, so consecutive prompts were
 * 97% identical and the video simply carried on doing what it was doing. Now
 * the camera instruction leads, the world anchor is dropped entirely while
 * moving (it is dead weight that dilutes the only part that matters), and it
 * returns only when the player is still and drift is the real risk.
 */
export function composeFromLexicon(
  lexicon: ActionLexicon,
  context: DirectorContext,
): string {
  const { input, pose, fires, dousedZone, chunk } = context;
  const moving = MOVEMENT_ACTIONS.filter((action) => input.actions.has(action));
  const fast = input.actions.has("sprint");
  const sentences: string[] = [];

  if (moving.length) {
    // Lead with the bare camera instruction, stated imperatively.
    const moves = moving.map((action) => CAMERA_MOVES[action]).join(" and ");
    sentences.push(`${capitalize(fast ? `fast ${moves}` : moves)}, continuously.`);

    // One scenery clause for grounding — what the move carries us past.
    sentences.push(sentence(lexicon[moving[0]]));
    sentences.push(describePose(pose));
  } else {
    sentences.push("The camera comes to rest and holds still.");
    sentences.push(sentence(lexicon.idle));
    // Re-anchor only when the frame is otherwise static. A burning fire is a
    // strong enough subject on its own, and the anchor would just dilute it.
    if (!fires.length) sentences.push(sentence(lexicon.anchor));
  }

  // A brand-new fire gets the lexicon's vivid ignition line; everything still
  // burning is summarised after it so the frame stays consistent.
  const click = input.clicks[input.clicks.length - 1];
  const justLit = click?.kind === "primary";
  if (justLit && click) {
    sentences.push(
      sentence(lexicon.ignite.replaceAll("{zone}", describeZone(click))),
    );
  }
  if (dousedZone) {
    sentences.push(sentence(lexicon.douse.replaceAll("{zone}", dousedZone)));
  }

  const fire = describeFires(justLit ? fires.slice(0, -1) : fires, chunk);
  if (fire) sentences.push(fire);

  sentences.push("Continuous shot, no cuts.");
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
