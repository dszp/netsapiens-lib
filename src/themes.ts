/**
 * Theme registry — the single source of truth for call-flow *appearance*, shared by every host (a
 * viewer SPA, a static gallery, a Worker). A theme bundles a
 * Mermaid node **palette** (fill/stroke/color per node kind), the Mermaid **base + look**, and the
 * surrounding page/app **chrome** (backgrounds, borders, text, accent, brand) as plain data so any
 * renderer can consume it — the viewer injects it into its page, a gallery can map it to CSS.
 *
 * Portable / Node-free (pure data + types). `mermaid.ts` pulls its palettes from here so palettes
 * live in exactly one place. The legacy no-theme Mermaid path is unchanged (the Worker relies on it).
 */

import type { NodeKind } from './model.js';

/** A per-node-kind Mermaid `classDef` body: `fill:..,stroke:..,color:..`. */
export type NodePalette = Record<NodeKind, string>;
export type ThemeMode = 'light' | 'dark';

/** Colors for the surrounding app/page chrome (everything that is NOT the diagram nodes). A host
 *  maps these onto its own surfaces — the viewer binds them to CSS custom properties. */
export interface ThemeChrome {
  bg: string; panel: string; panel2: string; border: string;
  text: string; dim: string; inputBg: string; diagramBg: string;
  itemHover: string; itemActive: string; accent: string; notes: string;
  /** Logo/title color — this is what distinguishes the two portal-match themes (crimson vs blue). */
  brand: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Mermaid built-in base theme this rides on. */
  mermaidBase: 'base' | 'dark';
  /** Mermaid `look` — `neo` (soft, default) or `handDrawn` (sketchy). */
  look: 'neo' | 'handDrawn';
  lineColor: string;
  /** Mermaid `primaryTextColor` (node label text). */
  textColor: string;
  palette: NodePalette;
  chrome: ThemeChrome;
}

// ---- node palettes (same call-flow semantics across palettes; different tints per mode) ----

/** Light tints + dark text (readable on white cards). Used by every light theme. */
export const NODE_LIGHT: NodePalette = {
  did: 'fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f', timeframe: 'fill:#fef3c7,stroke:#d9a441,color:#5c4a1e',
  user: 'fill:#dcfce7,stroke:#4caf7d,color:#14532d', devices: 'fill:#eafaf1,stroke:#3d6b52,color:#1a3d2e',
  queue: 'fill:#ccfbf1,stroke:#14b8a6,color:#134e4a', agents: 'fill:#ede9fe,stroke:#7d6bd9,color:#3730a3',
  attendant: 'fill:#f3e8ff,stroke:#a855f7,color:#581c87', prompt: 'fill:#e0e7ff,stroke:#8a8ad9,color:#312e81',
  voicemail: 'fill:#fee2e2,stroke:#ef4444,color:#7f1d1d', external: 'fill:#ffedd5,stroke:#f97316,color:#7c2d12',
  trunk: 'fill:#f1f5f9,stroke:#94a3b8,color:#334155', hangup: 'fill:#f3f4f6,stroke:#9ca3af,color:#374151',
  unknown: 'fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
};

/** Saturated fills + white text — the original dark palette (Worker legacy path + `dark` theme). */
export const NODE_DARK: NodePalette = {
  did: 'fill:#1e3a5f,stroke:#4a90d9,color:#fff', timeframe: 'fill:#5c4a1e,stroke:#d9a441,color:#fff',
  user: 'fill:#1f3a2e,stroke:#4caf7d,color:#fff', devices: 'fill:#26332c,stroke:#3d6b52,color:#cfe',
  queue: 'fill:#3a1f3a,stroke:#b44ab4,color:#fff', agents: 'fill:#2e2640,stroke:#7d6bd9,color:#fff',
  attendant: 'fill:#3a2a1f,stroke:#d97d4a,color:#fff', prompt: 'fill:#2a2a3a,stroke:#8a8ad9,color:#dde',
  voicemail: 'fill:#3a1f1f,stroke:#d94a4a,color:#fff', external: 'fill:#4a3a1e,stroke:#d9b84a,color:#fff',
  trunk: 'fill:#333,stroke:#999,color:#ddd', hangup: 'fill:#2a2a2a,stroke:#777,color:#bbb',
  unknown: 'fill:#402020,stroke:#c05050,color:#fdd',
};

/** Cooler, desaturated dark — calmer than the neon `NODE_DARK`. */
export const NODE_SLATE: NodePalette = {
  did: 'fill:#243447,stroke:#5b8bc0,color:#e8eef5', timeframe: 'fill:#3d3527,stroke:#c2a15a,color:#f0e9dc',
  user: 'fill:#243a30,stroke:#5aa583,color:#e3f0e9', devices: 'fill:#293430,stroke:#5f8873,color:#dbe9e2',
  queue: 'fill:#2b3540,stroke:#4bb3a6,color:#dcefec', agents: 'fill:#2e2f42,stroke:#8b7fd0,color:#e6e2f4',
  attendant: 'fill:#352c40,stroke:#b07fd0,color:#efe3f5', prompt: 'fill:#2c2f3d,stroke:#8f95c9,color:#e2e5f2',
  voicemail: 'fill:#3d2a2a,stroke:#d07a7a,color:#f5e3e3', external: 'fill:#3d3527,stroke:#cba85f,color:#f0e9dc',
  trunk: 'fill:#2f333a,stroke:#8792a3,color:#dde2e8', hangup: 'fill:#2a2d33,stroke:#7a828e,color:#cfd4db',
  unknown: 'fill:#3d2a2a,stroke:#c56b6b,color:#f5dede',
};

