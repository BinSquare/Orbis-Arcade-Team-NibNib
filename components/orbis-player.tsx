"use client";

import { ReactorView } from "@reactor-team/js-sdk";

type OrbisPlayerProps = {
  /**
   * Mount the view for the whole life of the connection, not just while
   * `runStarted` is true. The starter gated ReactorView on runStarted, which
   * meant a generation_complete or a rejected start tore the video element out
   * of the DOM mid-demo. The session hook lowers this flag only right before it
   * closes the tracks the view is playing.
   */
  mounted: boolean;
  connected: boolean;
  muted: boolean;
  status: string;
  phase: string;
};

export function OrbisPlayer({
  mounted,
  connected,
  muted,
  status,
  phase,
}: OrbisPlayerProps) {
  return (
    <div className="player">
      {mounted ? (
        <ReactorView
          track="main_video"
          audioTrack="main_audio"
          muted={muted}
          videoObjectFit="cover"
        />
      ) : (
        <div className="player-placeholder">
          {connected ? "Connected — arm a run" : "No session"}
        </div>
      )}
      <span className={`status status-${status}`}>
        {status} · {phase}
      </span>
    </div>
  );
}
