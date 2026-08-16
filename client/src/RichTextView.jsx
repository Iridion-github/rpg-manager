import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { emptyDoc, richTextExtensions } from './richText.js';

/**
 * A rich-text document, read rather than written.
 *
 * The same editor the writer uses, with the typing switched off - not a second
 * renderer that draws documents its own way. Two of those would eventually
 * disagree, and the disagreement would show up as a pin that looked one way to
 * the person who wrote it and another way to everybody else.
 *
 * There is no HTML anywhere in this: the document is a tree of named nodes and
 * the editor builds the DOM from the nodes it knows about. That is what makes
 * it safe to draw a document somebody else at the table wrote.
 */
export default function RichTextView({ doc }) {
  const editor = useEditor({
    editable: false,
    extensions: richTextExtensions({ readOnly: true }),
    content: doc || emptyDoc(),
  });

  // A pin can be edited by its author while somebody else is reading it, and
  // the new text arrives over the socket into a card already on screen. Compared
  // rather than set unconditionally, because setContent rebuilds the document
  // and would do it on every render of the window around it.
  useEffect(() => {
    if (!editor) return;
    const next = doc || emptyDoc();
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(next)) return;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, doc]);

  return <EditorContent editor={editor} className="rich-text rich-text-read" />;
}
