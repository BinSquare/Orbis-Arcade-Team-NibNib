"use client";

import { ProgressBar } from "pixel-retroui";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { GameInputSnapshot } from "@/hooks/use-game-input";
import type { GameLoopTelemetry } from "@/hooks/use-game-loop";
import type { ActionLexicon } from "@/lib/game-director";
import { KEYCAP_ROWS, describeInputBriefly } from "@/lib/game-input";

/** Live keyboard state, lit as the player holds keys. */
export function KeycapDeck({ snapshot }: { snapshot: GameInputSnapshot }) {
  const held = new Set(snapshot.actions);

  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      {KEYCAP_ROWS.map((row, index) => (
        <div className="flex gap-1.5" key={index}>
          {row.map((cap) => (
            <kbd
              key={cap.label}
              className={`keycap${held.has(cap.action) ? " keycap-down" : ""}${
                cap.label.length > 1 ? " keycap-wide" : ""
              }`}
            >
              {cap.label}
            </kbd>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The in-game readout. Pixel RetroUI's ProgressBar is the chunk clock — it is
 * the one place the arcade layer and the model's real cadence line up.
 */
export function ActionReadout({
  snapshot,
  telemetry,
}: {
  snapshot: GameInputSnapshot;
  telemetry: GameLoopTelemetry;
}) {
  const brief = describeInputBriefly({
    actions: new Set(snapshot.actions),
    pointer: snapshot.pointer,
    clicks: snapshot.pendingClicks,
  });

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span className="font-pixel w-12 shrink-0 text-[0.6rem] text-muted-foreground">
          INPUT
        </span>
        <strong className="font-pixel truncate text-base text-primary">
          {brief}
        </strong>
      </div>

      {/* The pose is the proof WASD is doing something cumulative. */}
      <div className="flex items-start gap-3">
        <span className="font-pixel w-12 shrink-0 text-[0.6rem] text-muted-foreground">
          CAMERA
        </span>
        <span className="font-pixel line-clamp-2 text-[0.65rem] leading-relaxed text-card-foreground/80">
          {telemetry.pose || "At the opening vantage."}
          {telemetry.eventCount > 0 && (
            <span className="text-accent">
              {" "}
              · {telemetry.eventCount} burning
            </span>
          )}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="font-pixel w-12 shrink-0 text-[0.6rem] text-muted-foreground">
          NEXT
        </span>
        <div className="min-w-0 flex-1">
          <ProgressBar
            size="sm"
            progress={Math.round(telemetry.chunkProgress * 100)}
            color={telemetry.queued ? "#5fe3d0" : "#c381b5"}
            borderColor="#000000"
          />
        </div>
        <span
          className={`font-pixel shrink-0 text-[0.6rem] ${
            telemetry.queued ? "text-accent" : "text-muted-foreground"
          }`}
        >
          {telemetry.queued ? "QUEUED" : "SYNCED"}
        </span>
      </div>
    </div>
  );
}

/** The fixed world anchor, plus the last directive actually sent. */
export function WorldPanel({
  world,
  grounded,
  lexicon,
  lexiconGrounded,
  telemetry,
}: {
  world: string;
  grounded: boolean;
  lexicon: ActionLexicon | null;
  lexiconGrounded: boolean;
  telemetry: GameLoopTelemetry;
}) {
  const source = telemetry.lastSource;
  return (
    <Card className="gap-0 py-4">
      <CardHeader className="gap-0 px-4 pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          WORLD
          <Badge variant={grounded ? "default" : "secondary"}>
            <span className="font-pixel text-[0.6rem]">
              {grounded ? "GEMINI" : "IMAGE ONLY"}
            </span>
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <p className="scroll-body max-h-[9rem] text-sm leading-relaxed text-card-foreground/85">
          {world || "No world loaded."}
        </p>
      </CardContent>

      {lexicon && (
        <>
          <CardHeader className="mt-4 gap-0 border-t-4 border-border px-4 pt-4 pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              CONTROLS
              <Badge variant={lexiconGrounded ? "default" : "secondary"}>
                <span className="font-pixel text-[0.6rem]">
                  {lexiconGrounded ? "GEMINI" : "GENERIC"}
                </span>
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="scroll-body max-h-[7rem] text-xs leading-relaxed text-card-foreground/75">
              <span className="font-pixel text-primary">W </span>
              {lexicon.forward}
              <br />
              <span className="font-pixel text-primary">CLICK </span>
              {lexicon.ignite.replaceAll("{zone}", "target")}
            </p>
          </CardContent>
        </>
      )}

      <CardHeader className="mt-4 gap-0 border-t-4 border-border px-4 pt-4 pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          LAST PROMPT
          <span className="flex gap-1.5">
            <Badge variant={source === "director" ? "default" : "outline"}>
              <span className="font-pixel text-[0.6rem]">
                {source === "director"
                  ? "DIRECTED"
                  : source === "composed"
                    ? "COMPOSED"
                    : "IDLE"}
              </span>
            </Badge>
            <Badge variant="outline">
              <span className="font-pixel text-[0.6rem]">
                {telemetry.sentCount}/{telemetry.cachedCount}
              </span>
            </Badge>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <p className="font-pixel scroll-body max-h-[10rem] text-xs leading-relaxed text-accent">
          {telemetry.lastSent || "Nothing steered yet."}
        </p>
      </CardContent>
    </Card>
  );
}

/** Raw model events, newest first — the source of truth while debugging. */
export function EventTicker({ events }: { events: string[] }) {
  return (
    <Card className="gap-0 py-4">
      <CardHeader className="gap-0 px-4 pb-3">
        <CardTitle className="text-sm">MODEL EVENTS</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <ul className="flex flex-wrap gap-1.5">
          {events.length ? (
            events.map((event, index) => (
              <li key={`${event}-${index}`}>
                <span
                  className={`font-pixel inline-block border-2 border-border px-2 py-1 text-[0.6rem] shadow-xs ${
                    index === 0
                      ? "bg-accent text-accent-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {event}
                </span>
              </li>
            ))
          ) : (
            <li className="font-pixel text-[0.6rem] text-muted-foreground">
              NO EVENTS YET
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
