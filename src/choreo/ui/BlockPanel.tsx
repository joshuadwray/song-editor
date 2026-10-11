/**
 * The selected block: name it as a section, and write its notes in full.
 *
 * The timeline shows a line or two of each note; this is where she writes
 * them properly. The mockup's AI suggestions would live here too, later.
 */

import { useEffect, useState } from 'react';
import { SECTION_COLORS } from '../../../choreo/app.config';
import { noteAt, type Piece, type Section } from '../model/piece';
import { ecLabel, ecRangeLabel } from './format';

interface Props {
  piece: Piece;
  lo: number;
  hi: number;
  currentEc: number;
  loopOn: boolean;
  onLoop: () => void;
  onNote: (ec: number, text: string) => void;
  onAddSection: (name: string) => void;
  onUpdateSection: (id: string, patch: Partial<Pick<Section, 'name' | 'color'>>) => void;
  onRemoveSection: (id: string) => void;
}

/** More than this and the panel becomes a scroll of textareas; the timeline is better for that. */
const MAX_NOTES = 8;

export function BlockPanel(p: Props) {
  // The section that exactly matches the selection, if any, is editable here.
  const exact = p.piece.sections.find((s) => s.startEc === p.lo && s.endEc === p.hi);
  const overlapping = p.piece.sections.filter((s) => s.endEc >= p.lo && s.startEc <= p.hi);
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [p.lo, p.hi]);

  const ecs: number[] = [];
  for (let ec = p.lo; ec <= p.hi && ecs.length < MAX_NOTES; ec += 1) ecs.push(ec);

  return (
    <aside className="block-panel" aria-label="Selected 8-counts">
      <div className="bp-head">
        <h2>{ecRangeLabel(p.lo, p.hi)}</h2>
        <button className={`toggle ${p.loopOn ? 'on' : ''}`} aria-pressed={p.loopOn} onClick={p.onLoop}>
          ⟲ {p.loopOn ? 'Looping' : 'Loop these'}
        </button>
      </div>

      <div className="bp-section">
        {exact ? (
          <>
            <input className="section-name" value={exact.name} aria-label="Section name"
              style={{ borderColor: SECTION_COLORS[exact.color % SECTION_COLORS.length] }}
              onChange={(e) => p.onUpdateSection(exact.id, { name: e.target.value })} />
            <span className="swatches" role="group" aria-label="Section colour">
              {SECTION_COLORS.map((c, i) => (
                <button key={c} className={`swatch ${i === exact.color ? 'on' : ''}`} style={{ background: c }}
                  aria-label={`Colour ${i + 1}`} onClick={() => p.onUpdateSection(exact.id, { color: i })} />
              ))}
            </span>
            <button className="link" onClick={() => p.onRemoveSection(exact.id)}>Remove section</button>
          </>
        ) : (
          <form className="name-section" onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) p.onAddSection(draft.trim());
          }}>
            <input value={draft} placeholder={overlapping.length ? `Part of ${overlapping.map((s) => s.name).join(', ')}` : 'Name these 8-counts, e.g. Chorus 1'}
              aria-label="New section name" onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" disabled={!draft.trim()}>Name section</button>
          </form>
        )}
        {p.lo === p.hi && !exact && (
          <p className="hint">Shift-click or drag across the 8-count numbers to select several.</p>
        )}
      </div>

      <div className="bp-notes">
        {ecs.map((ec) => (
          <label key={ec} className={`bp-note ${ec === p.currentEc ? 'now' : ''}`}>
            <span className="bp-note-label">{ec >= 0 ? ecLabel(ec) : 'intro'}</span>
            <textarea value={noteAt(p.piece, ec)} rows={2} placeholder="Steps, counts, ideas…"
              data-ec={ec} aria-label={`Notes for 8-count ${ecLabel(ec)}`}
              onChange={(e) => p.onNote(ec, e.target.value)} />
          </label>
        ))}
        {p.hi - p.lo + 1 > MAX_NOTES && (
          <p className="hint">Showing the first {MAX_NOTES}. Every note is also editable in the timeline below.</p>
        )}
      </div>
    </aside>
  );
}
