import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignAvailability, DesignRevision, DesignSessionDetail, DesignSessionSummary } from '@hcg/shared';
import {
  deleteDesignSession,
  fetchDesignAvailability,
  fetchDesignSession,
  listDesignSessions,
  publishDesign,
  refineDesign,
  revertDesign,
  saveDesignDraft,
  startDesignSession,
} from '../api';

/**
 * Describe a card game in plain language; get a working plugin back.
 *
 * The panel is a conversation, not a form. That shape is doing real work: a
 * first description of a game is essentially never complete ("like Spades but
 * three players" leaves the deck, the bidding and the scoring unstated), so the
 * useful unit is a turn — say what to change, see the new draft, say the next
 * thing — rather than one big prompt the author is expected to get right.
 *
 * Three things it deliberately shows rather than hides:
 *
 *  - **The generated JSON, editable.** The whole premise of this app is that a
 *    game is data you can edit. Hiding that behind a chat bubble would make the
 *    AI the only way to change a game it authored.
 *  - **Diagnostics from a real playthrough.** The server deals and plays every
 *    draft before answering, so "this plays" is a fact here, not a promise.
 *  - **What the model could not express.** The DSL cannot do everything, and a
 *    draft that quietly simplifies a rule is worse than one that says which
 *    rule it simplified.
 */
