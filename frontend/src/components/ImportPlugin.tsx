import { useRef, useState, type ChangeEvent } from 'react';
import { importPlugin, updatePlugin, PluginProtectedError, type PluginSource } from '../api';

/**
 * Adds a new game to the server at runtime, or edits one you already own, by
 * uploading/pasting `rules.json` and `strategy.md`. This is the client-side
 * half of the PRD's plugin promise: a new game — or a change to one — requires
 * no code change on either side of the stack.
 *
 * Three modes, which differ only in what the primary button does:
 *  - **Import** (no `editing`): POST, creating a new game under a server-assigned id.
 *  - **Edit** (`editing` is one of yours, `intent: 'edit'`): PUT, replacing
 *    content and keeping the id.
 *  - **Copy** (`intent: 'copy'`, or any built-in): POST, so the pre-filled
 *    original stays exactly as it was and your changes land in a new, private
 *    game. A built-in is always this mode — the shipped catalog is read-only —
 *    and one of your own plugins can be copied too, which is how you keep a
 *    working version while experimenting with a variant.
 */
export function ImportPlugin({
  token,
  onImported,
  editing,
  intent = 'edit',
  onDoneEditing,
}: {
  token: string;
  onImported: (gameId: string) => void;
  /** When set, the panel opens pre-filled with this plugin instead of blank. */
  editing?: PluginSource | null;
  /** What the pre-filled panel saves as. Ignored for a built-in, which can only be copied. */
  intent?: 'edit' | 'copy';
  onDoneEditing?: () => void;
}): JSX.Element {
  const isEdit = Boolean(editing);
  // A built-in can be opened and read, but never saved back over, so it forces
  // copy mode regardless of which button was clicked.
  const isCopy = isEdit && (intent === 'copy' || editing?.builtIn === true);
  const originalName = editing ? pluginName(editing) : '';
  const [open, setOpen] = useState(isEdit);
  const [rules, setRules] = useState(editing ? JSON.stringify(isCopy ? withCopiedName(editing.rules) : editing.rules, null, 2) : '');
  const [strategy, setStrategy] = useState(editing?.strategy ?? '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rulesFileRef = useRef<HTMLInputElement>(null);
  const strategyFileRef = useRef<HTMLInputElement>(null);

  function readFileInto(e: ChangeEvent<HTMLInputElement>, setter: (text: string) => void): void {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setter(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  function close(): void {
    setOpen(false);
    setError(null);
    setSuccess(null);
    if (isEdit) onDoneEditing?.();
    else {
      setRules('');
      setStrategy('');
    }
  }

  async function submit(): Promise<void> {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      // Only an edit of a plugin the user owns is an update in place;
      // everything else — a fresh import, or a copy of anything — creates a
      // new game and leaves what it was copied from alone.
      const game =
        isEdit && !isCopy
          ? await updatePlugin(token, editing!.gameId, rules, strategy)
          : await importPlugin(token, rules, strategy);

      setSuccess(
        isEdit && !isCopy
          ? `"${game.displayName}" updated.`
          : isCopy
            ? `"${game.displayName}" saved as a separate game — the original is unchanged.`
            : `"${game.displayName}" imported — it's now in the game list.`,
      );
      if (!isEdit) {
        setRules('');
        setStrategy('');
        if (rulesFileRef.current) rulesFileRef.current.value = '';
        if (strategyFileRef.current) strategyFileRef.current.value = '';
      }
      onImported(game.gameId);
    } catch (err) {
      if (err instanceof PluginProtectedError) {
        setError(
          `"${originalName || err.gameId}" is a built-in game and cannot be changed. Close this and use "Import a game plugin" to save your version as a separate game.`,
        );
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="import-toggle" onClick={() => setOpen(true)}>
        <span className="import-toggle-icon">＋</span>
        <span>
          <strong>Import a game plugin</strong>
          <small>Add a new game from a rules.json + strategy.md — no code changes needed</small>
        </span>
      </button>
    );
  }

  const heading = isCopy
    ? `Make your own copy of "${originalName}"`
    : isEdit
      ? `Edit "${originalName}"`
      : 'Import a game plugin';

  return (
    <div className="panel import-panel">
      <div className="import-head">
        <h3>{heading}</h3>
        <button className="btn btn-ghost" onClick={close}>
          Close
        </button>
      </div>

      {isCopy && (
        <div className="import-notice">
          {editing!.builtIn
            ? `"${originalName}" is a built-in game and can't be changed. These rules are loaded as a starting point — saving creates a new, private game of your own and leaves the built-in exactly as it is.`
            : 'These rules are loaded as a starting point. Saving creates a second, independent game — the one you copied stays exactly as it is, so you can experiment without losing a version that works.'}
        </div>
      )}

      <div className="import-grid">
        <label className="field">
          <span>rules.json</span>
          <input ref={rulesFileRef} type="file" accept=".json,application/json" onChange={(e) => readFileInto(e, setRules)} />
          <textarea
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder={'{\n  "displayName": "Spades",\n  "version": "1.0.0",\n  ...\n}'}
            spellCheck={false}
            rows={12}
          />
        </label>

        <label className="field">
          <span>strategy.md</span>
          <input ref={strategyFileRef} type="file" accept=".md,text/markdown" onChange={(e) => readFileInto(e, setStrategy)} />
          <textarea
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            placeholder={'# Spades — Strategic Guide\n\nGuidance injected into the AI system prompt…'}
            spellCheck={false}
            rows={12}
          />
        </label>
      </div>

      {!isEdit && (
        <p className="field-hint">
          Don't put a <code>gameId</code> in rules.json — the server assigns one. Name the game with{' '}
          <code>displayName</code>. Importing the same file twice creates two separate games; to change a game you
          already added, edit it from its card instead.
        </p>
      )}

      {error && <pre className="import-error">{error}</pre>}
      {success && <div className="import-success">{success}</div>}

      <button
        className="btn btn-primary"
        disabled={busy || !rules.trim() || !strategy.trim()}
        onClick={() => void submit()}
      >
        {busy ? 'Saving…' : isCopy ? 'Save as my own copy' : isEdit ? 'Save changes' : 'Import plugin'}
      </button>
    </div>
  );
}

/**
 * What to call this plugin in the panel's own copy. Ids are minted by the
 * server — a 24-character hex `ObjectId` for anything imported — so putting one
 * in a heading shows the player a database key and calls it a game. The name
 * they know it by is in the rules they are about to edit; the id is only a
 * fallback for content with no usable name at all.
 */
function pluginName(source: PluginSource): string {
  const rules = source.rules;
  if (typeof rules === 'object' && rules !== null) {
    const { displayName } = rules as { displayName?: unknown };
    if (typeof displayName === 'string' && displayName.trim() !== '') return displayName;
  }
  return source.gameId;
}

/**
 * Pre-names a copy so the list doesn't end up with two identically-titled
 * games. It's a suggestion, not a rule — the name sits in the textarea above
 * the save button, ready to be changed. Anything that isn't a rules object
 * with a name is passed through untouched rather than guessed at.
 */
function withCopiedName(rules: unknown): unknown {
  if (typeof rules !== 'object' || rules === null) return rules;
  const named = rules as { displayName?: unknown };
  if (typeof named.displayName !== 'string' || named.displayName.trim() === '') return rules;
  return { ...rules, displayName: `${named.displayName} (copy)` };
}
