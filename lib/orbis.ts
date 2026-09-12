export const ORBIS_MODEL_NAME = "reactor/visko-orbis-stable";

export const ORBIS_TRACKS = [
  { name: "main_video", kind: "video", direction: "recvonly" },
  { name: "main_audio", kind: "audio", direction: "recvonly" },
] as const;

/** Billing, for the meter. 97 credits/sec === $0.582/min === $0.0001/credit. */
export const CREDITS_PER_SECOND = 97;
export const CREDIT_BUDGET = 2_600_000;
export const USD_PER_CREDIT = 0.0001;

/** Documented chunk cadence. Events are still the source of truth. */
export const CHUNK_SECONDS = 1.8;

/**
 * Deliberately no DOCUMENTED_RESOLUTIONS constant. The starter seeded its
 * resolution picker with a hard-coded tier list before `state` ever arrived,
 * which is the one thing the API reference tells you not to do. We never send
 * set_resolution at all — the model default (2k) is what we want — so the only
 * place a tier list appears is read-only display of state.available_resolutions.
 */

export type OrbisMessage = {
  type?: string;
  command?: string;
  reason?: string;
  available_resolutions?: string[];
  width?: number;
  height?: number;
  has_image?: boolean;
  image_conditioned?: boolean;
  started?: boolean;
  paused?: boolean;
  /**
   * chunk_complete: monotonic chunk index. The API reference calls this
   * `session_chunk`; the wire actually sends `chunk_index`. Both are declared
   * so the panel keeps working if the docs ever become true.
   */
  chunk_index?: number;
  session_chunk?: number;
  /** chunk_complete: frames in this chunk (33 in practice). */
  frames_emitted?: number;
  /** chunk_complete: 88000 samples @48kHz = 1.833s, the real chunk duration. */
  audio_samples?: number;
  /** state: the same counter, mirrored on every state snapshot. */
  current_chunk?: number;
  running?: boolean;
  has_prompt?: boolean;
  seed?: number;
  resolution?: string;
  audio_prompt?: string;
  audio_enabled?: boolean;
  prompt?: string;
};

/** The chunk counter, whichever name this build of the model uses. */
export function chunkIndexOf(message: OrbisMessage): number | null {
  if (typeof message.chunk_index === "number") return message.chunk_index;
  if (typeof message.session_chunk === "number") return message.session_chunk;
  if (typeof message.current_chunk === "number") return message.current_chunk;
  return null;
}

export function unwrapOrbisMessage(raw: unknown): OrbisMessage {
  const envelope = raw as { type?: string; data?: Record<string, unknown> };
  if (envelope?.data && typeof envelope.data === "object") {
    return { ...envelope.data, type: envelope.type } as OrbisMessage;
  }
  return raw as OrbisMessage;
}

export async function requestReactorJwt() {
  const response = await fetch("/api/token", {
    method: "POST",
    cache: "no-store",
  });
  const result = (await response.json()) as { jwt?: string; error?: string };
  if (!response.ok || !result.jwt) {
    throw new Error(result.error || "Could not create a Reactor token");
  }
  return result.jwt;
}

export function formatClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Wall-clock stamp for the prompt log. Millisecond precision on purpose. */
export function stamp(at = Date.now()) {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
