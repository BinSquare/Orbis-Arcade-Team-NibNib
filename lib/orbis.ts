export const ORBIS_MODEL_NAME = "reactor/visko-orbis-stable";

export const ORBIS_TRACKS = [
  { name: "main_video", kind: "video", direction: "recvonly" },
  { name: "main_audio", kind: "audio", direction: "recvonly" },
] as const;

export const DOCUMENTED_RESOLUTIONS = ["1080p", "2k", "4k"];

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
};

export function unwrapOrbisMessage(raw: unknown): OrbisMessage {
  const envelope = raw as { type?: string; data?: Record<string, unknown> };
  if (envelope?.data && typeof envelope.data === "object") {
    return { ...envelope.data, type: envelope.type } as OrbisMessage;
  }
  return raw as OrbisMessage;
}

/**
 * Reactor answers `POST /sessions` with 429 for two very different reasons:
 * the GPU pool is full ("no available capacity"), or the account already holds
 * its one allowed concurrent session ("quota_exceeded"). Both clear on their
 * own — capacity when a server frees up, quota when the stale session times
 * out — so both are worth retrying rather than failing the player outright.
 */
export function isRetryableConnectError(caught: unknown): boolean {
  const message = (
    caught instanceof Error ? caught.message : String(caught)
  ).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("no available capacity") ||
    message.includes("quota_exceeded") ||
    message.includes("quota exceeded")
  );
}

export async function requestReactorJwt() {
  const response = await fetch("/api/token", { method: "POST" });
  const result = (await response.json()) as { jwt?: string; error?: string };
  if (!response.ok || !result.jwt) {
    throw new Error(result.error || "Could not create a Reactor token");
  }
  return result.jwt;
}
