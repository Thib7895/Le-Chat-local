import { CSSProperties } from 'react';

interface SidebarIconProps {
  className?: string;
  style?: CSSProperties;
}

export function SidebarIcon({ className = '', style }: SidebarIconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <rect
        width="18"
        height="18"
        x="3"
        y="3"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
      <path d="M9 3v18" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
