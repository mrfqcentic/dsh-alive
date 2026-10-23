/**
 * Models pane: the local model catalog with its per-entry state and the
 * readiness the voice layer is blocked on.
 *
 * The pane owns presentation only. Catalog data, downloads, verification,
 * removal, and activation live in the Host model store and arrive through
 * {@link ModelCatalogSource}, so every state the pane can render is a state the
 * store actually reported.
 * @module @deepseek-ai/dsh-voice-alive/client/settings/panes/models
 */
import { useEffect, useState, type ReactElement } from 'react'
import type {
  ModelCatalogSource,
  ModelReadinessView,
  ModelRowFailure,
  ModelRowState,
  ModelRowView,
  ModelSnapshot,
} from '../models-source.ts'
import { copy, formatModelProgress, formatModelSize } from '../locales.ts'
import { modelCatalogSource } from '../models-source.ts'
import css from '../settings.module.css'
import { PaneHeader } from './pane-header.tsx'

/** Props the pane accepts; the registry mounts it without props. */
export interface ModelsPaneProps {
  /** Catalog source; tests inject a fake, production reads the panel bridge. */
  readonly source?: ModelCatalogSource
}

/**
 * Localize one row state.
 * @param state - state the store reported.
 * @returns the state label.
 */
function stateLabel(state: ModelRowState): string {
  switch (state) {
    case 'absent': return copy.models.stateAbsent
    case 'downloading': return copy.models.stateDownloading
    case 'verifying': return copy.models.stateVerifying
    case 'ready': return copy.models.stateReady
    case 'error': return copy.models.stateError
  }
}

/**
 * Localize one failure, keeping the host's own message for a code this build does not know.
 * @param failure - failure the store reported.
 * @returns the sentence shown under the row.
 */
function failureText(failure: ModelRowFailure): string {
  switch (failure.code) {
    case 'network': return copy.models.failureNetwork
    case 'disk': return copy.models.failureDisk
    case 'hash-mismatch':
    case 'size-mismatch': return copy.models.failureHash
    case 'unsupported-platform': return copy.models.failurePlatform
    case 'cancelled': return copy.models.failureCancelled
    default: return failure.message
  }
}

/**
 * @param supported - whether a compatible bridge exists.
 * @param readiness - readiness the store reported.
 * @returns the banner sentence for the current gate state.
 */
function bannerText(supported: boolean, readiness: ModelReadinessView): string {
  if (!supported) return copy.models.bannerUnavailable
  return readiness.ready ? copy.models.bannerReady : copy.models.bannerBlocked
}

/**
 * @param supported - whether a compatible bridge exists.
 * @param ready - readiness the store reported.
 * @returns the badge label for the current gate state.
 */
function badgeText(supported: boolean, ready: boolean): string {
  if (!supported) return copy.models.badgeUnavailable
  return ready ? copy.models.badgeReady : copy.models.badgeBlocked
}

/**
 * Whole-percent completion of one row.
 * @param row - catalog row.
 * @returns completion in [0, 100].
 */
function progressPercent(row: ModelRowView): number {
  const total = row.bytes === 0 ? 1 : row.bytes
  return Math.min(100, Math.round(row.receivedBytes / total * 100))
}

/**
 * Whether readiness uses one row for its kind.
 * @param row - catalog row.
 * @param readiness - readiness the store reported.
 * @returns true for the recognizer or synthesizer readiness selected.
 */
function isActive(row: ModelRowView, readiness: ModelReadinessView): boolean {
  return row.kind === 'asr' ? readiness.asr === row.id : readiness.tts === row.id
}

/**
 * Render the actions one row state offers.
 * @param props - catalog row, whether readiness uses it, and the source its actions address.
 * @returns the row's buttons, possibly none.
 */
function RowActions({ row, active, source }: {
  readonly row: ModelRowView
  readonly active: boolean
  readonly source: ModelCatalogSource
}): ReactElement | null {
  if (row.state === 'verifying') return null
  if (row.state === 'downloading') {
    return (
      <div className={css.actions}>
        <button type="button" className="btn btn--sm" onClick={() => { source.cancel(row.id) }}>
          {copy.models.cancel}
        </button>
      </div>
    )
  }
  if (row.state === 'ready') {
    return (
      <div className={css.actions}>
        {active
          ? null
          : (
            <button type="button" className="btn btn--sm" onClick={() => { void source.activate(row.id) }}>
              {copy.models.activate}
            </button>
          )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => { void source.remove(row.id) }}>
          {copy.models.remove}
        </button>
      </div>
    )
  }
  return (
    <div className={css.actions}>
      <button type="button" className="btn btn--sm" onClick={() => { void source.download(row.id) }}>
        {row.state === 'error' ? copy.models.retry : copy.models.download}
      </button>
      {row.state === 'error'
        ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => { void source.remove(row.id) }}>
            {copy.models.remove}
          </button>
        )
        : null}
    </div>
  )
}

