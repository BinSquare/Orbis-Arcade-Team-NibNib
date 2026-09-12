"use client";

import { ReactorProvider } from "@reactor-team/js-sdk";
import { useCallback, useRef } from "react";

import { OrbisPlayer } from "@/components/orbis-player";
import { StatusPanel } from "@/components/status-panel";
import { useOrbisSession } from "@/hooks/use-orbis-session";
import { ORBIS_MODEL_NAME, ORBIS_TRACKS, requestReactorJwt } from "@/lib/orbis";

export function OrbisDemo() {
  // A session-scoped token owns only the sessions IT created. The SDK calls
  // this resolver more than once per connect (create session, then GET it), so
  // every call MUST return the same token or the second request 403s against
  // the session the first one created. The starter's memoisation was
  // load-bearing, not a bug.
  //
  // It is reset only by an intentional kill, never on an unplanned drop: after
  // a network blip the reconnect has to present the token that owns the live
  // session. Tokens last 6h, so holding one for the page lifetime is fine.
  const jwtPromise = useRef<Promise<string> | null>(null);
  const getJwt = useCallback(() => {
    jwtPromise.current ??= requestReactorJwt();
    return jwtPromise.current;
  }, []);
  const resetJwt = useCallback(() => {
    jwtPromise.current = null;
  }, []);

  return (
    <section className="demo-shell">
      <ReactorProvider
        apiUrl="https://api.reactor.inc"
        modelName={ORBIS_MODEL_NAME}
        modelTracks={[...ORBIS_TRACKS]}
        connectOptions={{ autoConnect: false }}
        jwtToken={getJwt}
      >
        <SessionShell resetJwt={resetJwt} />
      </ReactorProvider>
    </section>
  );
}

function SessionShell({ resetJwt }: { resetJwt: () => void }) {
  const session = useOrbisSession(resetJwt);

  return (
    <div className="session-grid">
      <OrbisPlayer
        mounted={session.viewMounted}
        connected={session.connected}
        muted={session.muted}
        status={session.status}
        phase={session.phase}
      />
      <StatusPanel session={session} />
    </div>
  );
}
