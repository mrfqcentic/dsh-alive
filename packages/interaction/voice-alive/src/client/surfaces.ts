/**
 * Surface registry for the panel document.
 *
 * The panel document serves three surfaces distinguished by the `surface`
 * query parameter. `panel` is the default so the plain panel URL keeps working,
 * and an unknown value falls back to it instead of failing the document. Each
 * surface component owns one file; adding or replacing a surface changes its
 * component, never this registry.
 * @module @deepseek-ai/dsh-voice-alive/client/surfaces
 */
import type { ComponentType } from 'react'
import { HistorySurface } from './surfaces/history.tsx'
import { PanelSurface } from './surfaces/panel.tsx'
import { SettingsSurface } from './surfaces/settings.tsx'

/** Query parameter that selects the surface to render. */
export const SURFACE_PARAMETER = 'surface'

/** Every surface the panel document can render; the first entry is the default. */
export const SURFACE_IDS = ['panel', 'settings', 'history'] as const

/** Identifier of one surface rendered by the panel document. */
export type SurfaceId = (typeof SURFACE_IDS)[number]

/** Props every surface component receives from the registry. */
export interface SurfaceProps {
  /** The surface id selected by the document URL. */
  readonly surface: SurfaceId
}

/**
 * Component registry keyed by surface id. A ticket replacing one surface
 * changes that surface's component file and keeps its export name.
 */
export const SURFACES: Readonly<Record<SurfaceId, ComponentType<SurfaceProps>>> = {
  panel: PanelSurface,
  settings: SettingsSurface,
  history: HistorySurface,
}

/** The surface rendered when the URL selects none, or an unknown one. */
export const DEFAULT_SURFACE: SurfaceId = 'panel'

/**
 * Parse the surface selection out of a URL query string.
 * @param search - `location.search`, with or without the leading `?`.
 * @returns the selected surface, or the panel when the parameter is absent or unknown.
 */
export function parseSurface(search: string): SurfaceId {
  const value = new URLSearchParams(search).get(SURFACE_PARAMETER)
  return value === 'settings' || value === 'history' ? value : DEFAULT_SURFACE
}