/**
 * Render one catalog row with its tags, size, languages, state, and actions.
 * @param props - catalog row, whether readiness uses it, and the source its actions address.
 * @returns the list item.
 */
function ModelRow({ row, active, source }: {
  readonly row: ModelRowView
  readonly active: boolean
  readonly source: ModelCatalogSource
}): ReactElement {
  const downloading = row.state === 'downloading'
  const percent = progressPercent(row)
  return (
    <li className={css.model} data-state={row.state}>
      <div className={css.modelHead}>
        <div>
          <span className={css.modelName}>{row.name}</span>
          <p className={css.cardCopy}>{row.summary}</p>
        </div>
        <span className={css.modelState}>
          {stateLabel(row.state)}
          {row.state === 'ready' ? <span aria-hidden="true" className={css.checkMark}>{copy.models.checkMark}</span> : null}
        </span>
      </div>
      <div className={css.modelTags}>
        <span className="badge">{row.required ? copy.models.requiredTag : copy.models.alternativeTag}</span>
        <span className="badge">{row.kind === 'asr' ? copy.models.asrTag : copy.models.ttsTag}</span>
        {active ? <span className="badge">{copy.models.activeTag}</span> : null}
      </div>
      <dl className={css.modelMeta}>
        <div>
          <dt>{copy.models.sizeLabel}</dt>
          <dd>{formatModelSize(row.bytes)}</dd>
        </div>
        <div>
          <dt>{copy.models.languagesLabel}</dt>
          <dd>{row.languages.join(', ')}</dd>
        </div>
      </dl>
      {row.state === 'downloading' || row.state === 'verifying'
        ? (
          <div className={css.modelProgress}>
            <div
              className={row.state === 'verifying' ? 'progress progress--indeterminate' : 'progress'}
              role="progressbar"
              aria-label={stateLabel(row.state)}
              aria-valuemin={0}
              aria-valuemax={100}
              {...downloading ? { 'aria-valuenow': percent } : {}}
            >
              <i style={downloading ? { width: `${String(percent)}%` } : undefined} />
            </div>
            {downloading
              ? <span className={css.modelBytes}>{formatModelProgress(row.receivedBytes, row.bytes)}</span>
              : null}
          </div>
        )
        : null}
      {row.failure === null ? null : <p className={css.errorText}>{failureText(row.failure)}</p>}
      <RowActions row={row} active={active} source={source} />
    </li>
  )
}

/**
 * Render the model catalog with its readiness banner.
 * @param props - optional catalog source; the shared bridge source is the default.
 * @returns the Models pane.
 */
export function ModelsPane({ source = modelCatalogSource }: ModelsPaneProps = {}): ReactElement {
  const [snapshot, setSnapshot] = useState<ModelSnapshot>(() => source.snapshot())
  useEffect(() => source.subscribe(() => { setSnapshot(source.snapshot()) }), [source])
  const supported = source.supported

  return (
    <div>
      <PaneHeader
        title={copy.models.title}
        description={copy.models.description}
        badge={badgeText(supported, snapshot.readiness.ready)}
      />
      <p className={css.banner} role="status">{bannerText(supported, snapshot.readiness)}</p>
      {!supported
        ? (
          <div className="empty">
            <strong>{copy.models.disconnectedTitle}</strong>
            <span className={css.emptyBody}>{copy.models.disconnectedBody}</span>
          </div>
        )
        : snapshot.rows.length === 0
          ? <p className={css.foot}>{copy.models.loading}</p>
          : (
            <ul className={css.modelList}>
              {snapshot.rows.map(row => (
                <ModelRow
                  key={row.id}
                  row={row}
                  active={isActive(row, snapshot.readiness)}
                  source={source}
                />
              ))}
            </ul>
          )}
      <p className={css.foot}>{copy.models.foot}</p>
    </div>
  )
}
