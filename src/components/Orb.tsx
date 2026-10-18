/**
 * The thinking/activity mark used everywhere something is in progress:
 * uploads, OCR, search, and the model's own reasoning/writing phases.
 * Replaces Loader.tsx's three-dot ring.
 *
 * 30px: a soft cream glow, a bright core that breathes, and a translucent
 * ring that orbits (and, riding the same rotation, rotates) around it.
 * Transform + opacity only — no JS animation loop; `motion-safe:` (Tailwind's
 * prefers-reduced-motion variant) is what makes it static otherwise.
 */
export default function Orb({ fast = false, className = "" }: { fast?: boolean; className?: string }) {
  const duration = fast ? "1.4s" : "2.6s";

  return (
    <span
      role="status"
      aria-label="Working"
      className={`relative inline-block h-[30px] w-[30px] shrink-0 ${className}`}
    >
      {/* Soft glow, static. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-cream opacity-20 blur-[6px]"
      />
      {/* Bright breathing core. */}
      <span
        aria-hidden
        className="absolute inset-[9px] rounded-full bg-[#fbfaf7] motion-safe:[animation-name:orb-breathe] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]"
        style={{ animationDuration: duration }}
      />
      {/* Orbiting + rotating translucent ring. */}
      <span
        aria-hidden
        className="absolute inset-0 motion-safe:[animation-name:orb-orbit] motion-safe:[animation-timing-function:linear] motion-safe:[animation-iteration-count:infinite]"
        style={{ animationDuration: duration }}
      >
        <span className="absolute top-0 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-cream/60 bg-cream/15" />
      </span>
    </span>
  );
}
