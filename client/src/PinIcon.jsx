/**
 * The pin itself: a teardrop with a hole in it, point downwards.
 *
 * Drawn rather than written for the reason the hidden-token eye is drawn - the
 * emoji that come close (📍, 📌) are a different picture on every second
 * machine, and one of them is a drawing pin seen from the side. This is one
 * path and one circle, it is the same shape at any size, and it takes its
 * colour from whoever placed it.
 *
 * The viewBox is 24 wide and 24 tall with the point at the very bottom centre,
 * which is what lets the map put the tip on the exact pixel somebody clicked by
 * placing the box and nothing more.
 */
export default function PinIcon({ color, className = '' }) {
  return (
    <svg
      className={`pin-icon ${className}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 23.2 5.6 13.4A8.2 8.2 0 1 1 18.4 13.4Z"
        fill={color}
        stroke="rgba(0,0,0,0.55)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.2" r="2.9" fill="rgba(0,0,0,0.45)" />
    </svg>
  );
}
