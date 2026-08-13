import { useEffect, useRef, useState } from 'react';
import { imageFromClipboard } from './clipboardImage.js';

// How long a complaint stays up. It is about one press of one button, and a
// message that outlives what it was about is a message about nothing.
const ERROR_MS = 6000;

/**
 * "Use clipboard": the picture you already copied, without saving it first.
 *
 * Sits beside every Upload the app offers, and hands its caller exactly what
 * the file input beside it hands over - a File - so nothing downstream has to
 * know where the image came from.
 *
 * It keeps its own error rather than pushing one up to the form. What went
 * wrong here is about this button and is fixed by pressing it again, which is
 * not the same kind of thing as an upload failing halfway; putting it in the
 * form's own error line would leave "Invalid clipboard content" sitting over a
 * dialog whose actual problem is elsewhere.
 */
export default function ClipboardImage({ onImage, disabled, label = 'Use clipboard' }) {
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function use() {
    if (reading) return;
    clearTimeout(timer.current);
    setError('');
    setReading(true);
    const { file, error: why } = await imageFromClipboard();
    setReading(false);
    if (file) {
      onImage(file);
      return;
    }
    setError(why);
    timer.current = setTimeout(() => setError(''), ERROR_MS);
  }

  return (
    <span className="clipboard-pick">
      <button
        type="button"
        onClick={use}
        disabled={disabled || reading}
        title="Use an image you have copied"
      >
        {reading ? 'Reading…' : label}
      </button>
      {error && <small className="clipboard-error">{error}</small>}
    </span>
  );
}
