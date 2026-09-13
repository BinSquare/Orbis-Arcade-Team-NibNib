# Orbis Arcade

Drop in any image and play it. A Next.js app for the Reactor-hosted Visko Orbis
Stable API that turns a still image into a live, controllable world: WASD moves
the camera, the mouse aims, and clicks act on whatever is under the crosshair.

There is no prompt box. Input is encoded into steering prompts for you.

## Requirements

- Node.js 20.9 or newer
- A Reactor API key with access to Visko Orbis Stable
- An OpenAI **or** Google Gemini API key — see *The AI layers* below

## Run locally

```bash
cp .env.example .env.local
# Add your keys to .env.local.
npm install
npm run dev
```

Open <http://localhost:3000>.

```dotenv
REACTOR_API_KEY=your_reactor_api_key
OPENAI_API_KEY=your_openai_api_key   # or GEMINI_API_KEY
```

Both keys stay server-side. The browser only ever receives the short-lived
Reactor JWT and the generated world text.

## Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Push the camera forward / pull back |
| `A` / `D` | Slide left / right |
| `Q` / `E` | Turn the view left / right |
| `Space` / `C` | Rise / descend |
| `Shift` | Move quickly |
| Mouse move | Aim — the scene holds attention where you point |
| Left click | Act — whatever is there reacts and moves |
| Right click | Calm — that element recedes or settles |
| `P` / `M` / `Esc` | Pause · sound · exit world |

## How input becomes video

Orbis has no gamepad input. Its only control surface is `set_prompt`, applied at
the next chunk boundary. Generic camera language ("the camera pushes forward")
gives the video model nothing to grab onto, so **an AI director writes the
prompts** — grounded in your specific image.

A Gemini call takes 1-3s and chunk boundaries are ~1.8s apart, so a synchronous
call per chunk is impossible. Two layers solve that:

**1. The lexicon** (`/api/lexicon`, one call when the image loads). The model
writes, for each control, a short fragment naming what that move carries you
past *in this scene* — "past the retriever's feathery tail and lichen-mottled
foreground stone". Composing from it is instant, so every boundary has
something grounded to send.

The camera verb itself is **not** left to the model: `CAMERA_MOVES` in
`lib/game-director.ts` maps each control to film grammar (`dolly in`,
`truck left`, `crane up`, `pan right`) and that leads the prompt. An early
version had the model describe what the shot would contain, which reads as a
static state and rendered as one — the camera never actually moved.

**2. The director** (`/api/direct`, async, per input combination). Input state
is reduced to a signature — held keys, aim bucketed to a 3x3 zone, last click.
The first time you hold forward-left you get the composed prompt; the director
is asked for a bespoke one in the background and cached against that signature,
so every later boundary with the same input gets Gemini's. Players hold inputs
for seconds at a time, so the cache warms almost immediately and **never adds
latency to a boundary**.

The `LAST PROMPT` panel shows `DIRECTED` or `COMPOSED` for which layer produced
the prompt, plus a `sent/cached` count.

### State is what makes it coherent

Prompts were originally stateless — each chunk independently said "push
forward", so the model re-interpreted the scene every 1.8s and nothing
accumulated. `lib/game-camera.ts` fixes that with two pieces of state:

- **Camera pose.** WASD integrates at 10Hz into advance / strafe / elevation /
  yaw, which is rendered as displacement from the opening view: *"the camera now
  sits a fair distance deeper into the scene, rotated about 120 degrees to the
  left"*. Holding W becomes travel instead of a repeated instruction, and the
  director is told to describe what faces the camera **now**, never to cut back
  to the opening view.
- **World memory.** A click appends to a log kept for three chunks. The chunk it
  lands on fires the interaction; the ones after say *"whatever was disturbed at
  the centre is still active and has not returned to how it was"*, so effects
  persist instead of snapping back.

Both feed the cache key, so moving somewhere genuinely new correctly
invalidates a cached prompt while small drift still reuses it.

Two more structural choices:

- **The action goes first, the world anchor last.** Leading with the world
  buried the only part that changes between chunks.
- **A click is never deduped.** Held keys are — re-sending identical text just
  spends a boundary — but a click is a one-shot event and always goes out.

### Why prompts are short

An early version sent 65 words of which ~60 were unchanging scene description.
Consecutive prompts were 97% identical and only ~4 words concerned motion, so
the video just carried on doing whatever it was doing. Now the camera
instruction leads, the world anchor is dropped entirely while moving, and a
moving prompt is ~30 words. The anchor returns only when the player is still,
which is when drift is the real risk.

Motion is also re-sent every boundary even when nothing changed. Orbis
continues whatever it was doing, so an unreinforced camera move coasts to a
halt — and the pose bucket saturates after a few seconds of held input, which
used to stop the sends altogether. Dedupe now applies only when the player is
still.

### Latency

Orbis applies whatever prompt it holds at each ~1.8s chunk boundary, so that
boundary is the floor. The loop sends the moment input changes rather than
waiting for a boundary of its own — waiting cost a full chunk before the prompt
was even queued, and Orbis then took another to apply it, roughly 3.6s from
keypress to picture. Sending immediately (rate-limited to one per 350ms) means
the newest input is already queued when the boundary arrives.

Camera speeds are scaled so that one chunk of held input visibly changes the
pose language. At the original 1.0 units/s against a limit of 12, a full chunk
of `W` moved 0.15 of the scale and produced the same sentence twice, which read
as the controls doing nothing.

The `NEXT` meter shows time to the boundary where your queued input takes
effect; `QUEUED` means something is waiting on it.

## The AI layers