/** Colorblind-safe-ish hues + darkened text for WCAG-AA on-node contrast. */
export const NODE_A11Y: NodePalette = {
  did: 'fill:#cfe3f7,stroke:#0072b2,color:#04243a', timeframe: 'fill:#fbe6c2,stroke:#e69f00,color:#3d2b00',
  user: 'fill:#cdeee3,stroke:#009e73,color:#043226', devices: 'fill:#d8f0f9,stroke:#56b4e9,color:#0a3346',
  queue: 'fill:#f3dcea,stroke:#cc79a7,color:#3d0f2a', agents: 'fill:#dcdcf0,stroke:#3b3b8f,color:#161642',
  attendant: 'fill:#e8dbf5,stroke:#8036c4,color:#2c0f47', prompt: 'fill:#e4e4ee,stroke:#5a5a8a,color:#1c1c33',
  voicemail: 'fill:#f7ddd0,stroke:#d55e00,color:#3d1a00', external: 'fill:#f2e6c0,stroke:#b8860b,color:#3a2c00',
  trunk: 'fill:#e6e9ee,stroke:#556070,color:#1c232e', hangup: 'fill:#e8eaed,stroke:#4a5260,color:#20262e',
  unknown: 'fill:#f7ddd0,stroke:#d55e00,color:#3d1a00',
};

// ---- chrome bases ----
const LIGHT_CHROME: Omit<ThemeChrome, 'accent' | 'brand'> = {
  bg: '#fafafa', panel: '#ffffff', panel2: '#f4f6f8', border: '#e2e8f0', text: '#1e293b', dim: '#64748b',
  inputBg: '#ffffff', diagramBg: '#f8fafc', itemHover: '#eef2f6', itemActive: '#e5edf7', notes: '#b45309',
};
const WHITE_CHROME: Omit<ThemeChrome, 'accent' | 'brand'> = { ...LIGHT_CHROME, bg: '#ffffff', panel2: '#f5f5f5', diagramBg: '#ffffff' };
const DARK_CHROME: Omit<ThemeChrome, 'accent' | 'brand'> = {
  bg: '#141a24', panel: '#1b2230', panel2: '#151b26', border: '#2b3444', text: '#dbe2ea', dim: '#8c99ab',
  inputBg: '#1c2431', diagramBg: '#121821', itemHover: '#1f2836', itemActive: '#233046', notes: '#c9a24a',
};

/**
 * The shipped theme set (viewer picker order). Add a theme here → every host gets it.
 *
 * Deliberately vendor-neutral: no theme here encodes anyone's brand. `ns-portal` matches the stock
 * NetSapiens Manager Portal scheme, which is common to every deployment. To add your own branding,
 * assign into this record at startup — it is a plain, mutable `Record<string, ThemeDef>`:
 *
 *     THEMES['acme'] = { ...THEMES['ns-portal'], id: 'acme', label: 'Acme',
 *                        chrome: { ...THEMES['ns-portal'].chrome, accent: '#b3282d', brand: '#b3282d' } };
 *
 * Keep brand values in your host's config (an env var), not in this library.
 */
export const THEMES: Record<string, ThemeDef> = {
  'light-neo': {
    id: 'light-neo', label: 'Light · Neo', mode: 'light', mermaidBase: 'base', look: 'neo',
    lineColor: '#64748b', textColor: '#1e293b', palette: NODE_LIGHT,
    chrome: { ...LIGHT_CHROME, accent: '#3b82f6', brand: '#1e293b' },
  },
  'ns-portal': {
    id: 'ns-portal', label: 'NetSapiens portal', mode: 'light', mermaidBase: 'base', look: 'neo',
    lineColor: '#8a8a8a', textColor: '#333333', palette: NODE_LIGHT,
    chrome: { ...WHITE_CHROME, accent: '#1a6bb0', brand: '#1a6bb0' },
  },
  'a11y-light': {
    id: 'a11y-light', label: 'Accessible light', mode: 'light', mermaidBase: 'base', look: 'neo',
    lineColor: '#475569', textColor: '#111827', palette: NODE_A11Y,
    chrome: { ...LIGHT_CHROME, text: '#111827', dim: '#4b5563', accent: '#0072b2', brand: '#111827' },
  },
  'sketch-light': {
    id: 'sketch-light', label: 'Hand-drawn', mode: 'light', mermaidBase: 'base', look: 'handDrawn',
    lineColor: '#64748b', textColor: '#1e293b', palette: NODE_LIGHT,
    chrome: { ...LIGHT_CHROME, accent: '#3b82f6', brand: '#1e293b' },
  },
  'slate-dark': {
    id: 'slate-dark', label: 'Slate dark', mode: 'dark', mermaidBase: 'dark', look: 'neo',
    lineColor: '#8c99ab', textColor: '#dbe2ea', palette: NODE_SLATE,
    chrome: { ...DARK_CHROME, accent: '#5b8bc0', brand: '#dbe2ea' },
  },
};

/** System-auto defaults (host picks by `prefers-color-scheme` on first load). */
export const DEFAULT_LIGHT_THEME = 'light-neo';
export const DEFAULT_DARK_THEME = 'slate-dark';