export function GameDesigner({
  token,
  onPublished,
}: {
  token: string;
  /** A game reached the catalog — the lobby refreshes its list. */
  onPublished: (gameId: string) => void;
}): JSX.Element | null {
  const [availability, setAvailability] = useState<DesignAvailability | null>(null);
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<DesignSessionSummary[]>([]);
  const [active, setActive] = useState<DesignSessionDetail | null>(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState<null | 'drafting' | 'saving' | 'publishing'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Availability is asked once per mount. A server with no LLM key renders
  // nothing at all rather than a disabled control nobody can explain.
  useEffect(() => {
    let cancelled = false;
    void fetchDesignAvailability().then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The saved-design list is only needed once the panel is open.
  useEffect(() => {
    if (!open) return;
    void listDesignSessions(token)
      .then(setSessions)
      .catch((err: Error) => setError(err.message));
  }, [open, token]);

  const latest = active?.revisions[active.revisions.length - 1] ?? null;

  async function run<T>(kind: NonNullable<typeof busy>, work: () => Promise<T>): Promise<T | null> {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      return await work();
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function startNew(): Promise<void> {
    const text = brief.trim();
    if (!text) return;
    const session = await run('drafting', () => startDesignSession(token, text));
    if (!session) return;
    setActive(session);
    setBrief('');
    setSessions(await listDesignSessions(token).catch(() => sessions));
  }

  async function askForChange(): Promise<void> {
    const text = brief.trim();
    if (!text || !active) return;
    const session = await run('drafting', () => refineDesign(token, active.sessionId, text));
    if (!session) return;
    setActive(session);
    setBrief('');
  }

  async function openSession(sessionId: string): Promise<void> {
    const session = await run('saving', () => fetchDesignSession(token, sessionId));
    if (session) setActive(session);
  }

  async function saveEdits(rules: string, strategy: string): Promise<void> {
    if (!active) return;
    const session = await run('saving', () => saveDesignDraft(token, active.sessionId, rules, strategy));
    if (session) {
      setActive(session);
      setNotice('Your edit was saved as a new revision.');
    }
  }

  async function revertTo(n: number): Promise<void> {
    if (!active) return;
    const session = await run('saving', () => revertDesign(token, active.sessionId, n));
    if (session) {
      setActive(session);
      setNotice(`Revision ${n} is now the current draft.`);
    }
  }

  async function publish(): Promise<void> {
    if (!active) return;
    const result = await run('publishing', () => publishDesign(token, active.sessionId));
    if (!result) return;
    setActive(result.session);
    setNotice(
      active.publishedGameId
        ? 'Your game was updated in the game list.'
        : "Published — it's in your game list now, ready to play.",
    );
    setSessions(await listDesignSessions(token).catch(() => sessions));
    onPublished(result.gameId);
  }

  async function discard(sessionId: string): Promise<void> {
    const ok = await run('saving', async () => {
      await deleteDesignSession(token, sessionId);
      return true;
    });
    if (!ok) return;
    if (active?.sessionId === sessionId) setActive(null);
    setSessions(await listDesignSessions(token).catch(() => sessions));
  }

  // Not configured on this server, or not asked yet.
  if (!availability?.available) return null;

  if (!open) {
    return (
      <button className="import-toggle" onClick={() => setOpen(true)}>
        <span className="import-toggle-icon">✦</span>
        <span>
          <strong>Design a game with AI</strong>
          <small>Describe a card game in your own words — it writes the rules and the AI strategy guide</small>
        </span>
      </button>
    );
  }

  return (
    <div className="panel designer-panel">
      <div className="import-head">
        <h3>{active ? active.title : 'Design a game with AI'}</h3>
        <div className="designer-head-actions">
          {active && (
            <button className="btn btn-ghost" onClick={() => setActive(null)} disabled={busy !== null}>
              All designs
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>

      {error && <pre className="import-error">{error}</pre>}
      {notice && <div className="import-success">{notice}</div>}

      {active ? (
        <>
          <Transcript revisions={active.revisions} onRevert={(n) => void revertTo(n)} busy={busy !== null} />

          {latest && (
            <DraftEditor
              key={`${active.sessionId}:${latest.n}`}
              revision={latest}
              busy={busy}
              onSave={(rules, strategy) => void saveEdits(rules, strategy)}
            />
          )}

          <label className="field">
            <span>Ask for a change</span>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. make it playable with 3 to 6 people, and drop the bidding"
              rows={3}
              disabled={busy !== null}
            />
          </label>

          <div className="designer-actions">
            <button
              className="btn btn-primary"
              disabled={busy !== null || !brief.trim()}
              onClick={() => void askForChange()}
            >
              {busy === 'drafting' ? 'Thinking…' : 'Apply change'}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy !== null || !latest?.diagnostics.valid}
              title={
                latest?.diagnostics.valid
                  ? 'Add this game to your list so you can play it'
                  : 'Fix the problems above first — a game that cannot be played cannot be published'
              }
              onClick={() => void publish()}
            >
              {busy === 'publishing'
                ? 'Publishing…'
                : active.publishedGameId
                  ? 'Update my published game'
                  : 'Publish to my games'}
            </button>
            <button className="btn btn-danger" disabled={busy !== null} onClick={() => void discard(active.sessionId)}>
              Delete design
            </button>
          </div>

          <p className="field-hint">
            {active.publishedGameId
              ? 'Published games live in your game list and are private to you. Deleting this design leaves the game alone.'
              : 'Nothing is added to your game list until you publish.'}{' '}
            Drafted by <code>{availability.model}</code>.
          </p>
        </>
      ) : (
        <>
          <label className="field">
            <span>Describe the game</span>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={
                'e.g. A 4-player partnership game with a 32-card deck. Everyone bids how many tricks they will take, spades are always trump, and you must follow suit. Play 7 hands.'
              }
              rows={5}
              disabled={busy !== null}
            />
            <small className="field-hint">
              Say what makes the game itself: how many players, what deck, whether there is bidding, how trump is
              decided, and how it scores. You can change any of it afterwards.
            </small>
          </label>

          <div className="designer-examples">
            {EXAMPLE_BRIEFS.map((example) => (
              <button
                key={example.label}
                className="designer-example"
                disabled={busy !== null}
                onClick={() => setBrief(example.text)}
              >
                {example.label}
              </button>
            ))}
          </div>

          <button className="btn btn-primary btn-lg" disabled={busy !== null || !brief.trim()} onClick={() => void startNew()}>
            {busy === 'drafting' ? 'Designing your game…' : 'Design it'}
          </button>
          {busy === 'drafting' && (
            <p className="field-hint">
              It writes the rules, then the server deals and plays a real match of them to check they work. This takes
              a few seconds.
            </p>
          )}

          {sessions.length > 0 && (
            <div className="designer-sessions">
              <h4>Your designs</h4>
              {sessions.map((session) => (
                <div key={session.sessionId} className="designer-session-row">
                  <button className="designer-session-hit" onClick={() => void openSession(session.sessionId)}>
                    <span className="designer-session-name">{session.title}</span>
                    <span className="game-row-meta">
                      {session.revisionCount} revision{session.revisionCount === 1 ? '' : 's'}
                      {session.publishedGameId ? ' · published' : ''} · {formatWhen(session.updatedAt)}
                    </span>
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    title={`Delete "${session.title}"`}
                    disabled={busy !== null}
                    onClick={() => void discard(session.sessionId)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The conversation so far, oldest first. Each entry shows what was asked, what
 * the model says it did, and the verdict the engine reached — the three things
 * needed to decide what to ask for next.
 */
function Transcript({
  revisions,
  onRevert,
  busy,
}: {
  revisions: readonly DesignRevision[];
  onRevert: (n: number) => void;
  busy: boolean;
}): JSX.Element {
  const tail = useRef<HTMLDivElement | null>(null);
  const latestN = revisions[revisions.length - 1]?.n;

  // A new revision lands at the bottom of a list that is usually taller than
  // the panel, so scroll it into view — honouring a reduced-motion preference,
  // as the lobby's own panel-opening scroll does.
  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    tail.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  }, [latestN]);

  return (
    <div className="designer-transcript">
      {revisions.map((revision) => {
        const errors = revision.diagnostics.diagnostics.filter((d) => d.severity === 'error');
        const warnings = revision.diagnostics.diagnostics.filter((d) => d.severity === 'warning');
        const isLatest = revision.n === latestN;

        return (
          <div key={revision.n} className={`designer-turn ${isLatest ? 'designer-turn-current' : ''}`}>
            {revision.prompt && <p className="designer-ask">“{revision.prompt}”</p>}

            <div className="designer-turn-head">
              <span className="designer-rev">#{revision.n}</span>
              <span className="designer-summary">{revision.summary}</span>
              {!isLatest && (
                <button className="btn btn-ghost designer-revert" disabled={busy} onClick={() => onRevert(revision.n)}>
                  Go back to this
                </button>
              )}
            </div>

            <div className="designer-badges">
              {revision.diagnostics.valid ? (
                <span className="designer-badge designer-badge-ok">Plays correctly</span>
              ) : (
                <span className="designer-badge designer-badge-bad">
                  {revision.diagnostics.playable ? "Won't publish" : "Doesn't play"}
                </span>
              )}
              {warnings.length > 0 && (
                <span className="designer-badge designer-badge-warn">
                  {warnings.length} thing{warnings.length === 1 ? '' : 's'} to check
                </span>
              )}
              {/* Worth surfacing rather than hiding: it is the honest signal
                  that the first answer was wrong and was corrected. */}
              {revision.repairAttempts > 0 && (
                <span className="designer-badge">
                  fixed after {revision.repairAttempts} retr{revision.repairAttempts === 1 ? 'y' : 'ies'}
                </span>
              )}
            </div>

            {revision.notes.length > 0 && (
              <ul className="designer-notes">
                {revision.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}

            {isLatest && (errors.length > 0 || warnings.length > 0) && (
              <ul className="designer-diagnostics">
                {errors.map((d, i) => (
                  <li key={`e${i}`} className="designer-diag-error">
                    {d.message}
                  </li>
                ))}
                {warnings.map((d, i) => (
                  <li key={`w${i}`} className="designer-diag-warning">
                    {d.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div ref={tail} />
    </div>
  );
}

/**
 * The draft itself, editable.
 *
 * Seeded once per revision (the parent remounts it on a new one via `key`), so
 * an in-progress edit is never overwritten mid-typing by an arriving draft —
 * and a new AI revision always wins over stale editor text, which is the right
 * way round: the author just asked for that change.
 */
function DraftEditor({
  revision,
  busy,
  onSave,
}: {
  revision: DesignRevision;
  busy: string | null;
  onSave: (rules: string, strategy: string) => void;
}): JSX.Element {
  const initialRules = useMemo(() => JSON.stringify(revision.draft.rules, null, 2), [revision]);
  const [tab, setTab] = useState<'rules' | 'strategy'>('rules');
  const [rules, setRules] = useState(initialRules);
  const [strategy, setStrategy] = useState(revision.draft.strategy);

  const dirty = rules !== initialRules || strategy !== revision.draft.strategy;

  return (
    <div className="designer-draft">
      <div className="designer-tabs">
        <button className={tab === 'rules' ? 'designer-tab designer-tab-on' : 'designer-tab'} onClick={() => setTab('rules')}>
          rules.json
        </button>
        <button
          className={tab === 'strategy' ? 'designer-tab designer-tab-on' : 'designer-tab'}
          onClick={() => setTab('strategy')}
        >
          strategy.md
        </button>
        {dirty && <span className="designer-dirty">unsaved edits</span>}
      </div>

      {tab === 'rules' ? (
        <textarea
          className="designer-code"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          spellCheck={false}
          rows={16}
        />
      ) : (
        <textarea
          className="designer-code"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          spellCheck={false}
          rows={16}
        />
      )}

      <div className="designer-draft-foot">
        <small className="field-hint">
          Edit either file directly if it is quicker than describing the change. Saving checks it the same way — the
          server deals and plays a match before accepting it.
        </small>
        <button className="btn" disabled={!dirty || busy !== null} onClick={() => onSave(rules, strategy)}>
          {busy === 'saving' ? 'Checking…' : 'Save my edits'}
        </button>
      </div>
    </div>
  );
}

/**
 * Starting points. Each one is a *complete* brief rather than a topic, because
 * the quality of a first draft tracks the specificity of the description more
 * than anything else — and an author who sees what "specific enough" looks like
 * writes better briefs of their own afterwards.
 */
const EXAMPLE_BRIEFS: readonly { label: string; text: string }[] = [
  {
    label: 'Hearts-style avoidance game',
    text: 'A 4-player game with a standard 52-card deck, no trump, no bidding. Everyone plays for themselves. You must follow suit. Every Heart you capture costs you 1 point and the Queen of Spades costs 13. Hearts cannot be led until one has been played on another suit. Lowest total score after 8 hands wins.',
  },
  {
    label: 'Partnership bidding game',
    text: 'A 4-player partnership game (partners sit opposite) with a 32-card deck of 7 up to Ace. Players bid in an auction for how many tricks their side will take, and the winning bidder names the trump suit. Must follow suit. The bidding side scores its bid if it makes it and loses the same if it does not. Play 6 hands.',
  },
  {
    label: 'Deal-down game for 3–6',
    text: 'A game for 3 to 6 players from a 52-card deck, everyone for themselves. The first hand deals 7 cards each, then 6, then 5, and so on down to 1. Each hand a card is turned up to decide trump. Everyone bids exactly how many tricks they will take, and the last bidder may not make the bids add up to the number of tricks available. You score 10 plus 1 per trick only if you take exactly your bid.',
  },
];

/** "3 minutes ago" / "yesterday" — enough to tell one saved design from another. */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
