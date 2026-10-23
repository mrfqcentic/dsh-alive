/**
 * Accessible copy for the panel surface.
 *
 * The panel renders no prose: these strings reach only the accessibility tree,
 * as the region name and the control names. A locale bundle can replace them
 * without touching the surface or its CSS.
 */
export const copy = {
  panel: 'Voice panel',
  settings: 'Voice settings',
  history: 'Voice history',
  mute: 'Mute voice',
  unmute: 'Unmute voice',
} as const
