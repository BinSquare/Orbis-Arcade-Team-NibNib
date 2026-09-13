"use client";

import { useReactor, useReactorMessage } from "@reactor-team/js-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DOCUMENTED_RESOLUTIONS,
  isRetryableConnectError,
  type OrbisMessage,
  unwrapOrbisMessage,
} from "@/lib/orbis";

/** Reactor hands out one concurrent session per model; a stale one frees up on
 *  heartbeat timeout, so a few spaced retries usually beat a hard failure. */
const CONNECT_ATTEMPTS = 4;
const CONNECT_BACKOFF_MS = [2_000, 6_000, 12_000];

export function useOrbisSession(onDisconnected: () => void) {
  const { status, connect, disconnect, sendCommand, uploadFile } = useReactor(
    (state) => ({
      status: state.status,
      connect: state.connect,
      disconnect: state.disconnect,
      sendCommand: state.sendCommand,
      uploadFile: state.uploadFile,
    }),
  );

  const [resolution, setResolution] = useState("");
  const [availableResolutions, setAvailableResolutions] = useState<string[]>(
    DOCUMENTED_RESOLUTIONS,
  );
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runStarted, setRunStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [imageStatus, setImageStatus] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [connectNotice, setConnectNotice] = useState("");

  /** Increments on every `chunk_complete` — the game loop's clock. */
  const [chunkTick, setChunkTick] = useState(0);

  const previousStatus = useRef(status);
  const disconnecting = useRef(false);
  const conditionsReadyResolver = useRef<(() => void) | null>(null);
  const imageReadyResolver = useRef<(() => void) | null>(null);
  const expectsImageForRun = useRef(false);

  const connected = status === "ready";

  useEffect(() => {
    if (
      status === "disconnected" &&
      previousStatus.current !== "disconnected"
    ) {
      onDisconnected();
      setRunStarted(false);
      setPaused(false);
      setImageStatus("");
    }
    previousStatus.current = status;
  }, [onDisconnected, status]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const updateRunState = (message: OrbisMessage) => {
    if (message.type === "state") {
      if (typeof message.started === "boolean") setRunStarted(message.started);
      if (typeof message.paused === "boolean") setPaused(message.paused);
      if (message.has_image === false && !message.started) setImageStatus("");
    } else if (message.type === "generation_started") {
      setRunStarted(true);
      setPaused(false);
      if (message.image_conditioned === true) {
        setImageStatus("World locked to your image");
      } else if (
        message.image_conditioned === false &&
        expectsImageForRun.current
      ) {
        setImageStatus("Started without image conditioning");
        setError("Orbis started without the uploaded image.");
      }
    } else if (message.type === "generation_paused") {
      setPaused(true);
    } else if (message.type === "generation_resumed") {
      setPaused(false);
    } else if (
      message.type === "generation_complete" ||
      message.type === "generation_reset"
    ) {
      setRunStarted(false);
      setPaused(false);
    }
  };

  useReactorMessage((raw: unknown) => {
    const message = unwrapOrbisMessage(raw);

    if (message.type === "conditions_ready") {
      conditionsReadyResolver.current?.();
      conditionsReadyResolver.current = null;
    }

    if (message.type === "state" && message.has_image === true) {
      imageReadyResolver.current?.();
      imageReadyResolver.current = null;
    }

    if (message.type === "state" && message.available_resolutions) {
      const reported = message.available_resolutions.map(String);
      if (reported.length) {
        setAvailableResolutions(reported);
        setResolution((current) =>
          !current || reported.includes(current) ? current : "",
        );
      }
    }

    // The game loop steers on this boundary — steering lands at the next one.
    if (message.type === "chunk_complete") {
      setChunkTick((current) => current + 1);
    }

    if (!disconnecting.current) updateRunState(message);

    if (message.type === "command_error") {
      setError(
        `${message.command || "command"}: ${message.reason || "rejected"}`,
      );
      if (message.command === "start") setRunStarted(false);
    }

    if (message.type) {
      setEvents((current) => [message.type!, ...current].slice(0, 8));
    }
  });

  const waitForSignal = (
    resolver: { current: (() => void) | null },
    signalName: string,
  ) => {
    let timeout: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        resolver.current = null;
        reject(new Error(`Timed out waiting for Orbis ${signalName}.`));
      }, 15_000);
      resolver.current = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(timeout);
        resolver.current = null;
      },
    };
  };

  /* ---------------------------------------------------------------- */
  /* Connect, with backoff for capacity and quota 429s                 */
  /* ---------------------------------------------------------------- */

  const connectSession = () =>
    runAction(async () => {
      setConnectNotice("");
      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
        try {
          await connect();
          setConnectNotice("");
          return;
        } catch (caught) {
          const last = attempt === CONNECT_ATTEMPTS - 1;
          if (last || !isRetryableConnectError(caught)) {
            setConnectNotice("");
            throw caught;
          }
          const wait = CONNECT_BACKOFF_MS[attempt] ?? 12_000;
          setConnectNotice(
            `Reactor is at capacity. Retry ${attempt + 2} of ${CONNECT_ATTEMPTS} in ${Math.round(wait / 1000)}s…`,
          );
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    });

  /* ---------------------------------------------------------------- */
  /* Run lifecycle                                                     */
  /* ---------------------------------------------------------------- */

  /** Uploads the world image, stages resolution, then starts generation. */
  const startGame = async (startImage: File | null, worldPrompt: string) => {
    if (!worldPrompt.trim()) throw new Error("The world needs a description.");
    expectsImageForRun.current = Boolean(startImage);

    if (startImage) {
      const uploaded = await uploadFile(startImage, { name: startImage.name });
      const imageReady = waitForSignal(imageReadyResolver, "state.has_image");
      const rawReply = await sendCommand("set_image", { image: uploaded });
      if (!rawReply) {
        imageReady.cancel();
        throw new Error("Orbis did not accept the world image.");
      }

      const reply = unwrapOrbisMessage(rawReply);
      if (reply.type === "command_error") {
        imageReady.cancel();
        throw new Error(`set_image: ${reply.reason || "rejected"}`);
      }
      if (reply.type !== "image_accepted") {
        imageReady.cancel();
        throw new Error(
          `Expected image_accepted from Orbis, received ${reply.type || "an unknown reply"}.`,
        );
      }

      await imageReady.promise;

      const dimensions =
        reply.width && reply.height ? ` (${reply.width}×${reply.height})` : "";
      setImageStatus(`World locked to your image${dimensions}`);
      setEvents((current) => ["image_accepted", ...current].slice(0, 8));
    }

    if (resolution) await sendCommand("set_resolution", { resolution });

    const conditionsReady = waitForSignal(
      conditionsReadyResolver,
      "conditions_ready",
    );
    const promptReply = await sendCommand("set_prompt", {
      prompt: worldPrompt.trim(),
    });
    if (!promptReply) {
      conditionsReady.cancel();
      throw new Error("Orbis did not accept the world prompt.");
    }

    const promptMessage = unwrapOrbisMessage(promptReply);
    if (promptMessage.type === "command_error") {
      conditionsReady.cancel();
      throw new Error(`set_prompt: ${promptMessage.reason || "rejected"}`);
    }

    await conditionsReady.promise;
    setEvents((current) => ["conditions_ready", ...current].slice(0, 8));
    await sendCommand("start", {});
    setRunStarted(true);
    setPaused(false);
  };

  /**
   * Fire-and-forget steering for the game loop. Deliberately does not go
   * through `runAction`: flipping a global busy flag every chunk would make the
   * whole HUD flicker, and a dropped steer is not worth interrupting play.
   */
  const steerTo = useCallback(
    async (prompt: string) => {
      try {
        const reply = await sendCommand("set_prompt", { prompt });
        const message = unwrapOrbisMessage(reply);
        // A rejected steer looks identical to a working one from the outside,
        // so surface it rather than letting the run look silently inert.
        if (message?.type === "command_error") {
          setError(`set_prompt: ${message.reason || "rejected"}`);
          return false;
        }
        return true;
      } catch (caught) {
        setError(
          `set_prompt failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
        return false;
      }
    },
    [sendCommand],
  );

  const disconnectSession = async () => {
    disconnecting.current = true;
    setRunStarted(false);
    setPaused(false);

    // Remove ReactorView before closing the WebRTC tracks it is playing.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    try {
      await runAction(() => disconnect());
    } finally {
      disconnecting.current = false;
    }
  };

  return {
    status,
    connected,
    busy,
    runStarted,
    paused,
    muted,
    imageStatus,
    resolution,
    availableResolutions,
    error,
    connectNotice,
    events,
    chunkTick,
    connectSession,
    disconnectSession,
    toggleMuted: () => setMuted((current) => !current),
    setResolution,
    setError,
    startGame: (image: File | null, worldPrompt: string) =>
      runAction(() => startGame(image, worldPrompt)),
    steerTo,
    pause: () => runAction(() => sendCommand("pause", {})),
    resume: () => runAction(() => sendCommand("resume", {})),
    reset: () => runAction(() => sendCommand("reset", {})),
  };
}

export type OrbisSession = ReturnType<typeof useOrbisSession>;
