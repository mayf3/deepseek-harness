/** Browser-safe metadata for native file associations. */
/** One OS-registered application capable of opening the requested file. */
export interface NativeFileApplication {
  /** OS application identifier; callers must revalidate it against the file's current handlers before opening. */
  readonly id: string
  readonly name: string
  readonly default: boolean
  /** PNG data URL, or null when the desktop supplies no icon. */
  readonly icon: string | null
}
//# sourceMappingURL=types.d.ts.map
