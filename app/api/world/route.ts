import { NextResponse } from "next/server";

import { NO_KEY_ERROR, activeProvider, generateText, readImage } from "@/lib/ai";
import { WORLD_SYSTEM_INSTRUCTION } from "@/lib/game-world";

export const runtime = "nodejs";

/** Turns an arbitrary uploaded image into a short, stable world description. */
export async function POST(request: Request) {
  if (!activeProvider()) {
    return NextResponse.json({ error: NO_KEY_ERROR }, { status: 500 });
  }

  const formData = await request.formData();
  const check = await readImage(formData.get("image"));
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  try {
    const world = await generateText({
      system: WORLD_SYSTEM_INSTRUCTION,
      user: "Describe this world.",
      image: check.image,
      temperature: 0.3,
      maxTokens: 512,
    });

    if (!world) {
      return NextResponse.json(
        { error: "The model returned no world description" },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { world },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (caught) {
    console.error("World grounding failed", caught);
    return NextResponse.json(
      { error: "The model could not describe the image" },
      { status: 502 },
    );
  }
}
