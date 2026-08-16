import { useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { api } from './api.js';
import ClipboardImage from './ClipboardImage.jsx';
import { emptyDoc, richTextExtensions } from './richText.js';

/**
 * A small rich-text box: what goes inside a pin.
 *
 * Rich rather than plain because of what people actually put in one - a name in
 * bold, a list of what the room holds, the address of the map somebody drew, a
 * photograph of the letter the party found. A textarea can hold the words and
 * none of the rest.
 *
 * What it produces is ProseMirror's JSON, which is what is stored and what is
 * sent. See richText.js for why that rather than HTML.
 *
 * Uncontrolled on purpose. The document is handed over once, as the starting
 * content, and every change is reported upwards; feeding the caller's copy back
 * in on each render would rebuild the document under the caret and put it back
 * at the start of the box on every keystroke.
 */

/**
 * The most a picture in a pin may weigh, and which door it goes through.
 *
 * The portrait door rather than the map one, at five megabytes rather than
 * twenty: this is a picture inside a note, and a twenty-megabyte photograph
 * pasted into one would be carried to every person the pin is shared with.
 * Checked here as well as on the server so an enormous file is refused in the
 * instant it is picked. See MAX_BYTES in server/imageStore.js.
 */
const MAX_MB = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

// Which of the two side rows is open under the toolbar, if either. One piece of
// state rather than two flags: they occupy the same strip, and both being open
// at once is a state nobody wants to lay out.
const NO_ROW = '';

/**
 * One button on the toolbar, lit when what it does is what the caret is inside.
 *
 * Out here rather than inside the editor, where it would be a different
 * component on every render and would therefore be torn down and rebuilt with
 * every keystroke somebody typed.
 */
function ToolButton({ on, title, label, disabled, onClick }) {
  return (
    <button
      type="button"
      className={`rt-button${on ? ' on' : ''}`}
      aria-pressed={Boolean(on)}
      aria-label={title}
      title={title}
      disabled={disabled}
      // The press must not take the caret out of the document: a mark applied
      // to nothing is a mark applied to nowhere.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function RichTextEditor({ value, onChange, disabled = false }) {
  const [row, setRow] = useState(NO_ROW);
  const [href, setHref] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const editor = useEditor({
    extensions: richTextExtensions(),
    content: value || emptyDoc(),
    editable: !disabled,
    onUpdate: ({ editor: ed }) => onChange(ed.getJSON()),
    editorProps: {
      attributes: {
        class: 'rich-text rich-text-input',
      },
    },
  });

  /**
   * What the toolbar has to know about where the caret is.
   *
   * Read through useEditorState rather than by asking the editor during render:
   * an editor does not re-render its React surroundings on every keystroke any
   * more, so a button that read `editor.isActive('bold')` directly would light
   * up a beat late and stay lit a beat too long.
   */
  const marks = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
          bold: ed.isActive('bold'),
          italic: ed.isActive('italic'),
          underline: ed.isActive('underline'),
          strike: ed.isActive('strike'),
          code: ed.isActive('code'),
          h1: ed.isActive('heading', { level: 1 }),
          h2: ed.isActive('heading', { level: 2 }),
          bullet: ed.isActive('bulletList'),
          ordered: ed.isActive('orderedList'),
          quote: ed.isActive('blockquote'),
          link: ed.isActive('link'),
        }
        : {},
  });

  if (!editor) return null;

  const run = (fn) => () => fn(editor.chain().focus()).run();

  /** Open the link row, holding whatever the caret is already sitting inside. */
  function openLinkRow() {
    setError('');
    setHref(editor.getAttributes('link').href || '');
    setRow((open) => (open === 'link' ? NO_ROW : 'link'));
  }

  function applyLink() {
    const url = href.trim();
    if (!url) return;
    // The whole link, not the two letters the caret happens to be between:
    // somebody fixing an address has not selected the words it is attached to.
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setRow(NO_ROW);
  }

  function dropLink() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setRow(NO_ROW);
  }

  function insertImage(src) {
    if (!src) return;
    editor.chain().focus().setImage({ src }).run();
    setImageUrl('');
    setRow(NO_ROW);
  }

  /** A file off the disk, or one out of the clipboard: the same act either way. */
  async function uploadImage(file) {
    if (!file || busy) return;
    setError('');
    if (file.size > MAX_BYTES) {
      setError(`That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_MB} MB.`);
      return;
    }
    setBusy(true);
    try {
      const { url } = await api.uploadImage(file, 'portrait');
      insertImage(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      // Without this, picking the same file again after a failure is silent:
      // its value never changed.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className={`rich-editor${disabled ? ' disabled' : ''}`}>
      <div className="rich-toolbar" role="toolbar" aria-label="Formatting">
        <ToolButton disabled={disabled} on={marks.bold} title="Bold" label={<strong>B</strong>}
          onClick={run((c) => c.toggleBold())} />
        <ToolButton disabled={disabled} on={marks.italic} title="Italic" label={<em>I</em>}
          onClick={run((c) => c.toggleItalic())} />
        <ToolButton disabled={disabled} on={marks.underline} title="Underline" label={<u>U</u>}
          onClick={run((c) => c.toggleUnderline())} />
        <ToolButton disabled={disabled} on={marks.strike} title="Strikethrough" label={<s>S</s>}
          onClick={run((c) => c.toggleStrike())} />
        <span className="rt-sep" />
        <ToolButton disabled={disabled} on={marks.h1} title="Heading" label="H1"
          onClick={run((c) => c.toggleHeading({ level: 1 }))} />
        <ToolButton disabled={disabled} on={marks.h2} title="Smaller heading" label="H2"
          onClick={run((c) => c.toggleHeading({ level: 2 }))} />
        <span className="rt-sep" />
        <ToolButton disabled={disabled} on={marks.bullet} title="Bulleted list" label="•"
          onClick={run((c) => c.toggleBulletList())} />
        <ToolButton disabled={disabled} on={marks.ordered} title="Numbered list" label="1."
          onClick={run((c) => c.toggleOrderedList())} />
        <ToolButton disabled={disabled} on={marks.quote} title="Quote" label="❝"
          onClick={run((c) => c.toggleBlockquote())} />
        <ToolButton disabled={disabled} on={marks.code} title="Code" label="‹›"
          onClick={run((c) => c.toggleCode())} />
        <ToolButton disabled={disabled} title="Divider" label="―"
          onClick={run((c) => c.setHorizontalRule())} />
        <span className="rt-sep" />
        <ToolButton disabled={disabled} on={marks.link || row === 'link'} title="Link" label="🔗"
          onClick={openLinkRow} />
        <ToolButton
          disabled={disabled}
          on={row === 'image'}
          title="Picture"
          label="🖼"
          onClick={() => {
            setError('');
            setRow((open) => (open === 'image' ? NO_ROW : 'image'));
          }}
        />
      </div>

      {/* Both rows sit under the toolbar rather than in a dialog over it: what
          they are about is the spot the caret is in, and a dialog that covers
          the document hides the very thing being pointed at. */}
      {row === 'link' && (
        <div className="rich-row">
          <input
            type="url"
            value={href}
            autoFocus
            placeholder="https://…"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <button type="button" onClick={applyLink} disabled={!href.trim()}>
            Apply
          </button>
          {marks.link && (
            <button type="button" className="linky" onClick={dropLink}>
              Remove link
            </button>
          )}
        </div>
      )}

      {row === 'image' && (
        <div className="rich-row rich-row-image">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => uploadImage(e.target.files?.[0])}
          />
          {/* The same act by another road, as everywhere else pictures are
              accepted: one you have copied has nowhere on disk to be picked
              from, and saving it out to pick it up again is a step for the
              sake of one. */}
          <ClipboardImage onImage={uploadImage} disabled={busy} />
          <span className="rich-row-url">
            <input
              type="url"
              value={imageUrl}
              placeholder="…or paste a picture's address"
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  insertImage(imageUrl.trim());
                }
              }}
            />
            <button type="button" onClick={() => insertImage(imageUrl.trim())} disabled={!imageUrl.trim()}>
              Add
            </button>
          </span>
          {busy && <small>Uploading…</small>}
          <small className="picture-limit">PNG, JPEG, WEBP or GIF, up to {MAX_MB} MB.</small>
        </div>
      )}

      {error && <small className="clipboard-error">{error}</small>}

      <EditorContent editor={editor} />
    </div>
  );
}
