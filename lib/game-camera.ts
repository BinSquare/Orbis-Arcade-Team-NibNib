/**
 * Camera pose and world memory.
 *
 * The original design sent each chunk an independent instruction ("push
 * forward") with no notion of where the camera already was. The video model
 * therefore re-interpreted the scene every 1.8s and the world felt incoherent:
 * holding W did not accumulate into travel, and a click's effect vanished on
 * the next chunk.
 *
 * So WASD now integrates into an actual pose, and clicks append to a memory of
 * what the player has disturbed. Prompts describe *where the camera is* and
 * *what has already happened*, which is what gives a run continuity.
 */

import type { ClickKind, GameAction, GameInputState } from "@/lib/game-input";
import { describeZone } from "@/lib/game-input";

/**
 * Abstract units per second, scaled against the limits below so that ONE chunk
 * (~1.8s) of held input visibly changes the pose language. At 1.0 against a
 * limit of 12 a full chunk of W moved 0.15 of the scale, which read as the same
 * sentence twice and made the controls feel dead.
 */
const MOVE_SPEED = 2.4;
const RISE_SPEED = 1.6;
const TURN_SPEED = 45; // degrees per second
const SPRINT_MULTIPLIER = 2.2;

/** Beyond this the language stops differentiating, so stop accumulating. */
const MAX_TRAVEL = 9;
const MAX_ELEVATION = 4;

export type CameraPose = {
  /** Signed distance along the view axis. Positive is forward. */
  advance: number;
  /** Signed lateral offset. Positive is right. */
  strafe: number;
  /** Signed height change. Positive is up. */
  elevation: number;
  /** Cumulative yaw in degrees. Positive is right (clockwise from above). */
  yaw: number;
};

