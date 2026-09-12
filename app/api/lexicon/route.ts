import { NextResponse } from "next/server";

import {
  NO_KEY_ERROR,
  activeProvider,
  generateStringMap,
  readImage,
} from "@/lib/ai";
import { LEXICON_FIELDS } from "@/lib/game-director";

export const runtime = "nodejs";

const SYSTEM_INSTRUCTION = `You are the movement director for a real-time
image-to-video game. The player controls a camera inside the attached image.

Your job is to write how each control READS IN THIS SPECIFIC SCENE. Generic
camera language is useless — "the camera moves forward" tells the video model
nothing. Name what the camera moves past, toward, over, or between, using only
things actually visible in the image.

For each movement, write one present-tense clause, 8 to 18 words, lowercase, no
final period. It must be grounded in real detail from the image: the surfaces,
objects, subjects, depth, and light that are actually there.

Field rules:
- forward/back: what the camera closes on, or what opens up as it retreats.
- strafeLeft/strafeRight: what slides past on each side.
- turnLeft/turnRight: what swings into frame from off-screen. Infer plausible
  continuations of the visible space.
- rise/descend: what the new vantage reveals or looms over.
- idle: what keeps moving on its own when the player is still — wind, water,
  breathing, flame, drifting light. Never "nothing happens".
- sprint: how the motion feels when fast. 2 to 4 words describing MANNER only,
  never a place or direction — "hard and urgent", "at a breathless run". It is
  appended after a comma, so it must read as an adverbial, not a location.
- interact: what happens when the player acts on a spot. MUST contain the exact
  token {zone}, used mid-sentence as a place, never as the first word. It is
  substituted with a phrase like "lower right of the frame", so write around it:
  "the reeds at the {zone} thrash and scatter". Describe reaction and motion.
- calm: the opposite, same {zone} rule. Settling, stilling, receding.
- anchor: at most 25 words re-stating the scene's identity, subjects, and
  lighting so a long run cannot drift. Present tense, no camera language.

Plain text in every field. No Markdown, no quotes, no commentary.`;

export async function POST(request: Request) {
  if (!activeProvider()) {
    return NextResponse.json({ error: NO_KEY_ERROR }, { status: 500 });
  }

  const formData = await request.formData();
  const check = await readImage(formData.get("image"));
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const world = formData.get("world");

  try {
    const lexicon = await generateStringMap({
      schemaName: "action_lexicon",
      fields: LEXICON_FIELDS,
      system: SYSTEM_INSTRUCTION,
      user:
        typeof world === "string" && world.trim()
          ? `The world: ${world.trim()}`
          : "Describe movement through this world.",
      image: check.image,
      temperature: 0.6,
      maxTokens: 2_048,
    });

    // The model occasionally drops the placeholder; without it a click would
    // silently lose its position, which is the whole point of the interaction.
    for (const field of ["interact", "calm"] as const) {
      if (!lexicon[field]?.includes("{zone}")) {
        lexicon[field] = `${lexicon[field] || "the scene reacts"} at the {zone}`;
      }
    }

    return NextResponse.json(
      { lexicon },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (caught) {
    console.error("Lexicon generation failed", caught);
    return NextResponse.json(
      { error: "The model could not build a movement lexicon" },
      { status: 502 },
    );
  }
}
