# Choreo roadmap

Notes for the phases after 1, written while Phases 0–1 were fresh. Decisions
already made are marked **Decided**; things to settle before building are
under *Open questions*. Read `README.md` first for how the app works today.

Order, agreed in planning: **verify Phase 0–1 on her Chromebook → video → formations
→ (maybe) AI.** Each phase is tried on her real hardware before the next one starts.

---

## Phase 2 — Rehearsal video

The heart of the app: she films rehearsals on her iPhone, drops the clips in,
and they line up with the counts on their own. Playing the song then shows the
dance coming together, using her chosen take for each 8-count.

### Depends on Phase 0's results

Run `…/choreo/probe/` on her Chromebook first. What it returns decides:

| Result | Then |
|---|---|
| Default iPhone (HEVC) clip plays | Accept HEVC as is. Nothing to tell her. |
| HEVC fails, "Most Compatible" (H.264) plays | Detect HEVC at import (the probe's `sniff()` reads the codec from the file) and show a one-time instruction to switch the iPhone to *Settings → Camera → Formats → Most Compatible*. **Do not** transcode in the browser — slow and fragile on a Chromebook. |
| Soundtrack can't be decoded | Auto-sync is off the table; fall back to manual placement (tap count 1 in the clip). Investigate whether it's the container (.mov) or the codec. |
| Low quota or slow writes | Add a size budget per piece and push "delete takes I didn't pick" harder. |

Also note *how* she moves clips across (Google Photos, Drive, cable). Google
Photos downloads may re-encode; that changes the table above.

### Model

**Decided:** clips are placed in **seconds** on the song, never in 8-counts, so
re-gridding can never desync a video.

```ts
interface VideoClip {
  id: string;
  fileId: string;          // stored under pieces/<id>/files/, like the song
  name: string;            // original file name
  songOffset: number;      // song time at which the clip's t=0 plays
  trimIn: number;          // seconds into the clip where it becomes usable
  trimOut: number;
  syncConfidence: number;  // 0..1 from auto-sync; null if placed by hand
  addedAt: number;
}
// On Piece:
clips: VideoClip[];
takePick: Record<string, string>;  // ec index -> clipId; absent = newest covering clip
```

Bump `FORMAT_VERSION` in `src/choreo/storage.ts` only if a Phase 1 piece can't
be read by the new loader. Adding optional fields doesn't need a bump — treat
missing `clips` as `[]`.

**Decided:** a "take" for an 8-count is simply any clip overlapping it. No
separate block concept. Works for both short drill clips and full run-throughs.

### Auto-sync

The clip's soundtrack is the same song played through a speaker in the studio,
so cross-correlation finds where it sits.

1. Decode the clip's audio (`decodeAudioData` on the clip file; Phase 0 confirms this works).
2. Reduce both clip audio and song to an onset envelope at ~100–200 Hz. Reuse
   `onsetEnvelope()` from `src/choreo/model/tempo.ts` — it's already the right
   shape (export it). Onsets beat raw-waveform correlation here: the studio
   speaker, room echo and phone mic change the timbre but not the attacks.
3. Cross-correlate (FFT-based; the radix-2 `fft()` in tempo.ts is reusable) to
   get a coarse offset and a peak-to-sidelobe ratio → `syncConfidence`.
4. Refine to ~1 ms with raw-audio correlation in a ±50 ms window around the peak.
5. Below a confidence threshold: "Couldn't place this clip" → she places it by
   hand (drag on the video lane, or play the clip and tap on a count 1).
6. Always allow a manual nudge afterwards.

Edge cases to test: clip starts before the song (offset negative), she starts
the music mid-song, clip contains two run-throughs (pick the stronger match;
maybe offer the second), music played at a different speed (rare; out of scope).

Tests: generate a "clip" in the browser test from the song fixture, offset by a
known amount, with added noise, reverb (a short convolution) and a level change;
auto-sync must land within 10 ms. MediaRecorder can produce a real H.264 mp4 in
headless Chrome for end-to-end tests: draw frames to a canvas, play an
oscillator into a `MediaStreamDestination`, combine the two streams and record
with `MediaRecorder('video/mp4;codecs=avc1.42E01E,mp4a.40.2')`. That is how the
probe page was checked before Phase 0.

### Playback

- **Decided:** the Web Audio song stays the master clock (`src/choreo/audio/player.ts`).
  Videos are muted `<video>` elements that follow it.
- Each animation frame: target = songTime − songOffset. If drift > ~60 ms,
  re-seek; for small drift, nudge `playbackRate` (0.97–1.03) instead of seeking,
  because seeking stutters.
- **Two `<video>` elements, alternating**: the next 8-count's take is loaded and
  seeked ahead of the boundary, then swapped visible at the boundary. No black
  flash between takes.
- 8-counts with no take: show the current count display card (today's
  `CountDisplay`) in the video's place, with that 8-count's note.
- Overlay on the video: "8-count 11 · count 5" and the section name (the mockup had this).
- Loop + video must work together — looping one 8-count while watching one take
  is likely the most-used mode.

### UI

- The video goes where the count display is now (left of the block panel).
  Shrink the count display to a strip under or over the video.
- New timeline lane "Video" between Music and Notes: clips drawn as bars at
  their position; the take shown per 8-count highlighted; a ▾ on the 8-count to
  choose between takes. Drag a bar to adjust sync.
- Block panel gets a "Takes" list for the selected 8-counts: thumbnail, date,
  "use this one".
- Import: button + drag-and-drop, several files at once, a progress line per
  clip ("syncing 2 of 5…").

### Storage

- Videos are 30–100 MB/minute from an iPhone. Phase 0 reports the quota.
- Usage bar on the start screen (`estimateUsage()` from `src/storage/opfs.ts`).
- "Delete takes I didn't pick" per piece, with a count and size, and inline confirm.
- Call `requestPersistence()` on first video import (already called on piece open).
- Keep the original file untouched, like the song. No thumbnails stored —
  generate them on the fly from the video.

### Open questions

- Does she film whole run-throughs or short sections? (Affects the take picker's design more than the model.)
- Should she be able to mark a take as "the good one" for a whole section in one go?
- Mirror the video (dancers often learn from mirrored video)? Cheap: a CSS `scaleX(-1)` toggle.
- Slow-motion playback (0.5×, 0.75×) for learning? Needs `preservesPitch` on the
  audio, which an AudioBufferSourceNode doesn't do — would need a different
  playback path. Worth asking her before building.

---

## Phase 3 — Formations / stage sketches

**Decided:** in scope (she wants it); start at **one formation per 8-count**,
not per count.

- A cast list per piece: names + colours (dancer dots).
- Stage view: a rectangle with "audience" marked downstage, optionally a grid
  (stage numbers / centre line), since dancers place by those.
- Per 8-count: positions of each dancer. A new 8-count starts as a copy of the previous one.
- Playback: dots glide between one 8-count's formation and the next. Simple
  linear interpolation over the 8-count, or "move on counts 5–8" (ask her).
- Where: a toggle in the video area (video / stage / both side by side), or full screen.
- Model sketch: `cast: { id, name, color }[]`, `formations: Record<ec, Record<dancerId, { x, y }>>`
  with x/y in 0..1 stage coordinates. Missing ec = inherit previous.
- Open: does she need paths (curves) or just start/end positions? Per-count
  formations for fast sections? Print/export of formations for dancers?

---

## Later — decide after she has used Phases 1–2

### AI prompts (from the original mockup)
The mockup's "What should the next chunk do? Continue / Contrast / Develop
motif" panel, which reads her notes for nearby 8-counts and suggests ideas.
- Needs a network connection and an API key. The key can't live in the public
  Pages site, so it needs a small proxy (e.g. a Cloudflare Worker) — the first
  server this project would have. That's the real cost: something to keep running.
- Context to send: notes and section names for the selected block and its
  neighbours; maybe tempo and section energy.
- The design already leaves room: it would sit in the block panel.
- Only worth it if she asks for it after using the app.

### "Send to Choreo" from Alainacity
Same origin, so Alainacity could render its mix and write it straight into
Choreo's storage (`choreo/inbox/…`), skipping export + import. Small, but
touches Alainacity, so do it only if the export/import round trip annoys her.

### Printable count sheet
8-count number · section · note, for rehearsals and for dancers. A print
stylesheet on a "count sheet" view would do; no export format needed.

---

## Known limits of Phase 1 (fix if they bite)

- **Half/double tempo.** Detection prefers ~115 BPM; outside 92–140 it sometimes
  picks half or double. ×2/÷2 is the fix. A smarter rule needs real songs to
  tune against — collect the ones it gets wrong.
- **Tempo detection assumes a steady tempo.** Live recordings that drift will
  need several tempo parts by hand. A beat tracker (per-beat, not per-tempo)
  would solve it but is much more work.
- **Undo inside a note box** uses the browser's own text undo; Ctrl+Z outside
  the box undoes whole notes (typing in one 8-count within 1.5 s is one step).
- **Fonts** are system fonts (the mockup used IBM Plex); bundling a font would
  have to be served locally to keep working offline.
- **Name and icon** are placeholders (`choreo/app.config.ts`, `choreo/assets/`). The
  palette is Alainacity's, imported from `theme.config.ts`, so retheme there.
- **The dev-server probe URL** is `/probe/index.html` (on the live site `/probe/` works).
- **Delete the probe page** (`choreo/public/probe/`) once Phase 0 is answered,
  and its check in `test/choreo-production.test.mjs`.
