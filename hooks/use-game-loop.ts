"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ageEvents,
  describePose,
  initialPose,
  integrate,
  recordEvent,
  type CameraPose,
  type WorldEvent,
} from "@/lib/game-camera";
import {
  composeFromLexicon,
  describeSituation,
  requestDirection,
  signatureOf,
  type ActionLexicon,
  type DirectorContext,
} from "@/lib/game-director";
import type { GameInputState } from "@/lib/game-input";

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
  /** Interactions still remembered. */
  eventCount: number;
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
  const lastBoundaryRef = useRef(performance.now());
  const inFlightRef = useRef(false);

  /** Accumulated camera pose — the thing that makes WASD mean travel. */
  const poseRef = useRef<CameraPose>(initialPose());
  /** What the player has disturbed, so effects persist past one chunk. */
  const eventsRef = useRef<WorldEvent[]>([]);
  const chunkRef = useRef(0);

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
  });

  const contextNow = useCallback(
    (input: GameInputState): DirectorContext => ({
      input,
      pose: poseRef.current,
      events: eventsRef.current,
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

    // Fold a click into world memory before building the prompt, so it reads as
    // happening now rather than one chunk late.
    if (hasClick) {
      eventsRef.current = recordEvent(eventsRef.current, input, chunkRef.current);
    }

    const context = contextNow(input);
    const signature = signatureOf(context);

    // A click is one-shot and must always go out; held keys dedupe.
    if (signature === lastSigRef.current && !hasClick) {
      warmDirector(signature, context);
      return;
    }

    const directed = cacheRef.current.get(signature);
    const prompt = directed ?? composeFromLexicon(lexicon, context);

    inFlightRef.current = true;
    lastSendAtRef.current = now;
    // Clear first: a click arriving mid-send belongs to the next send, not this
    // one, and must not be silently dropped.
    consumeClicks();

    const sent = await steerTo(prompt);
    inFlightRef.current = false;

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
      eventCount: eventsRef.current.length,
    }));
  }, [
    active,
    consumeClicks,
    contextNow,
    lexicon,
    readState,
    steerTo,
    warmDirector,
  ]);

  /* ---------------------------------------------------------------- */
  /* Input poll: integrate the camera, then steer if anything changed  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const delta = (now - last) / 1000;
      last = now;

      const input = readState();
      if (input.actions.size) {
        poseRef.current = integrate(poseRef.current, input.actions, delta);
      }

      // Cheap guard: only pay for signature building when something could send.
      if (now - lastSendAtRef.current >= MIN_SEND_INTERVAL_MS) {
        void steerNow();
      }

      setTelemetry((current) => {
        const progress = Math.min(
          1,
          (now - lastBoundaryRef.current) / CHUNK_PERIOD_MS,
        );
        return current.chunkProgress === progress
          ? current
          : { ...current, chunkProgress: progress };
      });
    }, INPUT_POLL_MS);
    return () => clearInterval(timer);
  }, [active, readState, steerNow]);

  /* ---------------------------------------------------------------- */
  /* Chunk boundaries: the real clock                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active || chunkTick === 0) return;

    lastBoundaryRef.current = performance.now();
    chunkRef.current += 1;
    eventsRef.current = ageEvents(eventsRef.current, chunkRef.current);
    // Whatever was queued has now been applied.
    setTelemetry((current) => ({
      ...current,
      chunkProgress: 0,
      queued: false,
      eventCount: eventsRef.current.length,
    }));

    // Re-evaluate immediately: the pose has moved on even if the keys have not.
    void steerNow();
    // `steerNow` is intentionally excluded — this must fire once per chunk, not
    // again whenever a dependency of the callback changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chunkTick]);

  // Safety net for a stalled event stream.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (performance.now() - lastBoundaryRef.current < FALLBACK_TICK_MS) return;
      lastBoundaryRef.current = performance.now();
      chunkRef.current += 1;
      void steerNow();
    }, FALLBACK_TICK_MS / 2);
    return () => clearInterval(timer);
  }, [active, steerNow]);

  // A fresh run starts from the opening vantage with no memory.
  useEffect(() => {
    if (active) return;
    lastSigRef.current = "";
    lastSendAtRef.current = 0;
    poseRef.current = initialPose();
    eventsRef.current = [];
    chunkRef.current = 0;
    cacheRef.current.clear();
    pendingRef.current.clear();
    failedRef.current.clear();
    setTelemetry({
      lastSent: "",
      lastSource: "none",
      sentCount: 0,
      cachedCount: 0,
      chunkProgress: 0,
      queued: false,
      pose: "",
      eventCount: 0,
    });
  }, [active]);

  return telemetry;
}
