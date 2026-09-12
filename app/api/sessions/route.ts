import { NextResponse } from "next/server";

const REACTOR_API_URL = "https://api.reactor.inc";

/**
 * Session janitor. The browser SDK deletes its own session on a clean
 * disconnect, but only while it still holds the token that created it — and a
 * connect that fails midway leaves a live, billing session that the client can
 * no longer touch (its own cleanup DELETE 403s). Every one of those is credit
 * burn we cannot see.
 *
 * These handlers use the API key, which can see and delete every session on the
 * account, so KILL always works and orphans are always visible.
 */

function keyHeaders(apiKey: string) {
  return { "Content-Type": "application/json", "Reactor-API-Key": apiKey };
}

async function accountId(apiKey: string) {
  const response = await fetch(`${REACTOR_API_URL}/me`, {
    headers: keyHeaders(apiKey),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`/me failed (${response.status})`);
  const me = (await response.json()) as { account_id?: string };
  if (!me.account_id) throw new Error("/me returned no account_id");
  return me.account_id;
}

type AccountSession = {
  session_id: string;
  model: string;
  state: string;
  closed: boolean;
};

async function openSessions(apiKey: string) {
  const account = await accountId(apiKey);
  const response = await fetch(
    `${REACTOR_API_URL}/accounts/${account}/sessions`,
    { headers: keyHeaders(apiKey), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`session list failed (${response.status})`);
  const body = (await response.json()) as { sessions?: AccountSession[] };
  return (body.sessions ?? []).filter((session) => !session.closed);
}

/** GET — what is actually alive and billing right now. */
export async function GET() {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "REACTOR_API_KEY missing" }, { status: 500 });
  }
  try {
    const open = await openSessions(apiKey);
    return NextResponse.json(
      {
        open: open.map((s) => ({
          session_id: s.session_id,
          state: s.state,
          model: s.model,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : String(caught) },
      { status: 502 },
    );
  }
}

/**
 * DELETE — kill one session by id, or every open session when none is named.
 * The no-id form is the panic button for orphans.
 */
export async function DELETE(request: Request) {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "REACTOR_API_KEY missing" }, { status: 500 });
  }

  const requested = new URL(request.url).searchParams.get("id");
  try {
    const targets = requested
      ? [requested]
      : (await openSessions(apiKey)).map((s) => s.session_id);

    const deleted: string[] = [];
    const failed: { id: string; status: number }[] = [];
    for (const id of targets) {
      const response = await fetch(`${REACTOR_API_URL}/sessions/${id}`, {
        method: "DELETE",
        headers: keyHeaders(apiKey),
        cache: "no-store",
      });
      if (response.ok) deleted.push(id);
      else failed.push({ id, status: response.status });
    }
    return NextResponse.json({ deleted, failed });
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : String(caught) },
      { status: 502 },
    );
  }
}
