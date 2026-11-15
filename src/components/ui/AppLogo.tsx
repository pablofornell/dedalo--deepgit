/** DeepGit mark (the small variant of `src-tauri/icons/logo-small.svg`), coloured with the theme tokens. Data: `features/welcome/logoData.ts`. */
import { For, type JSX } from "solid-js";
import { LOGO_EDGES, LOGO_NODES } from "../../features/welcome/logoData";

export interface AppLogoProps {
  /** Width and height in px (default 48). */
  size?: number;
  /** For small sizes. Only the small variant exists for now, so this changes nothing yet. */
  small?: boolean;
}

export function AppLogo(props: AppLogoProps): JSX.Element {
  const size = () => props.size ?? 48;
  return (
    <svg width={size()} height={size()} viewBox="0 0 1024 1024" aria-hidden="true" style={{ display: "block", "flex-shrink": 0 }}>
      <rect width="1024" height="1024" rx="224" ry="224" style={{ fill: "var(--dg-island-bg)" }} />
      <g fill="none" stroke-linecap="round">
        <For each={LOGO_EDGES}>
          {([d, width, colour]) => <path d={d} stroke-width={width} stroke="currentColor" style={{ color: `var(--dg-${colour})` }} />}
        </For>
      </g>
      <g style={{ stroke: "var(--dg-island-bg)" }}>
        <For each={LOGO_NODES}>
          {([x, y, r, outline, colour]) => <circle cx={x} cy={y} r={r} stroke-width={outline} fill="currentColor" style={{ color: `var(--dg-${colour})` }} />}
        </For>
      </g>
    </svg>
  );
}
