/**
 * English copy for the settings surface.
 *
 * Every visible string in the settings window comes from this module, so a
 * locale bundle can replace it without touching the surface or its panes.
 */
export const copy = {
  window: 'Voice settings',
  eyebrow: 'Local voice',
  title: 'Settings',
  badge: 'Local only',
  subtitle: 'Nothing leaves this machine',
  tabsLabel: 'Settings sections',
  tabs: {
    models: 'Models',
    workspaces: 'Workspaces',
    audio: 'Audio',
    shortcuts: 'Shortcuts',
    privacy: 'Privacy',
  },
  models: {
    title: 'Models',
    description: 'Local speech weights, their size, languages, and readiness.',
    badgeReady: 'Voice ready',
    badgeBlocked: 'Not ready',
    badgeUnavailable: 'Not connected',
    bannerReady: 'Voice can start: Kokoro and one recognizer are installed and verified.',
    bannerBlocked: 'Voice stays off until Kokoro and one recognizer are downloaded and verified.',
    bannerUnavailable: 'The model store is not connected in this window, so nothing can be downloaded here.',
    disconnectedTitle: 'Model store unavailable',
    disconnectedBody: 'This window has no bridge to the Host model store. Open settings from the voice panel.',
    loading: 'Reading the model store…',
    requiredTag: 'Required',
    alternativeTag: 'Alternative',
    asrTag: 'Recognizer',
    ttsTag: 'Voice',
    sizeLabel: 'Size',
    languagesLabel: 'Languages',
    stateAbsent: 'Not installed',
    stateDownloading: 'Downloading',
    stateVerifying: 'Verifying',
    stateReady: 'Ready',
    stateError: 'Error',
    checkMark: '✓',
    download: 'Download',
    retry: 'Retry',
    cancel: 'Cancel',
    remove: 'Remove',
    activate: 'Use',
    activeTag: 'In use',
    failureNetwork: 'The download failed. Check the connection and try again.',
    failureDisk: 'The disk rejected the download. Check free space and try again.',
    failureHash: 'A file does not match its pinned checksum. Download it again.',
    failurePlatform: 'This host cannot run the pinned speech runtimes.',
    failureCancelled: 'The download was cancelled.',
    foot: 'Voice stays off until the required models are downloaded and verified.',
  },
  workspaces: {
    title: 'Workspaces',
    description: 'Folders the voice conductor may read and write.',
    badge: 'None registered',
    emptyTitle: 'No workspaces yet',
    emptyBody: 'Setup creates the Audio workspace. More folders are added here.',
    action: 'Add folder',
    foot: 'Reads and writes stay inside the selected workspace.',
  },
  audio: {
    title: 'Audio',
    description: 'Input and output devices, the level meter, and the test tone.',
    badge: 'Not configured',
    inputLabel: 'Input device',
    outputLabel: 'Output device',
    systemDefault: 'System default',
    action: 'Play test tone',
    foot: 'Devices follow the system default until this pane is connected to the engine.',
  },
  shortcuts: {
    title: 'Shortcuts',
    description: 'The chord that opens the panel and toggles mute.',
    badge: 'Default chord',
    summonTitle: 'Summon panel / toggle mute',
    summonBody: 'Press the chord while the panel is hidden or muted to listen. Press it again to mute and clear the queue.',
    record: 'Record chord',
    reset: 'Reset',
    modifier: '⌥',
    key: 'Space',
    foot: 'The chord works over any application and is stored with the settings.',
  },
  privacy: {
    title: 'Privacy',
    description: 'What stays here, and what the network is allowed to carry.',
    badge: 'Local first',
    statements: [
      { title: 'No telemetry', body: 'No analytics, usage events, or crash reports.' },
      { title: 'Local speech', body: 'Recognition and synthesis run on this machine. Audio never leaves it.' },
      { title: 'Inference only', body: 'Model requests and weight downloads are the only network traffic.' },
    ],
    foot: 'The settings surface itself sends nothing.',
  },
} as const

/**
 * Format a byte count for the Models pane.
 * @param bytes - byte count to render.
 * @returns the size in GB when it is at least one gigabyte, else in whole MB.
 */
export function formatModelSize(bytes: number): string {
  const megabytes = bytes / 1_000_000
  if (megabytes >= 1_000) return `${(megabytes / 1_000).toFixed(1)} GB`
  return `${String(Math.round(megabytes))} MB`
}

/**
 * Format download progress for the Models pane.
 * @param receivedBytes - bytes already present.
 * @param totalBytes - pinned byte count.
 * @returns a percentage with the transferred size.
 */
export function formatModelProgress(receivedBytes: number, totalBytes: number): string {
  const total = totalBytes === 0 ? 1 : totalBytes
  const percent = Math.min(100, Math.max(0, Math.round(receivedBytes / total * 100)))
  return `${String(percent)}% · ${formatModelSize(receivedBytes)} of ${formatModelSize(totalBytes)}`
}
