import assert from 'node:assert/strict';
import { emptyProject, trackFromSource, clipEnd, projectDuration } from '../src/model/project';
import type { AudioSource } from '../src/model/project';
import { addTrack, deleteRange, trimToRange, splitAt, copyRange, insertClips, fadeRange, applyEffectToRange, shiftTrack, moveClip, moveTrackTo, snapCandidates, splitIntoNewTrack, trackExtent } from '../src/model/edits';

const src: AudioSource = { id: 's1', name: 'test', sampleRate: 44100, channels: 2, duration: 10 };
const base = addTrack({ ...emptyProject(), sources: { s1: src } }, trackFromSource(src));
const tid = base.tracks[0].id;

/** Sum of clip durations, i.e. how much audio survives. */
const audioLen = (p: typeof base) => p.tracks[0].clips.reduce((n, c) => n + (c.sourceEnd - c.sourceStart), 0);
/** Map a timeline position back to the source time it plays. */
function sourceAt(p: typeof base, t: number): number | null {
  for (const c of p.tracks[0].clips) {
    if (t >= c.timelineStart && t < clipEnd(c)) return c.sourceStart + (t - c.timelineStart);
  }
  return null;
}

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log('  ok', name); };

console.log('cut from the middle (ripple)');
{
  const p = deleteRange(base, [tid], 3, 5, true);
  check('two seconds are gone', () => assert.equal(audioLen(p), 8));
  check('timeline closes the gap', () => assert.equal(projectDuration(p), 8));
  check('audio before the cut is untouched', () => assert.equal(sourceAt(p, 2.5), 2.5));
  check('audio after the cut is pulled left by exactly the cut length', () => {
    assert.equal(sourceAt(p, 3), 5);
    assert.equal(sourceAt(p, 4.5), 6.5);
  });
  check('no gap remains', () => assert.equal(p.tracks[0].clips.length, 2));
}

console.log('silence (leave gap)');
{
  const p = deleteRange(base, [tid], 3, 5, false);
  check('audio is removed but the timeline keeps its length', () => {
    assert.equal(audioLen(p), 8);
    assert.equal(projectDuration(p), 10);
  });
  check('the gap really is empty', () => assert.equal(sourceAt(p, 4), null));
  check('later audio has not moved', () => assert.equal(sourceAt(p, 6), 6));
}

console.log('trimming the head and tail');
{
  const head = deleteRange(base, [tid], 0, 2, true);
  check('trimming the start shifts everything back to zero', () => {
    assert.equal(sourceAt(head, 0), 2);
    assert.equal(projectDuration(head), 8);
  });
  const tail = deleteRange(base, [tid], 8, 10, true);
  check('trimming the end leaves the start alone', () => {
    assert.equal(sourceAt(tail, 0), 0);
    assert.equal(projectDuration(tail), 8);
  });
  const both = trimToRange(base, [tid], 2, 8);
  check('trim-to-selection keeps only the selection, in place', () => {
    assert.equal(audioLen(both), 6);
    assert.equal(both.tracks[0].clips[0].timelineStart, 2);
    assert.equal(sourceAt(both, 2), 2);
  });
}

console.log('splitting');
{
  const p = splitAt(base, [tid], 4);
  check('one clip becomes two', () => assert.equal(p.tracks[0].clips.length, 2));
  check('splitting changes nothing you can hear', () => {
    assert.equal(audioLen(p), 10);
    assert.equal(sourceAt(p, 4), 4);
    assert.equal(sourceAt(p, 3.999), 3.999);
  });
  check('splitting at an existing edge is a no-op', () => {
    assert.equal(splitAt(p, [tid], 0).tracks[0].clips.length, 2);
  });
}

console.log('copy and paste');
{
  const clips = copyRange(base, [tid], 3, 5);
  check('copied audio is normalised to start at zero', () => {
    assert.equal(clips.length, 1);
    assert.equal(clips[0].timelineStart, 0);
    assert.equal(clips[0].sourceStart, 3);
    assert.equal(clips[0].sourceEnd, 5);
  });
  const p = insertClips(base, tid, 7, clips);
  check('paste lengthens the project by the pasted duration', () => assert.equal(projectDuration(p), 12));
  check('pasted audio lands at the paste point', () => assert.equal(sourceAt(p, 7.5), 3.5));
  check('audio after the paste point is pushed later, not overwritten', () => assert.equal(sourceAt(p, 9), 7));
}

console.log('effects and fades are scoped to the selection');
{
  const p = applyEffectToRange(base, [tid], 4, 4.5, { type: 'vocalReduce', amount: 1, lowHz: 100, highHz: 8000 });
  check('the region is split into exactly three clips', () => assert.equal(p.tracks[0].clips.length, 3));
  check('only the middle clip carries the effect', () => {
    assert.deepEqual(p.tracks[0].clips.map((c) => c.effects.length), [0, 1, 0]);
  });
  check('the effected clip covers precisely the selection', () => {
    const mid = p.tracks[0].clips[1];
    assert.equal(mid.timelineStart, 4);
    assert.equal(clipEnd(mid), 4.5);
  });
  check('no audio is lost', () => assert.equal(audioLen(p), 10));

  const f = fadeRange(base, [tid], 0, 3, 'in');
  check('a fade spans the selection', () => assert.equal(f.tracks[0].clips[0].fadeIn, 3));
}