export function initialPose(): CameraPose {
  return { advance: 0, strafe: 0, elevation: 0, yaw: 0 };
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** Advances the pose by one tick of held input. */
export function integrate(
  pose: CameraPose,
  actions: Set<GameAction>,
  deltaSeconds: number,
): CameraPose {
  const boost = actions.has("sprint") ? SPRINT_MULTIPLIER : 1;
  const step = MOVE_SPEED * boost * deltaSeconds;
  const lift = RISE_SPEED * boost * deltaSeconds;
  const turn = TURN_SPEED * boost * deltaSeconds;

  let { advance, strafe, elevation, yaw } = pose;

  if (actions.has("forward")) advance += step;
  if (actions.has("back")) advance -= step;
  if (actions.has("strafeRight")) strafe += step;
  if (actions.has("strafeLeft")) strafe -= step;
  if (actions.has("rise")) elevation += lift;
  if (actions.has("descend")) elevation -= lift;
  if (actions.has("turnRight")) yaw += turn;
  if (actions.has("turnLeft")) yaw -= turn;

  return {
    advance: clamp(advance, MAX_TRAVEL),
    strafe: clamp(strafe, MAX_TRAVEL),
    elevation: clamp(elevation, MAX_ELEVATION),
    // Yaw wraps: a full turn should read as back where you started.
    yaw: ((yaw % 360) + 540) % 360 - 180,
  };
}

/* ------------------------------------------------------------------ */
/* Pose language                                                       */
/* ------------------------------------------------------------------ */

function magnitude(value: number, scale: number): "none" | "slight" | "moderate" | "far" {
  const size = Math.abs(value) / scale;
  if (size < 0.15) return "none";
  if (size < 0.4) return "slight";
  if (size < 0.8) return "moderate";
  return "far";
}

const TRAVEL_WORDS = {
  slight: "a little way",
  moderate: "a fair distance",
  far: "a long way",
} as const;

/**
 * Describes how far the person has walked from where they started. Absolute
 * coordinates mean nothing to a video model, but "well in from where the walk
 * began, turned about 45 degrees left" is something it can hold onto.
 */
export function describePose(pose: CameraPose): string {
  const parts: string[] = [];

  const travel = magnitude(pose.advance, MAX_TRAVEL);
  if (travel !== "none") {
    parts.push(
      pose.advance > 0
        ? `${TRAVEL_WORDS[travel]} further in than where the walk began`
        : `${TRAVEL_WORDS[travel]} back from where the walk began`,
    );
  }

  const lateral = magnitude(pose.strafe, MAX_TRAVEL);
  if (lateral !== "none") {
    parts.push(
      `${TRAVEL_WORDS[lateral]} to the ${pose.strafe > 0 ? "right" : "left"} of the starting point`,
    );
  }

  const height = magnitude(pose.elevation, MAX_ELEVATION);
  if (height !== "none") {
    parts.push(
      pose.elevation > 0
        ? `${height === "far" ? "up high" : "raised"} above the original eye level`
        : `${height === "far" ? "crouched near the ground" : "lowered"}`,
    );
  }

  // Round to 15 degrees: finer than that is noise the model cannot render.
  const yaw = Math.round(pose.yaw / 15) * 15;
  if (Math.abs(yaw) >= 15) {
    parts.push(
      `rotated about ${Math.abs(yaw)} degrees to the ${yaw > 0 ? "right" : "left"}`,
    );
  }

  if (!parts.length) {
    return "Still standing where the scene opened, facing the same way.";
  }

  // Two clauses is the most that reads cleanly; more buries the movement the
  // prompt is actually about. `parts` is already in significance order.
  return `The viewpoint is now ${parts.slice(0, 2).join(", ")}.`;
}

/**
 * Coarse bucket for cache keys. Two poses in the same bucket describe the same
 * way, so they can share a directed prompt.
 */
export function poseBucket(pose: CameraPose): string {
  const b = (value: number, scale: number) =>
    Math.round((clamp(value, scale) / scale) * 4);
  return [
    b(pose.advance, MAX_TRAVEL),
    b(pose.strafe, MAX_TRAVEL),
    b(pose.elevation, MAX_ELEVATION),
    Math.round(pose.yaw / 45),
  ].join(",");
}

/* ------------------------------------------------------------------ */
/* Fire                                                                */
/* ------------------------------------------------------------------ */

/**
 * Left click ignites the spot under the crosshair; right click douses it.
 *
 * Fire is the one interaction that reads unmistakably on video — flame, smoke
 * and firelight change the frame far more than "something reacts" ever did.
 * Fires persist until doused rather than ageing out, and they intensify with
 * every chunk they survive, so a run accumulates real consequences.
 */
export type Fire = {
  zone: string;
  x: number;
  y: number;
  /** Chunk index it was lit on, which drives how fierce it reads. */
  litAt: number;
};

/** Past this the prompt gets crowded and every fire reads the same. */
const MAX_FIRES = 4;
/** Normalized screen distance within which a douse puts a fire out. */
const DOUSE_RADIUS = 0.22;

export function igniteAt(
  fires: Fire[],
  click: { x: number; y: number },
  chunk: number,
): Fire[] {
  // Clicking an existing fire feeds it rather than stacking a duplicate.
  const existing = fires.find((fire) => distance(fire, click) < DOUSE_RADIUS);
  if (existing) return fires;
  return [
    ...fires,
    { zone: describeZone(click), x: click.x, y: click.y, litAt: chunk },
  ].slice(-MAX_FIRES);
}

export function douseAt(fires: Fire[], click: { x: number; y: number }): Fire[] {
  return fires.filter((fire) => distance(fire, click) >= DOUSE_RADIUS);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** How fierce a fire reads, from the chunks it has survived. */
function intensity(fire: Fire, chunk: number): string {
  const age = chunk - fire.litAt;
  if (age <= 0) return "flames just catching, small and bright";
  if (age === 1) return "flames climbing steadily with rising smoke";
  if (age <= 3) return "burning hard, thick smoke, embers lifting";
  return "an intense blaze, heavy black smoke, glowing embers everywhere";
}

/**
 * Fire language for the prompt. Firelight is called out explicitly because it
 * is what ties the fire into the rest of the frame rather than leaving it a
 * sticker floating on top of the scene.
 */
export function describeFires(fires: Fire[], chunk: number): string {
  if (!fires.length) return "";

  const parts = fires.map(
    (fire) => `at the ${fire.zone}, ${intensity(fire, chunk)}`,
  );

  const lead =
    fires.length === 1
      ? `Fire burns ${parts[0]}.`
      : `Fires burn ${parts.join("; and ")}.`;

  return `${lead} Firelight flickers across everything nearby and smoke drifts upward.`;
}

/** Doused this chunk, so the prompt can show the fire going out. */
export function describeDouse(zone: string): string {
  return `The fire at the ${zone} is smothered — flames collapse into steam and drifting smoke over blackened, wet remains.`;
}

/** Cache key fragment: which fires exist and how fierce each reads. */
export function fireSignature(fires: Fire[], chunk: number): string {
  return fires
    .map((fire) => `${fire.zone[0]}${Math.min(4, chunk - fire.litAt)}`)
    .join(",");
}
