# Song Editor

A browser-native audio editor, built to replace Audacity on a Chromebook.

Audacity on ChromeOS runs inside the Crostini Linux VM, with audio through a
virtualised sound layer and its UI through an X11 translation shim. That stack
is what makes it unstable. Chrome is the *native* runtime on a Chromebook, so
this app skips every one of those layers.

## Status: complete — Phases 1 to 5

Phase 1 (viability) was verified on the target Chromebook: real MP3s open,
playback is clean, memory is comfortable, zoom and scroll are smooth.

Working today: open audio, waveform display with visible fades and effect
regions, playback, Selection and Time Shift tools, selections spanning several
tracks, cut / delete / silence / trim, split at the cursor or into a new track,
a right-click menu, fades, selection-scoped effects
(vocal reduction, muffle, duck, silence), per-track volume / pan / mute / solo
applied live during playback, sync-locked multi-track editing, track reordering,
undo/redo, WAV export of the mix, a selection, or a single track, and projects
that save themselves and reopen where she left off, MP3 and WAV export, and an
installable offline PWA.

### Two things worth knowing

**Sync-lock** (Tracks menu, on by default) makes cuts and pastes apply to every
track. Without it, a ripple cut in one track slides it out of step with the
others — silently, and only audible later. Effects deliberately ignore it; you
never want vocal reduction applied to every track at once.

**Projects save themselves.** Audio is copied into OPFS as the *original
encoded file* — a 5 MB mp3, not 100 MB of decoded samples — so a project reopens
even if the file she imported has since been moved or deleted. Autosave runs on
a debounce and on tab-hide, and `navigator.storage.persist()` is requested on
first run so Chrome will not evict her work under disk pressure.

The save indicator in the status bar goes back to **"unsaved changes"** the
instant anything is edited. An indicator that stays on "saved" while writes are
pending is worse than none — it says the work is safe before it is.

**Everything degrades on an insecure origin.** OPFS and the file pickers need
HTTPS or localhost. Over plain `http://` the app still loads and edits fine, and
says so plainly: "not saving", "saves to Downloads".

**Stopping moves the editing cursor.** Pause where you want to split, and the
split lands there. Without this the cursor stays wherever you last clicked, so
pausing at 2:14 and splitting would cut somewhere else entirely — the failure is
silent, which is what makes it worth calling out.

**Fades and effects are drawn.** Because edits are non-destructive, an edited
region would otherwise look identical to an untouched one. Fades are drawn into
the waveform shape and effect regions get a tinted band and a label, so "where
did I censor?" has a visible answer.

## Design

The load-bearing decision is that **decoded audio is immutable and every edit is
metadata**. A track holds clips; a clip is a range of a source placed at a point
on the timeline. Cutting splits clips and moves them, and never rewrites audio.

This buys three things that matter on a low-memory Chromebook:

- Undo is a snapshot of a small object graph, not a copy of the audio.
- Memory is one decoded copy per imported file, however many edits reference it.
- The audio cannot be corrupted, because nothing ever writes to it.

`src/audio/graph.ts` is shared by live playback and offline export, so what she
hears is what gets written. `src/waveform/peaks.worker.ts` precomputes a peak
pyramid so drawing cost depends on canvas width, not audio length.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Set **Settings → Pages → Source** to
"GitHub Actions". All three test suites gate the deploy.

The base path is derived from the repository name, so the workflow keeps
working if the repo is renamed.

**On shared origins.** Every GitHub Pages project site under
`<user>.github.io` shares one origin, so browser storage is shared between
apps. Everything this app stores is namespaced under `song-editor/` in OPFS,
and the service worker is scoped to its own subpath rather than the origin
root, so a neighbouring app cannot collide with it.

## Running

```sh
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Tests

```sh
npm run test           # all three suites
npm run test:model     # pure edit operations, in node
npm run test:browser   # real Chrome: audio rendering + UI interaction
npm run test:prod      # the real build: service worker, manifest, offline
```

The browser suite renders actual projects and measures the output — which tones
survive a cut, whether the seam is sample-accurate, how deep the vocal null
goes. Web Audio has no useful stand-in outside a browser, so mocking it would
only test the mock.

Fixtures are generated, not committed:

```sh
npm run test:fixtures
```

`tones.wav` is a distinct pitch each second, so a cut is verifiable by which
tones survive and where they land. `stereo-vocal.wav` is a centred 1 kHz tone
over a hard-panned 300 Hz tone, so vocal reduction can be measured: the centred
tone should vanish and the side tone should not move.

Set `CHROME_PATH` if Chrome is not at the default macOS location.

## Measured behaviour

| Check | Result |
|---|---|
| Cut accuracy | Exact — 554 Hz up to the 2s seam, 1109 Hz immediately after |
| WAV export | Header and byte count exact |
| Vocal reduction, centred voice | −35 dB (band 100–8000 Hz) |
| Vocal reduction, side content | 0 dB — untouched |
| Fades | Follow a linear ramp within 6% at every point |
| Mute / solo | Silenced tracks are fully absent from the render |
| Clip snapping | Lands on a neighbouring edge to within 1 ms |
| Split into new track | Bit-for-bit identical audio — max sample difference 0 |
| Project round trip | Hard reload restores tracks, clip layout, name and audio |
| OPFS quota (Chrome) | ~10.7 GB |
| MP3 export | Valid MPEG at ~192 kbps; every tone survives the round trip |
| Offline | Loads and reopens saved projects with the network fully off |
| Initial load | 62 KB gzipped (the 170 KB mp3 encoder loads only on export) |
| Bundle | ~58 KB gzipped |

The browser suite uses a `window.__songEditor` seam to read real editor state.
It is gated behind `import.meta.env.DEV` and is absent from production builds —
`npm run build && grep __songEditor dist/assets/*.js` returns nothing.
