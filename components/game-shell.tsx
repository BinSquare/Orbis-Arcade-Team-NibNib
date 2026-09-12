"use client";

import { ReactorProvider } from "@reactor-team/js-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ActionReadout,
  EventTicker,
  KeycapDeck,
  WorldPanel,
} from "@/components/game-hud";
import { GameViewport } from "@/components/game-viewport";
import { Button } from "@/components/ui/button";
import { WorldLoader } from "@/components/world-loader";
import { useGameInput } from "@/hooks/use-game-input";
import { useGameLoop } from "@/hooks/use-game-loop";
import { useOrbisSession } from "@/hooks/use-orbis-session";
import type { ActionLexicon } from "@/lib/game-director";
import type { WorldCartridge } from "@/lib/game-world";
import { ORBIS_MODEL_NAME, ORBIS_TRACKS, requestReactorJwt } from "@/lib/orbis";

export function GameShell() {
  const jwtPromise = useRef<Promise<string> | null>(null);
  const getJwt = useCallback(() => {
    jwtPromise.current ??= requestReactorJwt();
    return jwtPromise.current;
  }, []);
  const clearJwt = useCallback(() => {
    jwtPromise.current = null;
  }, []);

  return (
    <ReactorProvider
      apiUrl="https://api.reactor.inc"
      modelName={ORBIS_MODEL_NAME}
      modelTracks={[...ORBIS_TRACKS]}
      connectOptions={{ autoConnect: false }}
      jwtToken={getJwt}
    >
      <GameSession clearJwt={clearJwt} />
    </ReactorProvider>
  );
}

function GameSession({ clearJwt }: { clearJwt: () => void }) {
  const session = useOrbisSession(clearJwt);
  const [world, setWorld] = useState("");
  const [grounded, setGrounded] = useState(false);
  const [lexicon, setLexicon] = useState<ActionLexicon | null>(null);
  const [lexiconGrounded, setLexiconGrounded] = useState(false);

  const playing = session.runStarted && !session.paused;
  const { surfaceRef, snapshot, readState, consumeClicks } =
    useGameInput(playing);

  const telemetry = useGameLoop({
    active: playing,
    world,
    lexicon,
    // Without a grounded lexicon Gemini is unreachable, so asking the director
    // for per-combination prompts would just burn failed requests.
    useDirector: lexiconGrounded,
    chunkTick: session.chunkTick,
    readState,
    consumeClicks,
    steerTo: session.steerTo,
  });

  // `session` is a fresh object every render, so hotkeys read it through a ref
  // instead of re-binding the window listener on each one.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const launch = (cartridge: WorldCartridge) => {
    setWorld(cartridge.world);
    setGrounded(cartridge.worldGrounded);
    setLexicon(cartridge.lexicon);
    setLexiconGrounded(cartridge.lexiconGrounded);
    void session.startGame(cartridge.image, cartridge.world);
  };

  const exitWorld = useCallback(() => {
    setWorld("");
    setGrounded(false);
    setLexicon(null);
    setLexiconGrounded(false);
    void sessionRef.current.reset();
  }, []);

  // Global game hotkeys, kept out of the movement map on purpose.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const current = sessionRef.current;
      const key = event.key.toLowerCase();
      if (key === "p" && current.runStarted) {
        event.preventDefault();
        void (current.paused ? current.resume() : current.pause());
      } else if (key === "m") {
        event.preventDefault();
        current.toggleMuted();
      } else if (key === "escape" && current.runStarted) {
        event.preventDefault();
        exitWorld();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitWorld]);

  // Once the world is live, hand keyboard focus to the surface.
  useEffect(() => {
    if (session.runStarted) surfaceRef.current?.focus({ preventScroll: true });
  }, [session.runStarted, surfaceRef]);

  return (
    <div className="mx-auto w-[min(1560px,calc(100%-2rem))] py-6">
      {/* Cabinet header — neobrutalist chrome. */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-4 border-border bg-card px-4 py-3 shadow-lg">
        <div className="flex items-center gap-3">
          <span
            className="size-9 border-2 border-border bg-primary shadow-sm"
            aria-hidden
          />
          <div className="flex flex-col leading-tight">
            <strong className="font-[family-name:var(--font-head)] text-lg tracking-tight">
              ORBIS ARCADE
            </strong>
            <span className="font-pixel text-[0.65rem] text-muted-foreground">
              IMAGE → PLAYABLE WORLD
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={session.toggleMuted}>
            {session.muted ? "SOUND OFF" : "SOUND ON"}
          </Button>
          {session.runStarted && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={session.busy}
                onClick={() =>
                  void (session.paused ? session.resume() : session.pause())
                }
              >
                {session.paused ? "RESUME" : "PAUSE"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={session.busy}
                onClick={exitWorld}
              >
                EXIT WORLD
              </Button>
            </>
          )}
          {session.connected && (
            <Button
              variant="destructive"
              size="sm"
              disabled={session.busy}
              onClick={session.disconnectSession}
            >
              DISCONNECT
            </Button>
          )}
        </div>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <GameViewport
            surfaceRef={surfaceRef}
            snapshot={snapshot}
            live={session.runStarted}
            muted={session.muted}
            paused={session.paused}
            status={session.status}
            overlay={
              session.runStarted ? null : (
                <WorldLoader
                  connected={session.connected}
                  busy={session.busy}
                  connectNotice={session.connectNotice}
                  resolution={session.resolution}
                  availableResolutions={session.availableResolutions}
                  onResolution={session.setResolution}
                  onConnect={session.connectSession}
                  onLaunch={launch}
                />
              )
            }
          />

          {/* Control deck — the physical half of the cabinet. */}
          <div className="grid items-center gap-6 border-4 border-border bg-card px-5 py-4 shadow-lg md:grid-cols-[auto_minmax(0,1fr)_auto]">
            <KeycapDeck snapshot={snapshot} />
            <ActionReadout snapshot={snapshot} telemetry={telemetry} />
            <dl className="m-0 flex gap-3">
              {[
                ["P", "pause"],
                ["M", "sound"],
                ["ESC", "exit"],
              ].map(([key, label]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <dt className="font-pixel border-2 border-border bg-muted px-1.5 py-0.5 text-[0.6rem] shadow-xs">
                    {key}
                  </dt>
                  <dd className="font-pixel m-0 text-[0.6rem] text-muted-foreground">
                    {label}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <WorldPanel
            world={world}
            grounded={grounded}
            lexicon={lexicon}
            lexiconGrounded={lexiconGrounded}
            telemetry={telemetry}
          />
          <EventTicker events={session.events} />
          {session.imageStatus && (
            <p className="font-pixel border-4 border-border bg-accent px-3 py-2 text-xs text-accent-foreground shadow-md">
              {session.imageStatus}
            </p>
          )}
          {session.error && (
            <p
              className="font-pixel border-4 border-border bg-destructive px-3 py-2 text-xs leading-relaxed text-destructive-foreground shadow-md"
              role="alert"
            >
              {session.error}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
