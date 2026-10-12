# Choreo

A choreography assistant that lives beside Alainacity. Load a song (usually a
finished mix from Alainacity), and it is counted out in 8-counts. As she builds
the dance she adds notes and section names to those counts, and in later
phases, rehearsal video and formations.

Deployed at `…/song-editor/choreo/`. The name is a placeholder; change it in
`choreo/app.config.ts` and nowhere else. The colours are Alainacity's, read from
its `theme.config.ts`, so the two apps stay a matching pair.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Device check page (iPhone video on her Chromebook) | Built; **needs running on her Chromebook** |
| 1 | Song, 8-count grid, notes, sections, saving | Built and tested in Chrome on macOS; **needs trying on her Chromebook** |
| 2 | Rehearsal video, synced to the counts | Not started; waits on Phase 0's answers |
| 3 | Formation / stage sketches | Not started |
| Later | AI prompts, "send to Choreo" from Alainacity, printable count sheet | Undecided |

Plans and open questions for Phases 2, 3 and later are in [ROADMAP.md](ROADMAP.md).

## When her Chromebook is back

1. **Device check.** Open `…/song-editor/choreo/probe/` on her Chromebook.
   Pick two iPhone clips, transferred the way she normally would: one filmed
   with the iPhone's default settings, one with *Settings → Camera → Formats →
   Most Compatible*. Run the storage test, then copy the results.
   The results decide how Phase 2 handles iPhone video: if the default (HEVC)
   clip doesn't play, the app will tell her to switch the phone to Most
   Compatible rather than trying to convert video on the Chromebook.
2. **Phase 1.** Make a piece from a real song. Things worth watching:
   - does the click land on the beat (tempo detection on real music)?
   - is count 1 in the right place, and does **Count 1 here** fix it if not?
   - does anything feel slow (opening a piece decodes the song and runs tempo detection)?
   - do notes and sections survive closing the tab and coming back?

## How it works

**The song is the clock; everything else is metadata.** Same principle as
Alainacity: the song file is stored once, exactly as imported, and never
changed. A piece is a small JSON document of grid, notes and sections.

**Notes are tied to 8-count numbers; video (Phase 2) will be tied to seconds.**
So nudging the grid moves her notes with the counts, which is what she means,
and can never knock a rehearsal clip out of sync with the music.

**The grid is a list of tempo parts, not one BPM.** A song cut in Alainacity can
change tempo or drop half a beat at a splice. *More → New tempo from here*
starts a new part with its own count 1. Most songs only ever have one.

**"Count 1 here" re-phases; it never renumbers.** Pressing it while 8-count 12
plays fixes where count 1 falls and leaves it as 8-count 12, so no note jumps
to a different phrase. *Start counting here* is the separate action that skips
an intro.

**Tempo detection** (`src/choreo/model/tempo.ts`) finds note attacks over the
whole song, estimates the tempo, then refines it to 0.002 BPM by folding the
whole song at nearby tempos. That precision is the point: 0.1 BPM off has drifted a
third of a beat by the last chorus. Whether a song is "84" or "168" is a dancer's
call, not something in the audio, so ×2 and ÷2 are one click away.

**It cannot interfere with Alainacity.** A separate build
(`vite.choreo.config.ts`), its own service worker scope, cache prefix and storage
directory (`choreo/`, pinned forever in `src/choreo/storage.ts`). It reuses
Alainacity's decoding, peak and storage code without changing it.

One change was made to Alainacity: its service worker now only deletes its own
old caches. Before, it deleted *every* cache on the site when it activated,
which would have wiped this app's offline copy on each Alainacity deploy.

## Running

```sh
npm run dev:choreo        # http://localhost:5174
npm run test:choreo       # model, browser and production suites
```

The device check page is at `/probe/index.html` on the dev server.

## Tests

| Suite | Checks |
|---|---|
| `test:choreo:model` | Grid math across tempo changes; tempo detection on synthetic tracks at known tempos, including precision over a 200 s song |
| `test:choreo:browser` | The whole workflow in real Chrome at 1366×768: detect, check, play, loop, notes, undo, sections, fix the grid, reload, delete |
| `test:choreo:prod` | The real build at its subpath: manifest, worker scope, offline, and that deploying Alainacity leaves this app's cache alone |
