/**
 * A small, original loading mark: three dots on a ring that slowly rotates
 * while each dot breathes in and out of view, staggered so they never dim
 * in sync — that stagger is what reads as "orbiting" rather than a plain
 * spinner. Used for per-file upload/OCR progress in the attachment list,
 * where a standalone status word reads as stuck rather than active.
 *
 * `motion-reduce:` (Tailwind's variant for prefers-reduced-motion) drops
 * both animations: the three dots just sit there, fully visible, static.
 */
export default function Loader({ className = "" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`relative inline-block h-3.5 w-3.5 shrink-0 motion-safe:[animation:loader-ring-spin_1.6s_linear_infinite] ${className}`}
    >
      {[0, 1, 2].map((i) => (
        // Two nested elements because the ring's rotation and this dot's
        // own breathing both animate `transform` — one element's keyframe
        // would overwrite the other's if they shared it. The outer span
        // positions the dot on the ring (a static transform); only the
        // inner one's transform is what the breathe animation touches.
        <span
          key={i}
          className="absolute top-1/2 left-1/2 h-[3px] w-[3px]"
          style={{ transform: `rotate(${i * 120}deg) translate(5.5px, 0)` }}
        >
          <span
            className="block h-full w-full rounded-full bg-secondary motion-safe:[animation:loader-dot-breathe_1.6s_ease-in-out_infinite]"
            style={{ animationDelay: `${i * -0.53}s` }}
          />
        </span>
      ))}
    </span>
  );
}
