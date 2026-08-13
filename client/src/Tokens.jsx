import TokenLibrary from './TokenLibrary.jsx';
import CampaignTokens from './CampaignTokens.jsx';

/**
 * Two different things that both get called "tokens", one above the other.
 *
 * The **library** is artwork: pictures on disk that anyone may put on anything.
 * Everyone at the table can read it - knowing what art exists is not the DM's
 * secret, and a player who has seen it can ask for the right goblin by name
 * instead of describing it.
 *
 * The **campaign's tokens** below it are the pieces this table actually plays
 * with: each belongs to somebody, each is either on a map or waiting to be put
 * on one. Made here, in advance; placed from the map when they're needed.
 *
 * No `onPick` on the library - that prop is what turns the same component into
 * the picker the token forms use.
 */
export default function Tokens({ actor, players, isDm, offline }) {
  return (
    <div className="tokens-view">
      <div className="sheet-toolbar">
        <h2 className="notes-title">Token artwork</h2>
      </div>
      <p className="hint">
        Open a folder to look through it, or search by name across all of them at once.
      </p>
      <TokenLibrary />

      <CampaignTokens actor={actor} players={players} isDm={isDm} offline={offline} />
    </div>
  );
}
