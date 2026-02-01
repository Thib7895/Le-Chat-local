import { CSSProperties } from 'react';

interface SendArrowIconProps {
  className?: string;
  style?: CSSProperties;
}

export function SendArrowIcon({ className = '', style }: SendArrowIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={{ transform: 'rotate(-90deg)', ...style }}
    >
      <path
        fill="currentColor"
        d="M12 18v4h4v-4h-4ZM16 14v4h4v-4h-4ZM20 10v4h4v-4h-4ZM16 6v4h4V6h-4ZM12 2v4h4V2h-4ZM12 10v4h4v-4h-4ZM8 10v4h4v-4H8ZM4 10v4h4v-4H4ZM0 10v4h4v-4H0Z"
      />
    </svg>
  );
}
