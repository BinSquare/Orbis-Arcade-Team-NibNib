"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  describePose,
  douseAt,
  igniteAt,
  initialPose,
  integrate,
  type CameraPose,
  type Fire,
} from "@/lib/game-camera";
import {
  composeFromLexicon,
  describeSituation,
  requestDirection,
  signatureOf,
  type ActionLexicon,
  type DirectorContext,
} from "@/lib/game-director";
import { describeZone, type GameInputState } from "@/lib/game-input";

/**
 * Orbis emits a chunk roughly every 1.8s and applies whatever prompt it holds
 * at the boundary.
 *
 * The loop therefore sends the moment input changes rather than waiting for a
 * boundary of its own. Waiting cost up to a full chunk before the prompt was
 * even queued, and Orbis then took another chunk to apply it — about 3.6s from
 * keypress to picture. Sending immediately means the newest input is already
 * queued when the boundary arrives, roughly halving that.
 */
const CHUNK_PERIOD_MS = 1_800;
const FALLBACK_TICK_MS = 2_400;

/** Input sampling and camera integration rate. */
const INPUT_POLL_MS = 80;

/**
 * Floor between sends. Orbis only reads the prompt at a boundary, so more than
 * a few updates per chunk is wasted traffic — but a few is what guarantees the
 * latest input wins.
 */
const MIN_SEND_INTERVAL_MS = 350;

/** Cap the director cache so a long session cannot grow it without bound. */
const MAX_CACHED_DIRECTIONS = 60;
/** Never have more than this many director calls in flight at once. */
const MAX_INFLIGHT = 2;

export type GameLoopTelemetry = {
  /** The prompt that actually went to Orbis most recently. */
  lastSent: string;
  /** Whether that prompt came from the model or from lexicon composition. */
  lastSource: "director" | "composed" | "none";
  /** Prompts sent this run. */
  sentCount: number;
  /** Situations the model has written bespoke prompts for. */
  cachedCount: number;
  /** 0-1 progress toward the boundary where the queued prompt takes effect. */
  chunkProgress: number;
  /** True while something is sent-but-not-yet-applied, or still to be sent. */
  queued: boolean;
  /** Human-readable camera pose, for the HUD. */
  pose: string;
  /** Fires still burning. */
  eventCount: number;
  /** Where those fires are, so the viewport can mark them. */
  fires: { x: number; y: number; id: number }[];
  /** Live diagnostics: is the loop actually running and reaching Orbis? */
  diag: {
    ticks: number;
    attempts: number;
    ok: number;
    failed: number;
    chunks: number;
  };
};

type GameLoopOptions = {
  active: boolean;
  world: string;
  lexicon: ActionLexicon | null;
  /** Whether the director route is worth calling at all. */
  useDirector: boolean;
  chunkTick: number;
  readState: () => GameInputState;
  consumeClicks: () => void;
  steerTo: (prompt: string) => Promise<boolean>;
};

