import { useId } from 'react';

interface HelpTooltipProps {
  label: string;
  text: string;
}

export function HelpTooltip({ label, text }: HelpTooltipProps) {
  const id = useId();

  return (
    <span className="tooltip-root">
      <button
        aria-describedby={id}
        aria-label={`${label} help`}
        className="tooltip-trigger"
        type="button"
      >
        ?
      </button>
      <span id={id} className="tooltip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}
