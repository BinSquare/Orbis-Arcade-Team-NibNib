"use client";

import { useReactor, useReactorMessage } from "@reactor-team/js-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CREDITS_PER_SECOND,
  type OrbisMessage,
  chunkIndexOf,
  stamp,
  unwrapOrbisMessage,
} from "@/lib/orbis";
import { AUDIO_PROMPT, OPENING_PROMPT } from "@/lib/scene";

export type PromptLogEntry = {
  at: number;
  clock: string;
  prompt: string;
  /** session_chunk at the moment of send, so we can measure landing latency. */
  sentAtChunk: number | null;
  /** session_chunk when the model acknowledged, filled in on prompt_accepted. */
  acceptedAtChunk: number | null;
  source: string;
};

export type ErrorLogEntry = {
  at: number;
  clock: string;
  /** Verbatim. Never summarised, never prettified. */
  text: string;
};

const PROMPT_LOG_KEY = "orbis.promptLog.v1";

/** Survives a mid-sentence reload — the prompt log is a demo artifact. */
function loadPromptLog(): PromptLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROMPT_LOG_KEY);
    return raw ? (JSON.parse(raw) as PromptLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function useOrbisSession(resetJwt: () => void) {
  const { status, connect, disconnect, reconnect, sendCommand } = useReactor(
    (state) => ({
      status: state.status,
      connect: state.connect,
      disconnect: state.disconnect,
      reconnect: state.reconnect,
      sendCommand: state.sendCommand,
    }),
  );

  // ---- session state -------------------------------------------------------
  const [sessionChunk, setSessionChunk] = useState<number | null>(null);
  const [framesEmitted, setFramesEmitted] = useState<number | null>(null);
  const [firstFrameAt, setFirstFrameAt] = useState<number | null>(null);
  const [activePrompt, setActivePrompt] = useState("");
  const [availableResolutions, setAvailableResolutions] = useState<string[]>([]);
  const [runStarted, setRunStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [viewMounted, setViewMounted] = useState(false);

  // ---- logs ----------------------------------------------------------------
  const [promptLog, setPromptLog] = useState<PromptLogEntry[]>([]);
  const [errorLog, setErrorLog] = useState<ErrorLogEntry[]>([]);
  const [events, setEvents] = useState<string[]>([]);

  // ---- billing meter -------------------------------------------------------
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [generatingAt, setGeneratingAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // ---- reconnect bookkeeping ----------------------------------------------
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [openSessions, setOpenSessions] = useState<number | null>(null);
  const intentionalDisconnect = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousStatus = useRef(status);

  const everReady = useRef(false);
  const chunkRef = useRef<number | null>(null);
  const conditionsReadyResolver = useRef<(() => void) | null>(null);

  const connected = status === "ready";

  useEffect(() => setPromptLog(loadPromptLog()), []);

  /** Truth from the server about what is alive and billing. */
  const refreshOpenSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      const body = (await response.json()) as {
        open?: unknown[];
        error?: string;
      };
      if (!body.error) setOpenSessions(body.open?.length ?? 0);
    } catch {
      /* the panel degrades to "?" rather than breaking the demo */
    }
  }, []);

  /** Independent of any session: what is alive on the account right now. */
  useEffect(() => {
    void refreshOpenSessions();
    const id = setInterval(() => void refreshOpenSessions(), 15_000);
    return () => clearInterval(id);
  }, [refreshOpenSessions]);

  /** 1Hz tick drives the credit meter and the elapsed clocks. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pushError = useCallback((text: string) => {
    setErrorLog((current) =>
      [{ at: Date.now(), clock: stamp(), text }, ...current].slice(0, 50),
    );
  }, []);

  const pushEvent = useCallback((type: string) => {
    setEvents((current) => [`${stamp()}  ${type}`, ...current].slice(0, 40));
  }, []);

  // ---- message handling ----------------------------------------------------
  useReactorMessage((raw: unknown) => {
    const message = unwrapOrbisMessage(raw);
    if (!message?.type) return;

    // Debug tap: every raw model message, newest first, on window.__orbisRaw.
    // The model's message schema is pass-through JSON that appears in neither
    // the SDK types nor the WASM, so this is the only way to see real field
    // names. Cheap, and it has already earned its place once.
    if (typeof window !== "undefined") {
      const w = window as unknown as { __orbisRaw?: unknown[] };
      w.__orbisRaw ??= [];
      w.__orbisRaw.unshift({ at: stamp(), raw, unwrapped: message });
      if (w.__orbisRaw.length > 60) w.__orbisRaw.length = 60;
    }

    if (message.type === "chunk_complete") {
      const index = chunkIndexOf(message);
      if (index !== null) {
        chunkRef.current = index;
        setSessionChunk(index);
      }
      if (typeof message.frames_emitted === "number") {
        setFramesEmitted(message.frames_emitted);
        // First chunk emits 0 frames while the upscaler primes. The first chunk
        // that emits any frame is the real "picture is on screen" moment.
        if (message.frames_emitted > 0) {
          setFirstFrameAt((current) => current ?? Date.now());
        }
      }
      // chunk_complete is high-frequency; keep it out of the event feed.
      return;
    }

    if (message.type === "state") {
      // state mirrors the chunk counter, so the panel stays live even if a
      // chunk_complete is missed.
      const stateChunk = chunkIndexOf(message);
      if (stateChunk !== null) {
        chunkRef.current = stateChunk;
        setSessionChunk(stateChunk);
      }
      if (typeof message.started === "boolean") setRunStarted(message.started);
      if (typeof message.paused === "boolean") setPaused(message.paused);
      if (message.available_resolutions?.length) {
        setAvailableResolutions(message.available_resolutions.map(String));
      }
      return;
    }

    pushEvent(message.type);

    if (message.type === "conditions_ready") {
      conditionsReadyResolver.current?.();
      conditionsReadyResolver.current = null;
    }

    if (message.type === "prompt_accepted") {
      if (typeof message.prompt === "string") setActivePrompt(message.prompt);
      setPromptLog((current) => {
        const next = [...current];
        const pending = next.findIndex((entry) => entry.acceptedAtChunk === null);
        if (pending !== -1) {
          next[pending] = { ...next[pending], acceptedAtChunk: chunkRef.current };
        }
        try {
          window.localStorage.setItem(PROMPT_LOG_KEY, JSON.stringify(next));
        } catch {
          /* quota or private mode — the log is a nicety, not the demo */
        }
        return next;
      });
    }

    if (message.type === "generation_started") {
      setRunStarted(true);
      setPaused(false);
      setGeneratingAt((current) => current ?? Date.now());
      setPhase("generating");
    }
    if (message.type === "generation_paused") setPaused(true);
    if (message.type === "generation_resumed") setPaused(false);
    if (
      message.type === "generation_complete" ||
      message.type === "generation_reset"
    ) {
      setRunStarted(false);
      setPaused(false);
      setPhase("stopped");
    }

    if (message.type === "command_error") {
      // Verbatim, including the whole payload when reason is missing.
      const detail =
        message.reason ?? JSON.stringify(message).slice(0, 400) ?? "rejected";
      pushError(`command_error [${message.command ?? "unknown"}]: ${detail}`);
      if (message.command === "start") {
        setRunStarted(false);
        setPhase("start rejected");
      }
    }
  });

  // ---- auto-reconnect ------------------------------------------------------
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;

    if (status === "ready") {
      everReady.current = true;
      setConnectedAt((current) => current ?? Date.now());
      setReconnectAttempt(0);
      setViewMounted(true);
      setPhase((current) =>
        current === "connecting" || current === "reconnecting"
          ? "connected"
          : current,
      );
      return;
    }

    if (status === "disconnected" && was !== "disconnected") {
      setRunStarted(false);
      setPaused(false);
      setViewMounted(false);
      if (intentionalDisconnect.current) {
        setPhase("killed");
        return;
      }
      // Unexpected drop: climb back. Network blips are the whole point.
      pushError(`transport: status -> disconnected (unplanned), reconnecting`);
      setPhase("reconnecting");
      setReconnectAttempt((attempt) => attempt + 1);
    }
  }, [pushError, status]);

  useEffect(() => {
    if (reconnectAttempt === 0) return;
    if (status === "ready" || status === "connecting") return;
    if (intentionalDisconnect.current) return;

    const delay = Math.min(15_000, 1000 * 2 ** (reconnectAttempt - 1));
    reconnectTimer.current = setTimeout(async () => {
      try {
        setPhase(`reconnecting (attempt ${reconnectAttempt})`);
        // reconnect() only works while the SDK still holds the session. Once
        // the server has torn it down it throws "without a session", and the
        // only way back is a fresh connect() — which mints a new session on the
        // same token (max_sessions 3 gives us the headroom for exactly this).
        if (everReady.current) await reconnect();
        else await connect();
      } catch (caught) {
        const detail =
          caught instanceof Error ? caught.message : String(caught);
        pushError(`reconnect attempt ${reconnectAttempt} failed: ${detail}`);
        // The session is gone for good; stop trying to resume it and let the
        // next attempt build a new one instead of looping on the same error.
        if (/without a session/i.test(detail)) {
          everReady.current = false;
          pushEvent("session gone — next attempt will connect fresh");
        }
        setReconnectAttempt((attempt) => attempt + 1);
      }
    }, delay);

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect, pushError, pushEvent, reconnect, reconnectAttempt, status]);

  // ---- command helpers -----------------------------------------------------
  const runAction = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      pushError(
        `${label}: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * No 15-second ceiling. The starter timed out waiting for conditions_ready
   * after 15s, but session startup is measured in minutes, so that throw fired
   * before the model had woken up. Generous ceiling, and it reports progress.
   */
  const waitForConditionsReady = (timeoutMs = 300_000) => {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        conditionsReadyResolver.current = null;
        reject(
          new Error(
            `conditions_ready did not arrive within ${Math.round(
              timeoutMs / 1000,
            )}s`,
          ),
        );
      }, timeoutMs);
      conditionsReadyResolver.current = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return { promise, cancel: () => clearTimeout(timer) };
  };

  /** The single funnel every prompt goes through, so every prompt gets logged. */
  const sendPrompt = useCallback(
    async (prompt: string, source: string) => {
      const entry: PromptLogEntry = {
        at: Date.now(),
        clock: stamp(),
        prompt,
        sentAtChunk: chunkRef.current,
        acceptedAtChunk: null,
        source,
      };
      setPromptLog((current) => {
        const next = [entry, ...current].slice(0, 200);
        try {
          window.localStorage.setItem(PROMPT_LOG_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      setActivePrompt(prompt);
      const reply = await sendCommand("set_prompt", { prompt });
      const unwrapped = reply ? unwrapOrbisMessage(reply) : null;
      if (unwrapped?.type === "command_error") {
        pushError(`set_prompt: ${unwrapped.reason ?? "rejected"}`);
      }
      return unwrapped;
    },
    [pushError, sendCommand],
  );

  // ---- lifecycle -----------------------------------------------------------
  const warm = () =>
    runAction("connect", async () => {
      intentionalDisconnect.current = false;
      setPhase("connecting");
      setFirstFrameAt(null);
      setSessionChunk(null);
      setFramesEmitted(null);
      chunkRef.current = null;
      await connect();
    });

  /** Arms the model (seed, audio bed, opening prompt) and starts generating. */
  const startRun = () =>
    runAction("start", async () => {
      setPhase("arming");
      // Read once at start; must be set before start to make a run reproducible.
      await sendCommand("set_seed", { seed: 42 });
      await sendCommand("set_audio_prompt", { prompt: AUDIO_PROMPT });

      // Deliberately no set_resolution. The 2k default is what we want, and
      // sending a tier we guessed is the documented way to get it rejected.

      const ready = waitForConditionsReady();
      await sendPrompt(OPENING_PROMPT, "opening");
      setPhase("waiting for conditions_ready");
      await ready.promise;

      setPhase("starting");
      await sendCommand("start", {});
      setRunStarted(true);
      setGeneratingAt((current) => current ?? Date.now());
    });

  /** Prominent, deliberate, and the only path that suppresses auto-reconnect. */
  const killSession = async () => {
    intentionalDisconnect.current = true;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    setReconnectAttempt(0);
    setRunStarted(false);
    setPaused(false);
    setPhase("killing");

    // Unmount ReactorView before the WebRTC tracks it is playing are closed.
    setViewMounted(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    await runAction("disconnect", () => disconnect());

    // Belt and braces: the SDK only deletes the session while it still holds
    // the token that created it. Reap server-side with the API key so a kill is
    // always a real kill, never a session left billing in the dark.
    await runAction("reap", async () => {
      const response = await fetch("/api/sessions", { method: "DELETE" });
      const body = (await response.json()) as {
        deleted?: string[];
        failed?: unknown[];
        error?: string;
      };
      if (body.error) throw new Error(body.error);
      if (body.deleted?.length) {
        pushEvent(`reaped ${body.deleted.length} session(s)`);
      }
      if (body.failed?.length) {
        pushError(`reap could not delete: ${JSON.stringify(body.failed)}`);
      }
    });

    everReady.current = false;
    resetJwt();
    setConnectedAt(null);
    setGeneratingAt(null);
    setPhase("killed");
    void refreshOpenSessions();
  };


  // ---- derived -------------------------------------------------------------
  const connectedSeconds = connectedAt ? (now - connectedAt) / 1000 : 0;
  const generatingSeconds = generatingAt ? (now - generatingAt) / 1000 : 0;
  const creditsBurned = Math.round(connectedSeconds * CREDITS_PER_SECOND);

  return {
    // connection
    status,
    connected,
    phase,
    reconnectAttempt,
    viewMounted,
    openSessions,
    // model state
    sessionChunk,
    framesEmitted,
    firstFrameAt,
    activePrompt,
    availableResolutions,
    runStarted,
    paused,
    muted,
    busy,
    // logs
    promptLog,
    errorLog,
    events,
    // meter
    connectedAt,
    connectedSeconds,
    generatingSeconds,
    creditsBurned,
    // actions
    warm,
    startRun,
    killSession,
    refreshOpenSessions,
    reapAll: async () => {
      await fetch("/api/sessions", { method: "DELETE" });
      void refreshOpenSessions();
    },
    sendPrompt,
    toggleMuted: () => setMuted((current) => !current),
    pause: () => runAction("pause", () => sendCommand("pause", {})),
    resume: () => runAction("resume", () => sendCommand("resume", {})),
    reset: () => runAction("reset", () => sendCommand("reset", {})),
    clearPromptLog: () => {
      setPromptLog([]);
      try {
        window.localStorage.removeItem(PROMPT_LOG_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

export type OrbisSession = ReturnType<typeof useOrbisSession>;
