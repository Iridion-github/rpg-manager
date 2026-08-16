// The one description of what a rich-text document in this app may contain.
//
// Both ends read it: the editor that writes a pin and the card that reads one
// back, so a document can never be written in a shape the reader does not draw.
// The server keeps a third copy of the same list (sanitizeDoc in
// routes/scenes.js) and rebuilds every document against it - that one is the
// one that matters, since a browser can send whatever it likes. If a node is
// added here it has to be added there too, or it will be written, sent, and
// quietly dropped on arrival.
//
// What is stored is ProseMirror's JSON rather than HTML, and that is the whole
// of the safety argument: nothing here ever hands a string to the browser to
// parse. A document is a tree of named nodes, the reader draws the nodes it
// knows, and a `<script>` somebody pasted in is not one of them.

import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';

/**
 * The extensions, in the two arrangements they are wanted in.
 *
 * `openOnClick` is the only difference: in a document being read, a link is for
 * following, and in one being written it is for putting the caret in the middle
 * of. Everything else is shared, because a document that looked one way while
 * being typed and another way afterwards would be a document nobody could lay
 * out.
 */
export function richTextExtensions({ readOnly = false } = {}) {
  return [
    StarterKit.configure({
      // Three levels is what a note stuck in a map needs. Six would be a
      // document with an outline, and this is a pin.
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: readOnly,
        autolink: true,
        // Typing bare `example.com` means the web, not a file on this server.
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: {
          // A pin's links go somewhere else, and take nothing with them: this
          // page is the game everybody is in the middle of, and it is not to be
          // navigated away from or handed to whatever was linked.
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      },
    }),
    Image.configure({
      // Its own block, the way a picture in a handout is. Inline images inside
      // a sentence are a layout problem in a panel this narrow.
      inline: false,
      // Pictures are uploaded and referred to by address. A data URL would put
      // the whole file in the scene record, where it would be sent to everybody
      // at the table on every change to that map.
      allowBase64: false,
    }),
  ];
}

/** What a pin with nothing written in it holds. Matches the server's own. */
export const emptyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });
