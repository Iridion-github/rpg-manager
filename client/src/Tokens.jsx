import TokenLibrary from './TokenLibrary.jsx';

/**
 * The token library as somewhere to look rather than somewhere to choose.
 *
 * Everyone at the table can read it: knowing what artwork exists is not the
 * DM's secret, and a player who has seen the library can ask for the right
 * goblin by name instead of describing it.
 *
 * No `onPick` — that prop is what turns the same component into the picker the
 * token modals use.
 */
export default function Tokens() {
  return (
    <div className="tokens-view">
      <div className="sheet-toolbar">
        <h2 className="notes-title">Tokens</h2>
      </div>
      <p className="hint">
        Every picture that can be put on a token, as it sits in{' '}
        <code>public/tokens</code>. Open a folder to look through it, or search
        by name across all of them at once.
      </p>
      <TokenLibrary />
    </div>
  );
}