`lib/ai.ts` is provider-agnostic: set `OPENAI_API_KEY` or `GEMINI_API_KEY` and
the routes use whichever is present (OpenAI wins if both are). Defaults are
`gpt-5.6-luna` and `gemini-3.5-flash`, overridable via `OPENAI_MODEL` /
`GEMINI_MODEL`.

When you drop an image, two calls run before you can enter:

1. `POST /api/world` — the model describes the image as a short, stable place
   (under 70 words, no camera moves, no actions, since the player supplies
   those). This is the anchor repeated in every prompt to prevent drift, and it
   stays editable before you enter. ~4s.
2. `POST /api/lexicon` — the model writes the movement lexicon for that image,
   as strict-schema JSON. ~8s.

Measured with `gpt-5.6-luna`: world ~4s, lexicon ~8s (both one-time, at image
load), director ~3-5s (async, never blocking). Note the GPT-5.6 family rejects
any `temperature` but its default, so the OpenAI path never sends one.

With no key, all three fall back: the world becomes a generic description built
from the filename, the lexicon becomes generic camera language, and the director
is skipped entirely rather than burning failed requests. The badges read
`IMAGE ONLY` and `GENERIC`.

It still runs, but this is exactly the state where inputs feel like they do
nothing — the prompts have nothing to do with your image. Set the key.

## Interface

The UI is built from two component libraries with a deliberate split:

- **[Neobrutalism](https://neobrutalism.com/)** is the cabinet — topbar,
  buttons, side panels, badges. Vendored into `components/ui/` from its shadcn
  registry, so those files are yours to edit.
- **[Pixel RetroUI](https://retroui.io/)** is the arcade layer inside it — the
  cartridge-slot world loader, the chunk meter, and the Minecraft font on every
  HUD readout.

They share one palette (arcade yellow, CRT purple, mint), which is what keeps
the pairing reading as one machine.

**Layer order matters.** `app/styles.css` opens with
`@layer theme, base, pixel, components, utilities;` *before* any import. Without
it the bundler loses Tailwind's own ordering statement, preflight outranks
utilities, and borders silently collapse to `0px` while `bg-*` stops applying to
buttons. The declaration also slots Pixel RetroUI between base and components:
its component look beats preflight, and Tailwind utilities still beat it — which
is what the library's own docs achieve with a blunt `important: true`.

## Connection notes

`POST /sessions` answers 429 for two unrelated reasons, and both clear on their
own, so `connectSession` retries with backoff:

- `no available capacity` — Reactor's GPU pool is full.
- `quota_exceeded` — the account already holds its one allowed concurrent
  session. Usually a browser tab still connected; closing a tab does not tear
  the session down cleanly, so prefer **Disconnect**.

## API flow

1. `POST /api/token` requests a scoped session JWT from
   `https://api.reactor.inc/tokens`.
2. `ReactorProvider` connects to `reactor/visko-orbis-stable` with the recv-only
   `main_video` and `main_audio` tracks.
3. The model sends a `state` snapshot whose `available_resolutions` replaces the
   documented defaults.
4. The world image is uploaded and passed to `set_image` before `start`.
5. `set_resolution` stages a tier for the next `start`; the documented default
   is `2k`.
6. `set_prompt` supplies the world prompt, then `start` begins generation.
7. From then on the game loop sends `set_prompt` once per chunk boundary.

## Documented model behavior

- A prompt is required before `start`; the reference image is optional, though
  this app always sends one.
- A 16:9 reference image works best. Other ratios are resized without cropping
  and may look distorted.
- Treat `state.available_resolutions` as authoritative after connecting.
- `set_resolution` applies from the next `start`, not during a run.
- The first chunk emits no frames while the upscaler primes. This is expected.
- Commands are asynchronous. Use `state`, `prompt_accepted`,
  `generation_started`, `chunk_complete`, and `command_error` as the source of
  truth.
- `pause` takes effect after the current chunk. `resume` continues the same
  generation; `reset` clears the prompt and image.

## Project files

- `app/api/token/route.ts` — server-side Reactor token exchange.
- `app/api/world/route.ts` — turns an uploaded image into a world description.
- `app/api/lexicon/route.ts` — writes how each control reads in that image.
- `app/api/direct/route.ts` — bespoke prompt for one input combination.
- `components/game-shell.tsx` — provider, layout, and global hotkeys.
- `components/game-viewport.tsx` — video surface, crosshair, ripples, zone grid.
- `components/game-hud.tsx` — keycaps, action readout, world and event panels.
- `components/world-loader.tsx` — image intake and world editing.
- `components/ui/` — vendored Neobrutalism components.
- `hooks/use-game-input.ts` — keyboard and pointer capture.
- `hooks/use-game-loop.ts` — chunk-boundary steering loop.
- `hooks/use-orbis-session.ts` — Orbis command sequence and session state.
- `lib/game-input.ts` — key bindings, pointer state, spatial vocabulary.
- `lib/game-director.ts` — lexicon, situation signatures, prompt composition.
- `lib/game-camera.ts` — camera pose integration and world memory.
- `lib/game-world.ts` — world grounding prompt and client helper.
- `lib/ai.ts` — provider-agnostic text and JSON generation (OpenAI / Gemini).
- `lib/orbis.ts` — model configuration and message helpers.

`app/api/nano-banana/route.ts`, `app/api/orbis-prompt/route.ts`, their `lib/`
prompts, and `dog.png` are the original starter's image-editing kickoff demo.
Nothing in the game UI calls them; they are left in place as working reference.

## Reference

- [Visko Orbis Stable API](https://www.reactor.inc/models/visko-orbis-stable/api)
- [Visko Orbis Dynamic API](https://www.reactor.inc/models/visko-orbis-dynamic/api)
- [Gemini image generation and editing](https://ai.google.dev/gemini-api/docs/image-generation)
