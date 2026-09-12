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
 * Orbis emits a chunk roughly every 1.8s and applies steering at the next
 * boundary. If `chunk_complete` ever stalls we still want the controls to feel
 * alive, so a timer of the same order acts as a floor.
 */
const CHUNK_PERIOD_MS = 1_800;
const FALLBACK_TICK_MS = 2_400;

/** Camera integration rate. Fine enough to feel continuous, cheap enough to ignore. */
const POSE_TICK_MS = 100;

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
  /** 0-1 progress toward the next steering opportunity. */
  chunkProgress: number;
  /** True while the situation differs from what was last sent. */
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
  const lastBoundaryRef = useRef(performance.now());
  const inFlightRef = useRef(false);

  /** Accumulated camera pose — the thing that makes WASD mean travel. */
  const poseRef = useRef<CameraPose>(initialPose());
  /** What the player has disturbed, so effects persist past one chunk. */
  const eventsRef = useRef<WorldEvent[]>([]);
  const chunkRef = useRef(0);

  const cacheRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Set<string>());

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
  /* Camera integration                                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const delta = (now - last) / 1000;
      last = now;
      const { actions } = readState();
      if (!actions.size) return;
      poseRef.current = integrate(poseRef.current, actions, delta);
    }, POSE_TICK_MS);
    return () => clearInterval(timer);
  }, [active, readState]);

  /* ---------------------------------------------------------------- */
  /* Director warming                                                  */
  /* ---------------------------------------------------------------- */

  const warmDirector = useCallback(
    (signature: string, context: DirectorContext) => {
      if (!useDirector) return;
      if (cacheRef.current.has(signature)) return;
      if (pendingRef.current.has(signature)) return;
      if (pendingRef.current.size >= MAX_INFLIGHT) return;

      pendingRef.current.add(signature);
      void requestDirection(world, describeSituation(context))
        .then((prompt) => {
          if (!prompt) return;
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

  const onBoundary = useCallback(async () => {
    if (!active || !lexicon || inFlightRef.current) return;

    lastBoundaryRef.current = performance.now();
    chunkRef.current += 1;

    const input = readState();
    const hasClick = input.clicks.length > 0;

    // Fold this chunk's click into world memory before building the prompt, so
    // the interaction is described as happening now rather than next chunk.
    if (hasClick) {
      eventsRef.current = recordEvent(eventsRef.current, input, chunkRef.current);
    }
    eventsRef.current = ageEvents(eventsRef.current, chunkRef.current);

    const context = contextNow(input);
    const signature = signatureOf(context);

    if (signature === lastSigRef.current && !hasClick) {
      setTelemetry((current) => ({ ...current, queued: false }));
      warmDirector(signature, context);
      return;
    }

    const directed = cacheRef.current.get(signature);
    const prompt = directed ?? composeFromLexicon(lexicon, context);

    inFlightRef.current = true;
    // Clear first: a click that arrives mid-send belongs to the next boundary,
    // not this one, and must not be silently dropped.
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
      chunkProgress: 0,
      queued: false,
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

  // Real boundary: driven by the model's own chunk_complete events.
  useEffect(() => {
    if (!active || chunkTick === 0) return;
    void onBoundary();
    // `onBoundary` is intentionally excluded — this must fire once per chunk,
    // not again whenever a dependency of the callback changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chunkTick]);

  // Safety net for a stalled event stream.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (performance.now() - lastBoundaryRef.current < FALLBACK_TICK_MS) return;
      void onBoundary();
    }, FALLBACK_TICK_MS / 2);
    return () => clearInterval(timer);
  }, [active, onBoundary]);

  // Progress toward the next boundary, plus the live pose readout.
  useEffect(() => {
    if (!active) {
      setTelemetry((current) => ({
        ...current,
        chunkProgress: 0,
        queued: false,
      }));
      return;
    }
    const timer = setInterval(() => {
      const elapsed = performance.now() - lastBoundaryRef.current;
      const input = readState();
      setTelemetry((current) => ({
        ...current,
        chunkProgress: Math.min(1, elapsed / CHUNK_PERIOD_MS),
        queued:
          signatureOf(contextNow(input)) !== lastSigRef.current ||
          input.clicks.length > 0,
        pose: describePose(poseRef.current),
      }));
    }, 120);
    return () => clearInterval(timer);
  }, [active, contextNow, readState]);

  // A fresh run starts from the opening vantage with no memory.
  useEffect(() => {
    if (active) return;
    lastSigRef.current = "";
    poseRef.current = initialPose();
    eventsRef.current = [];
    chunkRef.current = 0;
    cacheRef.current.clear();
    pendingRef.current.clear();
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
