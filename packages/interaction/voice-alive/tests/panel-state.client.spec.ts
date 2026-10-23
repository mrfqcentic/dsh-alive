/** Panel state store: transitions, mute toggle, and subscription lifetime. */
import { expect, it, vi } from 'vitest'
import {
  createPanelState,
  nextMutedState,
  PANEL_STATES,
  panelState,
  togglePanelMute,
  type PanelState,
} from '../src/client/panel/state.ts'

it('starts muted and walks every state in product order', () => {
  const store = createPanelState()
  expect(store.get()).toBe('muted')
  for (const state of PANEL_STATES) {
    store.set(state)
    expect(store.get()).toBe(state)
  }
  expect(createPanelState('thinking').get()).toBe('thinking')
})

it('notifies subscribers only when the state changes', () => {
  const store = createPanelState()
  const listener = vi.fn()
  const stop = store.subscribe(listener)
  store.set('listening')
  store.set('listening')
  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener).toHaveBeenCalledWith('listening')
  stop()
  store.set('thinking')
  expect(listener).toHaveBeenCalledTimes(1)
})

it('delivers one change to every listener and lets each unsubscribe', () => {
  const store = createPanelState()
  const first = vi.fn()
  const second = vi.fn()
  store.subscribe(first)
  const stopSecond = store.subscribe(second)
  store.set('speaking')
  expect(first).toHaveBeenCalledWith('speaking')
  expect(second).toHaveBeenCalledWith('speaking')
  stopSecond()
  store.set('error')
  expect(first).toHaveBeenCalledWith('error')
  expect(second).toHaveBeenCalledTimes(1)
})

it('tolerates a listener that unsubscribes during the same round', () => {
  const store = createPanelState()
  const first = vi.fn()
  const late = vi.fn()
  let stopFirst = (): void => {}
  stopFirst = store.subscribe(() => { first(); stopFirst() })
  store.subscribe(late)
  store.set('listening')
  expect(first).toHaveBeenCalledTimes(1)
  expect(late).toHaveBeenCalledWith('listening')
  store.set('thinking')
  expect(first).toHaveBeenCalledTimes(1)
  expect(late).toHaveBeenCalledTimes(2)
})

it.each(PANEL_STATES)('maps %s through the mute toggle', (state) => {
  const expected: PanelState = state === 'muted' ? 'listening' : 'muted'
  expect(nextMutedState(state)).toBe(expected)
})

it('toggles the shared store and any supplied store', () => {
  panelState.set('thinking')
  togglePanelMute()
  expect(panelState.get()).toBe('muted')
  togglePanelMute()
  expect(panelState.get()).toBe('listening')

  const isolated = createPanelState('speaking')
  togglePanelMute(isolated)
  expect(isolated.get()).toBe('muted')
  expect(panelState.get()).toBe('listening')
})
