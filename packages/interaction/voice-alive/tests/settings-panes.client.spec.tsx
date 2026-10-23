// @vitest-environment jsdom
/** The placeholder panes render their own honest copy and no working control. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { copy } from '../src/client/settings/locales.ts'
import { AudioPane } from '../src/client/settings/panes/audio.tsx'
import { PrivacyPane } from '../src/client/settings/panes/privacy.tsx'
import { ShortcutsPane } from '../src/client/settings/panes/shortcuts.tsx'
import { WorkspacesPane } from '../src/client/settings/panes/workspaces.tsx'

afterEach(() => { cleanup() })

function expectHeading(title: string, description: string, badge: string, foot: string): void {
  expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  expect(screen.getByText(description)).toBeTruthy()
  expect(screen.getByText(badge)).toBeTruthy()
  expect(screen.getByText(foot)).toBeTruthy()
}

it('renders the Workspaces placeholder with a disabled add-folder action', () => {
  render(<WorkspacesPane />)
  expectHeading(copy.workspaces.title, copy.workspaces.description, copy.workspaces.badge, copy.workspaces.foot)
  expect(screen.getByText(copy.workspaces.emptyTitle)).toBeTruthy()
  expect(screen.getByText(copy.workspaces.emptyBody)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.workspaces.action }).disabled).toBe(true)
})

it('renders the Audio placeholder with disabled device selects and test tone', () => {
  render(<AudioPane />)
  expectHeading(copy.audio.title, copy.audio.description, copy.audio.badge, copy.audio.foot)

  const input = screen.getByLabelText<HTMLSelectElement>(copy.audio.inputLabel)
  const output = screen.getByLabelText<HTMLSelectElement>(copy.audio.outputLabel)
  expect(input.disabled).toBe(true)
  expect(output.disabled).toBe(true)
  expect(input.selectedOptions[0]?.textContent).toBe(copy.audio.systemDefault)
  expect(output.selectedOptions[0]?.textContent).toBe(copy.audio.systemDefault)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.audio.action }).disabled).toBe(true)
})

it('renders the Shortcuts placeholder with the default chord and disabled actions', () => {
  render(<ShortcutsPane />)
  expectHeading(copy.shortcuts.title, copy.shortcuts.description, copy.shortcuts.badge, copy.shortcuts.foot)
  expect(screen.getByText(copy.shortcuts.summonTitle)).toBeTruthy()
  expect(screen.getByText(copy.shortcuts.modifier)).toBeTruthy()
  expect(screen.getByText(copy.shortcuts.key)).toBeTruthy()
  expect(screen.getByText(copy.shortcuts.summonBody)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.shortcuts.record }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.shortcuts.reset }).disabled).toBe(true)
})

it('renders every Privacy statement without a control that claims to change it', () => {
  render(<PrivacyPane />)
  expectHeading(copy.privacy.title, copy.privacy.description, copy.privacy.badge, copy.privacy.foot)
  for (const section of [
    { title: copy.privacy.leavesTitle, statements: copy.privacy.leaves },
    { title: copy.privacy.diskTitle, statements: copy.privacy.disk },
    { title: copy.privacy.switchesTitle, statements: copy.privacy.switches },
  ]) {
    expect(screen.getByRole('heading', { name: section.title })).toBeTruthy()
    for (const statement of section.statements) {
      expect(screen.getByText(statement.title)).toBeTruthy()
      expect(screen.getByText(statement.body)).toBeTruthy()
    }
  }
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(screen.queryAllByRole('switch')).toHaveLength(0)
  expect(screen.queryAllByRole('textbox')).toHaveLength(0)
})

it('names the disk locations and the audio retention window', () => {
  render(<PrivacyPane />)
  const text = document.body.textContent ?? ''
  expect(text).toContain('~/.dsh/voice/recordings/')
  expect(text).toContain('7 days')
  expect(text).toContain('~/.dsh/voice/history.sqlite')
})
