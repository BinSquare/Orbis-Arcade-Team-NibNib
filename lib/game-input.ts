/**
 * Input primitives: key bindings, pointer state, and the spatial vocabulary
 * used to describe screen positions.
 *
 * Turning this state into an actual Orbis prompt is the AI director's job —
 * see `lib/game-director.ts`. This module only captures and names things.
 */

export type GameAction =
  | "forward"
  | "back"
  | "strafeLeft"
  | "strafeRight"
  | "turnLeft"
  | "turnRight"
  | "rise"
  | "descend"
  | "sprint";

/** Physical keys, lowercased, mapped to the action they hold down. */
const KEY_BINDINGS: Record<string, GameAction> = {
  w: "forward",
  arrowup: "forward",
  s: "back",
  arrowdown: "back",
  a: "strafeLeft",
  arrowleft: "strafeLeft",
  d: "strafeRight",
  arrowright: "strafeRight",
  q: "turnLeft",
  e: "turnRight",
  " ": "rise",
  c: "descend",
  shift: "sprint",
};

/** Keys the viewport swallows so the page never scrolls mid-run. */
const SWALLOWED_KEYS = new Set(Object.keys(KEY_BINDINGS));

export function actionForKey(key: string): GameAction | null {
  return KEY_BINDINGS[key.toLowerCase()] ?? null;
}

export function swallowsKey(key: string): boolean {
  return SWALLOWED_KEYS.has(key.toLowerCase());
}

/** Keycap rows rendered by the HUD, in physical keyboard layout order. */
export const KEYCAP_ROWS: { label: string; action: GameAction }[][] = [
  [
    { label: "Q", action: "turnLeft" },
    { label: "W", action: "forward" },
    { label: "E", action: "turnRight" },
  ],
  [
    { label: "A", action: "strafeLeft" },
    { label: "S", action: "back" },
    { label: "D", action: "strafeRight" },
  ],
  [
    { label: "SHIFT", action: "sprint" },
    { label: "SPACE", action: "rise" },
    { label: "C", action: "descend" },
  ],
];

export type ClickKind = "primary" | "alternate";

export type PointerPoint = {
  /** Normalized 0-1 across the video surface, origin top-left. */
  x: number;
  y: number;
};

export type GameClick = PointerPoint & {
  kind: ClickKind;
  /** Monotonic id so the renderer can key ripples and the loop can dedupe. */
  id: number;
};

export type GameInputState = {
  actions: Set<GameAction>;
  pointer: PointerPoint | null;
  /** Clicks captured since the last directive was sent. */
  clicks: GameClick[];
};

export function emptyInputState(): GameInputState {
  return { actions: new Set(), pointer: null, clicks: [] };
}

/* ------------------------------------------------------------------ */
/* Spatial language                                                    */
/* ------------------------------------------------------------------ */

const COLUMN_WORDS = ["left", "center", "right"] as const;
const ROW_WORDS = ["upper", "middle", "lower"] as const;

function band(value: number): 0 | 1 | 2 {
  if (value < 1 / 3) return 0;
  if (value < 2 / 3) return 1;
  return 2;
}

/** "upper left", "center", "lower right" — how a director would say it. */
export function describeZone(point: PointerPoint): string {
  const row = ROW_WORDS[band(point.y)];
  const column = COLUMN_WORDS[band(point.x)];
  if (row === "middle" && column === "center") return "center of the frame";
  if (row === "middle") return `${column} side of the frame`;
  if (column === "center") return `${row} center of the frame`;
  return `${row} ${column} of the frame`;
}

/** Percentages keep the model honest when two zones read alike. */
export function describePrecise(point: PointerPoint): string {
  const across = Math.round(point.x * 100);
  const down = Math.round(point.y * 100);
  return `${across}% across and ${down}% down`;
}

/** Movement reads best in a fixed order regardless of press order. */
const BRIEF_ORDER: GameAction[] = [
  "forward",
  "back",
  "strafeLeft",
  "strafeRight",
  "turnLeft",
  "turnRight",
  "rise",
  "descend",
];

/** Short label for the HUD — what the player is doing, in two or three words. */
export function describeInputBriefly(state: GameInputState): string {
  const parts: string[] = [];
  const sprinting = state.actions.has("sprint");

  for (const action of BRIEF_ORDER) {
    if (!state.actions.has(action)) continue;
    parts.push(
      {
        forward: "FORWARD",
        back: "BACK",
        strafeLeft: "LEFT",
        strafeRight: "RIGHT",
        turnLeft: "TURN L",
        turnRight: "TURN R",
        rise: "RISE",
        descend: "DESCEND",
        sprint: "",
      }[action],
    );
  }

  if (!parts.length) parts.push("HOLD");
  if (sprinting) parts.unshift("FAST");
  if (state.clicks.length) parts.push("· ACT");
  return parts.join(" ");
}
