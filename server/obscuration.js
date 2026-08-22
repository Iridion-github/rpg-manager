'use strict';

/**
 * Obscuration: the parts of a map the DM has covered over.
 *
 * Two layers of shapes rather than one. The **obscuring** ones black out what
 * they cover; the **clearing** ones cut back through them. Where the two
 * overlap, clear wins - not by undoing the obscuring shape, which stays exactly
 * as it was drawn, but by winning the argument in the overlap. That is what
 * lets a DM black out a whole wing of a dungeon and then cut a corridor
 * through it, rather than having to draw the black in pieces around the gap.
 *
 * ## How this differs from fog
 *
 * Fog is worked out from where creatures are standing and changes as they move.
 * This is drawn by hand and changes only when the DM redraws it: it is scenery
 * about the *map*, not about anybody's eyes. The two are independent and both
 * apply - a room can be outside everyone's sight and blacked out as well.
 *
 * ## What the players are sent
 *
 * Nothing at all until it is applied. The shapes live on the scene from the
 * moment they are drawn, because a DM who blacks out three rooms and goes to
 * make tea should find them on their return - but a player who could read them
 * off the wire before `on` was set would be reading the DM's plans for the
 * evening. `forPlayers` is the one function that decides this, and every path
 * that sends a scene to somebody goes through it.
 */

const SHAPE_KINDS = new Set(['rect', 'circle', 'cone', 'line', 'poly']);

// The same ceilings the drawn layer answers to, and for the same reason: a
// scene is one record, read and broadcast whole.
const MAX_SHAPES = 200;
const MAX_POINTS = 200;

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cells = (value, fallback, lo = 0.1, hi = 200) => clamp(num(value, fallback), lo, hi);

function points(value, existing) {
  const source = Array.isArray(value) ? value : existing;
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_POINTS).map((p) => ({
    x: clamp(num(p?.x, 0), -500, 500),
    y: clamp(num(p?.y, 0), -500, 500),
  }));
}

/**
 * One shape, in the same cells everything else on a scene is stored in.
 *
 * No colours: what an obscuration shape looks like is decided by `clear` and
 * nothing else, so a fill sent from a browser would be a colour nobody chose
 * and everybody had to agree about. Black and white are what the two states
 * mean, and they are applied where the thing is drawn.
 */
function shape(raw = {}, existing = {}) {
  const kind = SHAPE_KINDS.has(raw.kind) ? raw.kind : existing.kind || 'rect';
  return {
    id: String(raw.id || existing.id || '').slice(0, 64),
    kind,
    clear: raw.clear === true,
    x: clamp(num(raw.x, existing.x ?? 0), -500, 500),
    y: clamp(num(raw.y, existing.y ?? 0), -500, 500),
    w: cells(raw.w, existing.w ?? 1),
    h: cells(raw.h, existing.h ?? 1),
    r: cells(raw.r, existing.r ?? 1),
    dir: ((num(raw.dir, existing.dir ?? 0) % 360) + 360) % 360,
    angle: clamp(num(raw.angle, existing.angle ?? 53), 5, 360),
    thickness: cells(raw.thickness, existing.thickness ?? 1, 0.1, 20),
    ...(kind === 'poly' ? { points: points(raw.points, existing.points) } : {}),
  };
}

const crypto = require('node:crypto');

function sanitizeObscuration(body = {}, current = {}) {
  const existing = current.obscuration || {};
  const byId = new Map((existing.shapes || []).map((s) => [s.id, s]));
  const raw = Array.isArray(body.shapes) ? body.shapes : existing.shapes || [];
  return {
    // Absent means off, which is what every scene drawn before this existed
    // should read as: shapes nobody has applied are shapes nobody sees.
    on: body.on === true,
    /**
     * How solid the black looks *to the DM* while they work.
     *
     * Never sent to a player and never used to draw their view: what they get
     * is opaque, because the point of the thing is that it hides the map. This
     * is the DM's own window onto what they are covering, so that a shape can
     * be placed over a corridor the DM can still see.
     */
    opacity: clamp(Math.round(num(body.opacity, existing.opacity ?? 60)), 5, 100),
    shapes: raw.slice(0, MAX_SHAPES).map((s) => {
      const was = byId.get(s?.id);
      const kept = shape(s, was);
      return kept.id ? kept : { ...kept, id: crypto.randomUUID() };
    }),
  };
}

/** Whether the players' view is covered at all. */
const obscurationOn = (scene) => scene?.obscuration?.on === true;

/**
 * The obscuration as a given role may see it.
 *
 * The DM gets it whole - it is theirs, and they are drawing it. Everybody else
 * gets the shapes only once it has been applied, and never the working opacity,
 * which is not a fact about their view.
 */
function forPlayers(obscuration) {
  if (!obscuration?.on) return { on: false, shapes: [] };
  return { on: true, shapes: obscuration.shapes || [] };
}

module.exports = { sanitizeObscuration, obscurationOn, forPlayers };
