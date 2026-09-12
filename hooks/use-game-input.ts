"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  actionForKey,
  emptyInputState,
  swallowsKey,
  type GameAction,
  type GameClick,
  type GameInputState,
  type PointerPoint,
} from "@/lib/game-input";

/** How long a click marker stays on screen after it lands. */
const RIPPLE_LIFETIME_MS = 900;

export type GameInputSnapshot = {
  actions: GameAction[];
  pointer: PointerPoint | null;
  /** Click markers still inside their animation window. */
  ripples: GameClick[];
  /** Clicks captured but not yet folded into a sent directive. */
  pendingClicks: GameClick[];
};

/**
 * Captures keyboard and pointer input over the game surface.
 *
 * Input lands in a ref so a pointermove at screen rate never re-renders React;
 * the HUD reads a snapshot refreshed once per animation frame instead. The send
 * loop reads `readState()` directly and calls `consumeClicks()` once a
 * directive built from those clicks has actually gone out.
 */
export function useGameInput(enabled: boolean) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GameInputState>(emptyInputState());
  /** Display-only, and deliberately not cleared when a directive is sent —
   *  a ripple should finish its animation whether or not a chunk landed. */
  const ripplesRef = useRef<GameClick[]>([]);
  const frame = useRef<number | null>(null);

  const [snapshot, setSnapshot] = useState<GameInputSnapshot>({
    actions: [],
    pointer: null,
    ripples: [],
    pendingClicks: [],
  });

  // Coalesce every input burst into at most one render per frame.
  const scheduleSync = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const now = performance.now();
      ripplesRef.current = ripplesRef.current.filter(
        (click) => now - click.id < RIPPLE_LIFETIME_MS,
      );
      setSnapshot({
        actions: [...stateRef.current.actions],
        pointer: stateRef.current.pointer,
        ripples: ripplesRef.current,
        pendingClicks: [...stateRef.current.clicks],
      });
    });
  }, []);

  const readState = useCallback((): GameInputState => {
    // A defensive copy: the loop encodes from this while events keep arriving.
    return {
      actions: new Set(stateRef.current.actions),
      pointer: stateRef.current.pointer,
      clicks: [...stateRef.current.clicks],
    };
  }, []);

  const consumeClicks = useCallback(() => {
    stateRef.current.clicks = [];
    scheduleSync();
  }, [scheduleSync]);

  const clearHeldKeys = useCallback(() => {
    stateRef.current.actions.clear();
    scheduleSync();
  }, [scheduleSync]);

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!enabled) {
      clearHeldKeys();
      return;
    }

    const isTypingTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        element.isContentEditable
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isTypingTarget(event.target)) return;
      const action = actionForKey(event.key);
      if (!action) return;
      if (swallowsKey(event.key)) event.preventDefault();
      stateRef.current.actions.add(action);
      scheduleSync();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const action = actionForKey(event.key);
      if (!action) return;
      stateRef.current.actions.delete(action);
      scheduleSync();
    };

    // Alt-tabbing away with a key down would otherwise leave it stuck on.
    const onBlur = () => clearHeldKeys();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
      clearHeldKeys();
    };
  }, [clearHeldKeys, enabled, scheduleSync]);

  /* ---------------------------------------------------------------- */
  /* Pointer                                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !enabled) return;

    const toPoint = (event: PointerEvent | MouseEvent): PointerPoint => {
      const bounds = surface.getBoundingClientRect();
      return {
        x: clamp01((event.clientX - bounds.left) / bounds.width),
        y: clamp01((event.clientY - bounds.top) / bounds.height),
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      stateRef.current.pointer = toPoint(event);
      scheduleSync();
    };

    const onPointerLeave = () => {
      stateRef.current.pointer = null;
      scheduleSync();
    };

    const onPointerDown = (event: PointerEvent) => {
      // Keep focus on the surface so WASD keeps reaching the window listener.
      surface.focus({ preventScroll: true });
      const point = toPoint(event);
      const click: GameClick = {
        ...point,
        kind: event.button === 2 ? "alternate" : "primary",
        id: performance.now(),
      };
      stateRef.current.pointer = point;
      stateRef.current.clicks.push(click);
      ripplesRef.current = [...ripplesRef.current, click];
      scheduleSync();
    };

    // Right-click is the alternate action, so suppress the browser menu.
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerleave", onPointerLeave);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("contextmenu", onContextMenu);

    return () => {
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerleave", onPointerLeave);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("contextmenu", onContextMenu);
    };
  }, [enabled, scheduleSync]);

  // Ripples fade on a timer, so keep syncing briefly after the last click.
  useEffect(() => {
    if (!snapshot.ripples.length) return;
    const timer = setTimeout(scheduleSync, RIPPLE_LIFETIME_MS / 2);
    return () => clearTimeout(timer);
  }, [scheduleSync, snapshot.ripples]);

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return { surfaceRef, snapshot, readState, consumeClicks };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