console.log('time shift');
{
  const p = shiftTrack(base, tid, 2.5);
  check('the track moves later', () => assert.equal(sourceAt(p, 2.5), 0));
  const clamped = shiftTrack(base, tid, -5);
  check('a track cannot be dragged before zero', () => assert.equal(clamped.tracks[0].clips[0].timelineStart, 0));
}

console.log('immutability');
{
  const before = JSON.stringify(base);
  deleteRange(base, [tid], 1, 2, true);
  trimToRange(base, [tid], 1, 2);
  splitAt(base, [tid], 5);
  check('edits never mutate the project they were given', () => assert.equal(JSON.stringify(base), before));
}



console.log('\nmoving clips along the timeline');
{
  const split = splitAt(base, [tid], 4);
  const [first, second] = split.tracks[0].clips;

  const moved = moveClip(split, tid, second.id, 6);
  check('a clip can be dragged later, leaving a gap', () => {
    assert.equal(sourceAt(moved, 6), 4);
    assert.equal(sourceAt(moved, 5), null);
  });
  check('moving a clip does not alter the audio it plays', () => assert.equal(audioLen(moved), 10));

  const collided = moveClip(split, tid, second.id, 1);
  check('a clip cannot be dragged over its neighbour', () => {
    assert.equal(collided.tracks[0].clips.find((c) => c.id === second.id)!.timelineStart, 4);
  });
  const negative = moveClip(split, tid, first.id, -3);
  check('a clip cannot be dragged before zero', () => {
    assert.equal(negative.tracks[0].clips.find((c) => c.id === first.id)!.timelineStart, 0);
  });
}

console.log('snap targets');
{
  const split = splitAt(base, [tid], 4);
  const [, second] = split.tracks[0].clips;
  const targets = snapCandidates(split, second.id);
  check('the timeline start is always a target', () => assert.ok(targets.includes(0)));
  check('the other clip contributes both its edges', () => {
    assert.ok(targets.includes(4));
  });
  check('the dragged clip does not snap to itself', () => {
    assert.ok(!snapCandidates(split, second.id).includes(10) || targets.filter((t) => t === 10).length === 0);
  });
}

console.log('track order');
{
  const two = addTrack(base, trackFromSource({ ...src, id: 's2' }));
  const secondId = two.tracks[1].id;
  const up = moveTrackTo(two, secondId, -1);
  check('a track can be moved up the stack', () => assert.equal(up.tracks[0].id, secondId));
  check('moving past the top is a no-op', () => {
    assert.equal(moveTrackTo(up, secondId, -1).tracks[0].id, secondId);
  });
}

console.log('sync-locked editing');
{
  // Passing null as the track list is how sync-lock reaches every track.
  const two = addTrack(base, trackFromSource({ ...src, id: 's2' }));
  const cut = deleteRange(two, null, 3, 5, true);
  check('a ripple cut shortens every track by the same amount', () => {
    assert.equal(projectDuration(cut), 8);
    for (const t of cut.tracks) {
      assert.equal(t.clips.reduce((n, c) => n + (c.sourceEnd - c.sourceStart), 0), 8);
    }
  });
  check('both tracks stay aligned afterwards', () => {
    const [a, b] = cut.tracks;
    assert.deepEqual(
      a.clips.map((c) => c.timelineStart),
      b.clips.map((c) => c.timelineStart),
    );
  });
}



console.log('\nsplitting into a new track');
{
  const p = splitIntoNewTrack(base, tid, 4);
  check('the project gains one track', () => assert.equal(p.tracks.length, 2));
  check('the new track is named after the original', () => assert.equal(p.tracks[1].name, 'test (2)'));
  check('the first track keeps only the audio before the split', () => {
    const e = trackExtent(p.tracks[0])!;
    assert.equal(e.start, 0);
    assert.equal(e.end, 4);
  });
  check('the new track holds the rest, at its original timeline position', () => {
    const e = trackExtent(p.tracks[1])!;
    assert.equal(e.start, 4);
    assert.equal(e.end, 10);
  });
  check('no audio is gained or lost', () => {
    const total = p.tracks.reduce(
      (n, t) => n + t.clips.reduce((m, c) => m + (c.sourceEnd - c.sourceStart), 0),
      0,
    );
    assert.equal(total, 10);
  });
  check('splitting at the very start does nothing', () => {
    assert.equal(splitIntoNewTrack(base, tid, 0).tracks.length, 1);
  });
  check('splitting past the end does nothing', () => {
    assert.equal(splitIntoNewTrack(base, tid, 10).tracks.length, 1);
  });
  check('the new track sits directly below the original', () => {
    const three = addTrack(base, trackFromSource({ ...src, id: 's2' }));
    const q = splitIntoNewTrack(three, tid, 4);
    assert.equal(q.tracks[1].name, 'test (2)');
    assert.equal(q.tracks.length, 3);
  });
}

console.log(`\n${n} checks passed`);
