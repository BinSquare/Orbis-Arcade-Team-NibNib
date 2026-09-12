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

/** Abstract units per second. Tuned so a couple of seconds of W reads as real travel. */
const MOVE_SPEED = 1.0;
const RISE_SPEED = 0.7;
const TURN_SPEED = 32; // degrees per second
const SPRINT_MULTIPLIER = 2.2;

/** Beyond this the language stops differentiating, so stop accumulating. */
const MAX_TRAVEL = 12;
const MAX_ELEVATION = 6;

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
 * Describes the pose as displacement from the opening view. Absolute
 * coordinates mean nothing to a video model, but "well past where it started,
 * turned about 45 degrees left" is something it can hold onto.
 */
export function describePose(pose: CameraPose): string {
  const parts: string[] = [];

  const travel = magnitude(pose.advance, MAX_TRAVEL);
  if (travel !== "none") {
    parts.push(
      pose.advance > 0
        ? `${TRAVEL_WORDS[travel]} deeper into the scene than the opening view`
        : `${TRAVEL_WORDS[travel]} back from the opening view`,
    );
  }

  const lateral = magnitude(pose.strafe, MAX_TRAVEL);
  if (lateral !== "none") {
    parts.push(
      `${TRAVEL_WORDS[lateral]} to the ${pose.strafe > 0 ? "right" : "left"} of where it started`,
    );
  }

  const height = magnitude(pose.elevation, MAX_ELEVATION);
  if (height !== "none") {
    parts.push(
      pose.elevation > 0
        ? `raised ${height === "far" ? "high" : "somewhat"} above the original eye level`
        : `lowered ${height === "far" ? "close to the ground" : "somewhat"}`,
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
    return "The camera is at its original vantage, exactly as the scene opened.";
  }

  return `The camera now sits ${parts.join(", ")}.`;
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
/* World memory                                                        */
/* ------------------------------------------------------------------ */

export type WorldEvent = {
  zone: string;
  kind: ClickKind;
  /** Chunk index the event happened on, for ageing it out. */
  at: number;
};

/** Interactions stay in the prompt this many chunks before being dropped. */
const EVENT_MEMORY = 3;

export function recordEvent(
  log: WorldEvent[],
  state: GameInputState,
  chunk: number,
): WorldEvent[] {
  const click = state.clicks[state.clicks.length - 1];
  if (!click) return log;
  return [
    ...log,
    { zone: describeZone(click), kind: click.kind, at: chunk },
  ].slice(-EVENT_MEMORY);
}

export function ageEvents(log: WorldEvent[], chunk: number): WorldEvent[] {
  return log.filter((event) => chunk - event.at < EVENT_MEMORY);
}

/**
 * Turns the log into persistence language. Without this a disturbed thing
 * snaps back to its original state on the very next chunk.
 */
export function describeEvents(log: WorldEvent[], chunk: number): string {
  if (!log.length) return "";

  const newest = log[log.length - 1];
  const older = log.slice(0, -1);
  const parts: string[] = [];

  parts.push(
    newest.at === chunk
      ? newest.kind === "primary"
        ? `Right now whatever sits at the ${newest.zone} is reacting — it moves, stirs, and draws attention.`
        : `Right now whatever sits at the ${newest.zone} is settling down and going still.`
      : newest.kind === "primary"
        ? `Whatever was disturbed at the ${newest.zone} is still active and has not returned to how it was.`
        : `Whatever was calmed at the ${newest.zone} remains still and settled.`,
  );

  if (older.length) {
    const zones = [...new Set(older.map((event) => event.zone))].join(" and the ");
    parts.push(`The ${zones} still shows the after-effects of earlier activity.`);
  }

  return parts.join(" ");
}
