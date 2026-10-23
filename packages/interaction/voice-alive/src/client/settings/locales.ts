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
    badge: 'Not ready',
    emptyTitle: 'No models yet',
    emptyBody: 'The catalog lists pinned downloads here once the model store exists.',
    action: 'Download models',
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
