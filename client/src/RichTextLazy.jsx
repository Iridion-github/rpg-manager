import { Suspense, lazy } from 'react';

/**
 * The rich-text pair, fetched only when something actually needs them.
 *
 * The editor and its document model are the largest thing in this app by a
 * distance - they are a whole text engine - and most evenings at most tables
 * nobody opens a pin at all. Loaded eagerly they doubled what every player
 * downloads before the map appears, which is a poor trade for a feature that
 * is used now and then.
 *
 * So both go behind a dynamic import, and the fallback is a line of text rather
 * than a spinner: this arrives in a moment on any connection that has already
 * fetched the app, and a spinner for a moment is more distracting than a word.
 */

const Editor = lazy(() => import('./RichTextEditor.jsx'));
const View = lazy(() => import('./RichTextView.jsx'));

export function RichTextEditor(props) {
  return (
    <Suspense fallback={<p className="hint">Fetching the editor…</p>}>
      <Editor {...props} />
    </Suspense>
  );
}

export function RichTextView(props) {
  return (
    <Suspense fallback={<p className="hint">Reading…</p>}>
      <View {...props} />
    </Suspense>
  );
}
