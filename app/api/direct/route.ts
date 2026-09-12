import { NextResponse } from "next/server";

import { NO_KEY_ERROR, activeProvider, generateText } from "@/lib/ai";

export const runtime = "nodejs";

const SYSTEM_INSTRUCTION = `You are the live director of a real-time video game
rendered by an image-to-video model. Write the single prompt that renders the
next ~2 seconds of one continuous, unbroken shot.

You are given three things: the world, where the camera has travelled to since
the shot opened, and what the player is doing this instant. All three matter.

Rules:
- One paragraph, 45 to 75 words, present tense, plain text.
- LEAD with the motion happening this instant. It is what changed.
- HONOUR THE CAMERA POSITION. If the camera has moved deep into the scene, do
  not describe the opening view again — describe what is in front of it now.
  If it has turned, describe what that new heading faces. The shot is one
  continuous move through a persistent space, never a cut back to the start.
- HONOUR WHAT HAS ALREADY HAPPENED. Anything the player disturbed stays
  disturbed; anything calmed stays settled. Never silently reset the world.
- Re-state just enough of the world — subjects, materials, light — that the
  scene cannot drift into something else.
- Never invent a new location, new characters, or a cut to elsewhere. Only
  reveal things that plausibly continue the space you were given.
- If the player acted on a screen position, say what is there and how it reacts.
  Keep it physical: it moves, stirs, topples, scatters, flares, settles.
- Never mention the player, the camera operator, controls, keys, or the mouse.
  The camera IS the player's viewpoint.
- End with: Continuous shot, no cuts.
- No Markdown, no headings, no labels, no commentary.`;

export async function POST(request: Request) {
  if (!activeProvider()) {
    return NextResponse.json({ error: NO_KEY_ERROR }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as {
    world?: string;
    situation?: string;
  } | null;

  if (!body?.world?.trim() || !body?.situation?.trim()) {
    return NextResponse.json(
      { error: "world and situation are required" },
      { status: 400 },
    );
  }

  try {
    const prompt = await generateText({
      system: SYSTEM_INSTRUCTION,
      user: `THE WORLD:\n${body.world.trim()}\n\nCAMERA POSITION AND WHAT IS HAPPENING NOW:\n${body.situation.trim()}`,
      temperature: 0.7,
      maxTokens: 512,
    });

    if (!prompt) {
      return NextResponse.json(
        { error: "The model returned no direction" },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { prompt },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (caught) {
    console.error("Direction failed", caught);
    return NextResponse.json(
      { error: "The model could not direct this moment" },
      { status: 502 },
    );
  }
}
