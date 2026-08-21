import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';

/**
 * "Which part of this picture do you want?" - the step between choosing a file
 * and the picture being saved.
 *
 * Every place the app shows a face has a shape of its own: a square for a
 * profile picture, a tall rectangle for a character portrait. Without this the
 * browser filled that shape with the middle of whatever was uploaded, which is
 * where a head happens to be in about half of all photographs. So the frame is
 * fixed and the picture moves behind it: drag to slide it, zoom to take in more
 * or less of it, and what you can see through the frame is exactly what gets
 * saved.
 *
 * The crop is *baked in*, not remembered as a set of numbers alongside the
 * original. It matters, so it is worth being plain about the trade: nothing can
 * re-crop this later without picking the file again. In exchange, every place
 * that draws this picture - the sheet, the cards, a name in a list - draws the
 * same file and needs to know nothing about how it was framed, and what leaves
 * this dialog is a few hundred kilobytes rather than whatever came off the
 * camera.
 */

/**
 * How big the frame you drag the picture behind may be, in CSS pixels.
 *
 * Worked out here rather than left to the stylesheet, and that is load-bearing:
 * everything below turns a position in that box into a rectangle of the source
 * image, so the box's real size on screen and the number this file does its
 * arithmetic with have to be the same. A width in CSS that a flex row then
 * shrank - which is exactly what a tall frame in a dialog with a ceiling on its
 * height does - would leave the two disagreeing, and the picture that got saved
 * would not be the one that was shown.
 *
 * Both dimensions are capped, because an upright frame is tall: 320 wide is
 * comfortable, and a laptop window is not always 420 tall once the dialog's
 * heading, hint, slider and buttons have had their share.
 */
const MAX_STAGE_W = 320;
const MAX_STAGE_H = 420;
const CHROME_H = 330; // the rest of the dialog, above and below the frame

// How far in you may go, as a multiple of the smallest scale that still fills
// the frame. Past about four the picture is a handful of pixels wide and there
// is nothing left to choose.
const MAX_ZOOM = 4;

// The longest side of what gets saved. A portrait is drawn at a few hundred
// pixels at most, so this is generous - and it is a ceiling rather than a size:
// a small picture is never blown up to meet it.
const MAX_OUT = 1024;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * What to save it as.
 *
 * JPEG for a photograph, which is what a JPEG already was. PNG for everything
 * else, because a PNG or a WEBP may be a drawing with transparent corners and
 * turning those black is not a crop. A GIF loses its animation here either way -
 * a still is all a cropped frame can be.
 */
const outputType = (type) => (type === 'image/jpeg' ? 'image/jpeg' : 'image/png');