export function useGameLoop({
  active,
  world,
  lexicon,
  useDirector,
  chunkTick,
  readState,
  consumeClicks,
  steerTo,
}: GameLoopOptions): GameLoopTelemetry {
  const lastSigRef = useRef("");
  const lastSendAtRef = useRef(0);
  const lastTickAtRef = useRef(performance.now());
  const lastBoundaryRef = useRef(performance.now());
  const inFlightRef = useRef(false);

  /** Accumulated camera pose — the thing that makes WASD mean travel. */
  const poseRef = useRef<CameraPose>(initialPose());
  /** Fires the player has lit. They persist until doused, not on a timer. */
  const firesRef = useRef<Fire[]>([]);
  /** Zone doused this send, shown going out exactly once. */
  const dousedRef = useRef<string | undefined>(undefined);
  const chunkRef = useRef(0);

  const diagRef = useRef({ ticks: 0, attempts: 0, ok: 0, failed: 0, chunks: 0 });

  const cacheRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Set<string>());
  /**
   * Signatures the director failed on. Without this the input poll would retry
   * a failing signature every tick — the old code only warmed once per chunk,
   * so a failure was self-limiting; at 12.5Hz it would hammer the API. A failed
   * signature simply keeps using the composed prompt for the rest of the run.
   */
  const failedRef = useRef(new Set<string>());

  const [telemetry, setTelemetry] = useState<GameLoopTelemetry>({
    lastSent: "",
    lastSource: "none",
    sentCount: 0,
    cachedCount: 0,
    chunkProgress: 0,
    queued: false,
    pose: "",
    eventCount: 0,
    fires: [],
    diag: { ticks: 0, attempts: 0, ok: 0, failed: 0, chunks: 0 },
  });

  /** Fire positions for the HUD, keyed stably by when each was lit. */
  const firePoints = useCallback(
    () => firesRef.current.map((fire) => ({ x: fire.x, y: fire.y, id: fire.litAt })),
    [],
  );

  const contextNow = useCallback(
    (input: GameInputState): DirectorContext => ({
      input,
      pose: poseRef.current,
      fires: firesRef.current,
      dousedZone: dousedRef.current,
      chunk: chunkRef.current,
    }),
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Director warming                                                  */
  /* ---------------------------------------------------------------- */

  const warmDirector = useCallback(
    (signature: string, context: DirectorContext) => {
      if (!useDirector) return;
      if (cacheRef.current.has(signature)) return;
      if (pendingRef.current.has(signature)) return;
      if (failedRef.current.has(signature)) return;
      if (pendingRef.current.size >= MAX_INFLIGHT) return;

      pendingRef.current.add(signature);
      void requestDirection(world, describeSituation(context))
        .then((prompt) => {
          if (!prompt) {
            failedRef.current.add(signature);
            return;
          }
          const cache = cacheRef.current;
          // Evict oldest-first; Map preserves insertion order.
          if (cache.size >= MAX_CACHED_DIRECTIONS) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(signature, prompt);
          setTelemetry((current) => ({ ...current, cachedCount: cache.size }));
        })
        .finally(() => pendingRef.current.delete(signature));
    },
    [useDirector, world],
  );

  /* ---------------------------------------------------------------- */
  /* Steering                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Sends the current situation if it differs from what Orbis already holds.
   * Called from the input poll (so a keypress goes out at once), from every
   * chunk boundary, and from the stall fallback.
   */
  const steerNow = useCallback(async () => {
    if (!active || !lexicon || inFlightRef.current) return;

    const now = performance.now();
    if (now - lastSendAtRef.current < MIN_SEND_INTERVAL_MS) return;

    const input = readState();
    const hasClick = input.clicks.length > 0;

    // Apply the click to the world before building the prompt, so ignition
    // reads as happening now rather than one chunk late.
    const click = input.clicks[input.clicks.length - 1];
    if (click) {
      if (click.kind === "primary") {
        dousedRef.current = undefined;
        firesRef.current = igniteAt(firesRef.current, click, chunkRef.current);
      } else {
        const before = firesRef.current.length;
        firesRef.current = douseAt(firesRef.current, click);
        // Only announce a douse that actually put something out.
        dousedRef.current =
          firesRef.current.length < before ? describeZone(click) : undefined;
      }
    }

    const context = contextNow(input);
    const signature = signatureOf(context);

    // Motion must be re-sent every boundary even when the signature is
    // unchanged. Orbis continues whatever it was doing, so an unreinforced
    // camera move coasts to a halt — and the pose bucket saturates after a few
    // seconds of held input, which used to stop the sends entirely. Dedupe only
    // applies when the player is still.
    const moving = input.actions.size > 0 || firesRef.current.length > 0;
    if (signature === lastSigRef.current && !hasClick && !moving) {
      warmDirector(signature, context);
      return;
    }

    const directed = cacheRef.current.get(signature);
    const prompt = directed ?? composeFromLexicon(lexicon, context);

    inFlightRef.current = true;
    lastSendAtRef.current = now;
    diagRef.current.attempts += 1;
    // Clear first: a click arriving mid-send belongs to the next send, not this
    // one, and must not be silently dropped.
    consumeClicks();

    const sent = await steerTo(prompt);
    inFlightRef.current = false;
    if (sent) diagRef.current.ok += 1;
    else diagRef.current.failed += 1;

    // Warm after sending so the request never competes with the steer itself.
    warmDirector(signature, context);

    if (!sent) return;
    lastSigRef.current = signature;
    setTelemetry((current) => ({
      ...current,
      lastSent: prompt,
      lastSource: directed ? "director" : "composed",
      sentCount: current.sentCount + 1,
      queued: true,
      pose: describePose(poseRef.current),
      eventCount: firesRef.current.length,
      fires: firePoints(),
    }));
    // The douse is a one-shot beat; clear it once it has been described.
    dousedRef.current = undefined;
  }, [
    active,
    consumeClicks,
    contextNow,
    firePoints,
    lexicon,
    readState,
    steerTo,
    warmDirector,
  ]);

  /* ---------------------------------------------------------------- */
  /* Input poll: integrate the camera, then steer if anything changed  */
  /* ---------------------------------------------------------------- */

  /**
   * The poll reads its work through a ref rather than closing over it.
   *
   * `useGameInput` re-renders this component on every animation frame while
   * the pointer moves. If the interval's effect depended on callbacks that
   * change identity, it would be cleared and recreated every ~16ms and never
   * survive long enough to reach its own 80ms deadline — the controls would go
   * completely dead while the mouse was moving, which is the worst possible
   * time for that to happen.
   */
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const now = performance.now();
    const delta = Math.min(0.5, (now - lastTickAtRef.current) / 1000);
    lastTickAtRef.current = now;
    diagRef.current.ticks += 1;

    const input = readState();
    if (input.actions.size) {
      poseRef.current = integrate(poseRef.current, input.actions, delta);
    }
    if (now - lastSendAtRef.current >= MIN_SEND_INTERVAL_MS) {
      void steerNow();
    }
  };

  useEffect(() => {
    if (!active) return;
    lastTickAtRef.current = performance.now();
    const timer = setInterval(() => tickRef.current(), INPUT_POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  // Telemetry refresh, deliberately slower than the poll.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const now = performance.now();
      setTelemetry((current) => ({
        ...current,
        chunkProgress: Math.min(1, (now - lastBoundaryRef.current) / CHUNK_PERIOD_MS),
        pose: describePose(poseRef.current),
        diag: { ...diagRef.current },
      }));
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  /* ---------------------------------------------------------------- */
  /* Chunk boundaries: the real clock                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active || chunkTick === 0) return;

    lastBoundaryRef.current = performance.now();
    chunkRef.current += 1;
    diagRef.current.chunks += 1;
    // Whatever was queued has now been applied.
    setTelemetry((current) => ({
      ...current,
      chunkProgress: 0,
      queued: false,
      eventCount: firesRef.current.length,
      fires: firePoints(),
    }));

    // Re-evaluate immediately: the pose has moved on even if the keys have not.
    void steerNow();
    // `steerNow` is intentionally excluded — this must fire once per chunk, not
    // again whenever a dependency of the callback changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chunkTick]);

  // Safety net for a stalled event stream, also read through a ref.
  const stallRef = useRef<() => void>(() => {});
  stallRef.current = () => {
    if (performance.now() - lastBoundaryRef.current < FALLBACK_TICK_MS) return;
    lastBoundaryRef.current = performance.now();
    chunkRef.current += 1;
    void steerNow();
  };

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => stallRef.current(), FALLBACK_TICK_MS / 2);
    return () => clearInterval(timer);
  }, [active]);

  // A fresh run starts from the opening vantage with no memory.
  useEffect(() => {
    if (active) return;
    lastSigRef.current = "";
    lastSendAtRef.current = 0;
    poseRef.current = initialPose();
    firesRef.current = [];
    dousedRef.current = undefined;
    chunkRef.current = 0;
    cacheRef.current.clear();
    pendingRef.current.clear();
    failedRef.current.clear();
    diagRef.current = { ticks: 0, attempts: 0, ok: 0, failed: 0, chunks: 0 };
    setTelemetry({
      lastSent: "",
      lastSource: "none",
      sentCount: 0,
      cachedCount: 0,
      chunkProgress: 0,
      queued: false,
      pose: "",
      eventCount: 0,
      fires: [],
      diag: { ticks: 0, attempts: 0, ok: 0, failed: 0, chunks: 0 },
    });
  }, [active]);

  return telemetry;
}
