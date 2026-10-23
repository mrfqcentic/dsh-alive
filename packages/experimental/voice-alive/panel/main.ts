/**
 * Voice panel document entry. The panel build writes the voice-only
 * `__DSH_BOOT__` table into `panel.html`; `AppWebEntry` is the same client
 * kernel the main Web shell runs, so the panel boots the ordinary client
 * runtime with only the rows that table names.
 * @module @deepseek-ai/dsh-voice-alive/panel
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import './panel.css'

const container = document.getElementById('root')
if (container === null) throw new Error('voice panel: the document has no #root')

const entry = new AppWebEntry(container)
void entry.run()