/** The largest frame of the wanted shape that this window has room for. */
function fitStage(aspect) {
  const maxW = Math.max(160, Math.min(MAX_STAGE_W, window.innerWidth - 96));
  const maxH = Math.max(160, Math.min(MAX_STAGE_H, window.innerHeight - CHROME_H));
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

export default function CropModal({ file, aspect = 1, title = 'Frame the picture', onCancel, onDone }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  // The frame's size on screen. Fitted to the window rather than fixed, and
  // held in state because every calculation in this file is against it.
  const [stage, setStage] = useState(() => fitStage(aspect));

  const [src, setSrc] = useState('');
  // The loaded picture itself, kept as an element: it is both what the stage
  // draws and what the canvas reads from at the end.
  const image = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Where the picture sits behind the frame. `scale` is CSS pixels per pixel of
  // the source; `at` is the top-left corner of the scaled picture, relative to
  // the frame's own top-left, so both are negative or zero whenever the frame
  // is covered - which the clamping below guarantees it always is.
  const [scale, setScale] = useState(1);
  const [cover, setCover] = useState(1);
  const [at, setAt] = useState({ x: 0, y: 0 });

  const stageRef = useRef(null);
  const drag = useRef(null);

  // An object URL rather than a data URL: no base64 pass over a file that may be
  // several megabytes, and it is released the moment this dialog closes.
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /** Keep the picture over the frame: no scale that leaves a gap, no gaps. */
  const fit = (nextScale, nextAt, img) => {
    const w = img.naturalWidth * nextScale;
    const h = img.naturalHeight * nextScale;
    return {
      x: clamp(nextAt.x, stage.w - w, 0),
      y: clamp(nextAt.y, stage.h - h, 0),
    };
  };

  /**
   * Put the picture where it starts: the smallest scale that still covers the
   * frame, centred. That scale is also the floor - anything less would show the
   * page through a corner.
   */
  const place = (img, box) => {
    const base = Math.max(box.w / img.naturalWidth, box.h / img.naturalHeight);
    setCover(base);
    setScale(base);
    setAt({
      x: (box.w - img.naturalWidth * base) / 2,
      y: (box.h - img.naturalHeight * base) / 2,
    });
  };

  function onLoad(e) {
    const img = e.currentTarget;
    image.current = img;
    place(img, stage);
    setReady(true);
  }

  /**
   * Follow the window.
   *
   * A frame that changed size while a picture was framed inside it would leave
   * every number here describing a box that no longer exists, so the picture is
   * simply placed again - losing a half-finished adjustment, which is a fair
   * price for a resize nobody does mid-crop.
   */
  useEffect(() => {
    const onResize = () => {
      const next = fitStage(aspect);
      setStage((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [aspect]);

  useEffect(() => {
    if (image.current && ready) place(image.current, stage);
    // Only when the box itself moves; `place` reads the picture through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.w, stage.h]);

  /**
   * Zoom about the middle of the frame.
   *
   * Anchored there rather than at the picture's own corner, which is what makes
   * it feel like a lens: the thing you have just centred stays centred instead
   * of sliding off as the picture grows.
   */
  const zoomTo = (next) => {
    const img = image.current;
    if (!img) return;
    const wanted = clamp(next, cover, cover * MAX_ZOOM);
    setAt((prev) => {
      const cx = stage.w / 2;
      const cy = stage.h / 2;
      const moved = {
        x: cx - ((cx - prev.x) * wanted) / scale,
        y: cy - ((cy - prev.y) * wanted) / scale,
      };
      return fit(wanted, moved, img);
    });
    setScale(wanted);
  };

  // Wheel to zoom, attached by hand because it has to say no to the page
  // scrolling underneath, and React's own wheel handler cannot.
  useEffect(() => {
    const box = stageRef.current;
    if (!box || !ready) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomTo(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
    // Deliberately re-attached each render: the handler closes over the current
    // scale, and a listener kept from an earlier one would zoom from a number
    // that has since moved.
  });

  function startDrag(e) {
    if (!ready) return;
    try {
      // So a drag that wanders off the frame - or off the dialog - keeps moving
      // the picture until the button comes up. Guarded because capture is
      // refused for a pointer the browser doesn't consider active, and a
      // refusal there should not cost the drag itself.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Nothing to do: the drag below works either way, it just stops at the
      // edge of the frame.
    }
    drag.current = { x: e.clientX, y: e.clientY };
  }

  function onDrag(e) {
    if (!drag.current || !image.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setAt((prev) => fit(scale, { x: prev.x + dx, y: prev.y + dy }, image.current));
  }

  const endDrag = () => {
    drag.current = null;
  };

  /**
   * Cut out what the frame is showing and hand it back as a file.
   *
   * The frame is a window onto the scaled picture, so dividing everything by the
   * scale turns it back into a rectangle of the original's own pixels - which is
   * what the canvas is asked to copy. Nothing is resampled larger than it was:
   * the output is the crop's own size, capped.
   */
  async function confirm() {
    const img = image.current;
    if (!img || busy) return;
    setBusy(true);
    setError('');
    try {
      const sx = -at.x / scale;
      const sy = -at.y / scale;
      const sw = stage.w / scale;
      const sh = stage.h / scale;

      const outW = Math.max(1, Math.round(Math.min(sw, MAX_OUT)));
      const outH = Math.max(1, Math.round((outW * stage.h) / stage.w));

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      // Smoother than the default when the picture is being shrunk, which it
      // usually is.
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

      const type = outputType(file.type);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
      if (!blob) throw new Error('That picture could not be cropped.');
      const name = `portrait-${Date.now()}.${type === 'image/jpeg' ? 'jpg' : 'png'}`;
      await onDone(new File([blob], name, { type }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  // Into <body>, like the other dialogs: this one is opened from inside the
  // floating sheet window, which is a query container, and containment would
  // otherwise pin a fixed backdrop inside it.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal crop-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="linky" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="hint">
          Drag the picture to move it, and zoom to take in more or less of it. What you can see in
          the frame is what gets saved.
        </p>

        <div
          className="crop-stage"
          ref={stageRef}
          style={{ width: stage.w, height: stage.h }}
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {src && (
            <img
              src={src}
              alt=""
              draggable={false}
              onLoad={onLoad}
              onError={() => setError('That file could not be opened as a picture.')}
              style={{
                // Placed by its own top-left corner and scaled from there, so the
                // numbers on screen are the numbers the crop is worked out from.
                transform: `translate(${at.x}px, ${at.y}px) scale(${scale})`,
                transformOrigin: 'top left',
                visibility: ready ? 'visible' : 'hidden',
              }}
            />
          )}
        </div>

        <label className="crop-zoom">
          Zoom
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={ready ? scale / cover : 1}
            disabled={!ready}
            onChange={(e) => zoomTo(cover * Number(e.target.value))}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={!ready || busy}>
            {busy ? 'Saving…' : 'Use this picture'}
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
