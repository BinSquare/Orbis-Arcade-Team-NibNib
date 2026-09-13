import { NextResponse } from "next/server";

import { NO_KEY_ERROR, activeProvider, generateText } from "@/lib/ai";

export const runtime = "nodejs";

const SYSTEM_INSTRUCTION = `You are the live director of a real-time video game
rendered by an image-to-video model. Write the single prompt that renders the
next ~2 seconds of one continuous, unbroken shot.

You are given three things: the world, where the camera has travelled to since
the shot opened, and what the player is doing this instant. All three matter.

Rules:
- One paragraph, 30 to 50 words, present tense, plain text. Be terse: a long
  prompt buries the motion under scene description and the video stops
  responding to input.
- OPEN with an explicit camera instruction in film grammar — "fast dolly in",
  "pan left", "crane up and truck right". Never open with scenery.
- HONOUR THE CAMERA POSITION. If the camera has moved deep into the scene, do
  not describe the opening view again — describe what is in front of it now.
  If it has turned, describe what that new heading faces. The shot is one
  continuous move through a persistent space, never a cut back to the start.
- HONOUR THE FIRES. Any fire you are told about is still burning and has grown,
  not gone out. Keep its flame, smoke, and the firelight it throws on nearby
  surfaces in frame. Never silently extinguish one.
- Fire consumes the environment only. People and animals never burn — they
  recoil, bolt, or back away from the heat.
- Name only ONE or TWO concrete things the move carries us past. Resist
  re-describing the whole world; that is what makes consecutive prompts
  identical and the picture static.
- Never invent a new location, new characters, or a cut to elsewhere. Only
  reveal things that plausibly continue the space you were given.
- If a fire has just been lit, lead the second half with it igniting: what
  catches, the flame front, the smoke, the light it throws.
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
