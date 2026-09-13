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
image-to-video game. The player is a PERSON standing inside the attached
image, seen from their own eyes — first-person point of view at human eye
level. The controls walk that person around.

Your job is to write how each control READS IN THIS SPECIFIC SCENE. Generic
camera language is useless — "the camera moves forward" tells the video model
nothing. Name what the camera moves past, toward, over, or between, using only
things actually visible in the image.

For each movement, write ONE SHORT CLAUSE naming what the camera passes,
approaches, or reveals — 6 to 12 words, lowercase, no final period.

Do NOT write camera verbs. Never begin with "the camera", "the view", "we see",
or any dolly/pan/crane wording: the camera instruction is added separately and
yours would fight it. Write only the scenery the move carries us through, as a
fragment. Good: "past the moss-draped trunks and the fallen log". Bad: "the
camera pushes forward through the trees".

Write from the eye level of someone on foot in this place: what passes at
shoulder height, what is underfoot, what looms ahead. Ground every clause in
real detail from the image — the surfaces, objects, subjects, depth, and light
that are actually there.

Field rules:
- forward/back: what the camera closes on, or what opens up as it retreats.
- strafeLeft/strafeRight: what slides past on each side.
- turnLeft/turnRight: what swings into frame from off-screen. Infer plausible
  continuations of the visible space.
- rise/descend: what straightening up reveals, or what is close at hand when
  crouching to the ground.
- idle: what keeps moving on its own while the person stands still — wind,
  water, breathing, flame, drifting light. Never "nothing happens".
- sprint: how the motion feels when fast. 2 to 4 words describing MANNER only,
  never a place or direction — "hard and urgent", "at a breathless run". It is
  appended after a comma, so it must read as an adverbial, not a location.
- ignite: fire erupting at a spot the player clicks. Name the material in this
  image that would actually catch — dry grass, timber, paper, fabric, brush —
  and describe flame, smoke, and the firelight it throws. 12 to 22 words.
- douse: the same fire going out. Steam, collapsing flame, blackened wet
  remains. 10 to 18 words.

  ignite and douse MUST each contain the exact token {zone}, used mid-sentence
  as a place and never as the first word. It is replaced with a phrase like
  "lower right of the frame", so write around it: "flames tear through the dry
  scrub at the {zone}, throwing orange light".

  Fire takes hold of the ENVIRONMENT only — ground cover, wood, stone, water's
  edge, structures. People and animals in the image never burn: if any are
  near, they recoil, bolt, or back away from the heat.
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
