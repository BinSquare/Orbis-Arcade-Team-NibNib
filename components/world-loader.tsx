"use client";

import { Card as PixelCard, TextArea as PixelTextArea } from "pixel-retroui";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { fallbackLexicon, requestLexicon, type ActionLexicon } from "@/lib/game-director";
import { requestWorld, type WorldCartridge } from "@/lib/game-world";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type WorldLoaderProps = {
  connected: boolean;
  busy: boolean;
  connectNotice: string;
  resolution: string;
  availableResolutions: string[];
  onResolution: (value: string) => void;
  onConnect: () => void;
  onLaunch: (cartridge: WorldCartridge) => void;
};

/**
 * Pre-run cartridge slot: take any image, turn it into a world, drop the
 * player in. This is the arcade layer, so it is built from Pixel RetroUI's
 * Card and TextArea — the neobrutalist Button carries the primary action so
 * the call to action still matches the cabinet around it.
 */
export function WorldLoader({
  connected,
  busy,
  connectNotice,
  resolution,
  availableResolutions,
  onResolution,
  onConnect,
  onLaunch,
}: WorldLoaderProps) {
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [world, setWorld] = useState("");
  const [grounded, setGrounded] = useState(false);
  const [lexicon, setLexicon] = useState<ActionLexicon | null>(null);
  const [lexiconGrounded, setLexiconGrounded] = useState(false);
  const [reading, setReading] = useState(false);
  const [phase, setPhase] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const accept = async (candidate: File | null | undefined) => {
    if (!candidate) return;
    if (!candidate.type.startsWith("image/")) {
      setNotice("That file is not an image.");
      return;
    }
    if (candidate.size > MAX_IMAGE_BYTES) {
      setNotice("Images must be 10 MB or smaller.");
      return;
    }

    setNotice("");
    setImage(candidate);
    setReading(true);
    setWorld("");
    setLexicon(null);

    setPhase("READING IMAGE…");
    const result = await requestWorld(candidate);
    setWorld(result.world);
    setGrounded(result.grounded);

    // The lexicon is what makes the controls feel like they touch this scene,
    // so it is built here rather than at launch — by the time the player hits
    // Enter world it is already waiting.
    setPhase("BUILDING CONTROLS…");
    const built = await requestLexicon(candidate, result.world);
    setLexicon(built.lexicon);
    setLexiconGrounded(built.grounded);

    setPhase("");
    setReading(false);
    if (!result.grounded || !built.grounded) {
      setNotice(
        "Gemini is unavailable, so the world and controls fall back to generic phrasing. Add GEMINI_API_KEY to make inputs actually bite.",
      );
    }
  };

  const ready = Boolean(
    image && world.trim() && lexicon && connected && !reading && !busy,
  );

  return (
    <PixelCard
      className="pixel-flush w-[min(580px,100%)]"
      bg="#221d30"
      textColor="#f7f3e8"
      borderColor="#000000"
      shadowColor="#c381b5"
    >
      <div className="flex flex-col gap-4 p-6">
        <div>
          <span className="font-pixel text-xs tracking-[0.2em] text-primary">
            INSERT CARTRIDGE
          </span>
          <h2 className="mt-2 text-2xl leading-tight">
            Drop in an image. Play what&apos;s inside it.
          </h2>
        </div>

        <div
          className={`grid aspect-video max-h-[190px] cursor-pointer place-items-center overflow-hidden border-4 border-border shadow-md transition-transform ${
            dragging
              ? "-translate-x-0.5 -translate-y-0.5 bg-primary/20 shadow-lg"
              : "bg-background"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void accept(event.dataTransfer.files?.[0]);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInput.current?.click();
            }
          }}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Selected world"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="font-pixel text-sm text-foreground">
                DROP AN IMAGE
              </span>
              <span className="font-pixel text-[0.65rem] text-muted-foreground">
                OR CLICK TO BROWSE · 16:9 BEST · MAX 10MB
              </span>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => void accept(event.target.files?.[0])}
          />
        </div>

        {(reading || world) && (
          <label className="flex flex-col gap-2">
            <span className="font-pixel text-[0.65rem] tracking-widest text-muted-foreground">
              WORLD DESCRIPTION
              {reading ? ` · ${phase}` : grounded ? " · GEMINI" : " · FALLBACK"}
            </span>
            <PixelTextArea
              value={reading ? "" : world}
              placeholder={reading ? phase : ""}
              onChange={(event) => setWorld(event.target.value)}
              bg="#17141f"
              textColor="#f7f3e8"
              borderColor="#000000"
              style={{ minHeight: 96, resize: "vertical" }}
            />
          </label>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[150px] flex-1 flex-col gap-2">
            <span className="font-pixel text-[0.65rem] tracking-widest text-muted-foreground">
              RESOLUTION
            </span>
            <NativeSelect
              className="w-full"
              value={resolution}
              onChange={(event) => onResolution(event.target.value)}
            >
              <NativeSelectOption value="">Model default (2k)</NativeSelectOption>
              {availableResolutions.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>

          {connected ? (
            <Button
              size="lg"
              disabled={!ready}
              onClick={() =>
              image &&
              onLaunch({
                image,
                world: world.trim(),
                worldGrounded: grounded,
                // The player may have edited the world text after the lexicon
                // was built; regenerate the fallback anchor from what they see.
                lexicon: lexicon ?? fallbackLexicon(world.trim()),
                lexiconGrounded: lexiconGrounded && Boolean(lexicon),
              })
            }
            >
              {busy ? "ENTERING…" : "ENTER WORLD"}
            </Button>
          ) : (
            <Button size="lg" disabled={busy} onClick={onConnect}>
              {busy ? "CONNECTING…" : "CONNECT TO ORBIS"}
            </Button>
          )}
        </div>

        {connectNotice && (
          <p className="font-pixel border-2 border-border bg-muted px-3 py-2 text-[0.68rem] leading-relaxed text-muted-foreground shadow-xs">
            {connectNotice}
          </p>
        )}
        {notice && (
          <p className="font-pixel border-2 border-border bg-muted px-3 py-2 text-[0.68rem] leading-relaxed text-muted-foreground shadow-xs">
            {notice}
          </p>
        )}
      </div>
    </PixelCard>
  );
}
