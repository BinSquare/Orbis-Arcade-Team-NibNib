"use client";

import { ReactorView } from "@reactor-team/js-sdk";
import type { ReactNode, RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import type { GameInputSnapshot } from "@/hooks/use-game-input";
import { describeZone } from "@/lib/game-input";

type GameViewportProps = {
  surfaceRef: RefObject<HTMLDivElement | null>;
  snapshot: GameInputSnapshot;
  live: boolean;
  muted: boolean;
  paused: boolean;
  status: string;
  /** Shown over the surface before a world is running. */
  overlay?: ReactNode;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  ready: "default",
  connecting: "secondary",
  waiting: "secondary",
  disconnected: "outline",
};

export function GameViewport({
  surfaceRef,
  snapshot,
  live,
  muted,
  paused,
  status,
  overlay,
}: GameViewportProps) {
  const { pointer, ripples } = snapshot;

  return (
    <div className="border-4 border-border bg-card shadow-xl">
      <div
        className={`surface${live ? " surface-live" : ""}`}
        ref={surfaceRef}
        tabIndex={0}
        aria-label="Game surface. Move the mouse to aim, click to act, WASD to move."
      >
        {live ? (
          <ReactorView
            track="main_video"
            audioTrack="main_audio"
            muted={muted}
            videoObjectFit="cover"
          />
        ) : null}

        {live && <div className="zone-grid" aria-hidden />}

        {live && pointer && (
          <div
            className="crosshair"
            style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%` }}
            aria-hidden
          >
            <span className="crosshair-ring" />
            <span className="crosshair-dot" />
            <span className="crosshair-label">{describeZone(pointer)}</span>
          </div>
        )}

        {live &&
          ripples.map((click) => (
            <span
              key={click.id}
              className={`ripple ripple-${click.kind}`}
              style={{ left: `${click.x * 100}%`, top: `${click.y * 100}%` }}
              aria-hidden
            />
          ))}

        {live && paused && (
          <div className="absolute inset-0 z-5 flex flex-col items-center justify-center gap-2 bg-background/85 backdrop-blur-sm">
            <span className="font-pixel text-4xl tracking-[0.3em] text-primary">
              PAUSED
            </span>
            <span className="font-pixel text-xs text-muted-foreground">
              PRESS P TO RESUME
            </span>
          </div>
        )}

        <span className="corner corner-tl" aria-hidden />
        <span className="corner corner-tr" aria-hidden />
        <span className="corner corner-bl" aria-hidden />
        <span className="corner corner-br" aria-hidden />

        {overlay && (
          <div className="absolute inset-0 z-6 grid place-items-center overflow-auto bg-background/92 p-5 backdrop-blur-sm">
            {overlay}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t-4 border-border bg-muted px-4 py-2">
        <Badge variant={STATUS_VARIANT[status] ?? "outline"}>
          <span className="font-pixel text-[0.65rem] tracking-widest uppercase">
            {status}
          </span>
        </Badge>
        <span className="font-pixel text-[0.65rem] text-muted-foreground">
          {live
            ? "MOVE TO AIM · LEFT CLICK ACTS · RIGHT CLICK CALMS"
            : "LOAD A WORLD TO BEGIN"}
        </span>
      </div>
    </div>
  );
}
