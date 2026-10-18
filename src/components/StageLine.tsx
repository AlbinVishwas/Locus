import Orb from "./Orb";

interface StageLineProps {
  label: string;
  /** "active": orb + sweeping text. "finished": a plain grey line with a check. */
  state: "active" | "finished";
  /** Faster orb loop (~1.4s vs ~2.6s) — for Searching and Writing. */
  fast?: boolean;
  className?: string;
}

/**
 * One line of live progress, shared by the upload/OCR chips and the chat
 * turn's own reasoning/writing stages: an orb and a light-sweeping label
 * while a stage is active, collapsing to a static grey line with a check
 * once it's done. `prefers-reduced-motion` drops both animations (see
 * Orb.tsx and the .stage-sweep-text rule in globals.css); the content and
 * meaning are identical either way.
 */
export default function StageLine({ label, state, fast = false, className = "" }: StageLineProps) {
  if (state === "finished") {
    return (
      <span className={`flex items-center gap-1.5 text-secondary ${className}`}>
        <CheckIcon />
        <span>{label}</span>
      </span>
    );
  }

  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <Orb fast={fast} />
      <span className="stage-sweep-text motion-safe:[animation-name:stage-sweep] motion-safe:[animation-timing-function:linear] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-duration:1.9s]">
        {label}
      </span>
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
