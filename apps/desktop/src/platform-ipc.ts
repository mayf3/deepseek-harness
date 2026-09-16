/** Shared names for the desktop Platform bridge. */
/** Private desktop channels; the Platform renderer receives only bootstrap. */
export const PLATFORM_IPC = {
  bootstrap: 'dsh-platform:bootstrap',
  open: 'dsh-platform:open',
  bounds: 'dsh-platform:bounds',
  close: 'dsh-platform:close',
} as const
