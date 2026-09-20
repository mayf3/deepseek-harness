/** Native file associations queried from the desktop that owns the path. */
import { runNativeCommand } from './runner.ts'
import type { PathOpenerInternals } from './path-opener.ts'

import type { NativeFileApplication } from './types.ts'

export type { NativeFileApplication } from './types.ts'

/** AppKit runs inside the system JXA host; paths arrive as argv, never executable source. */
const MAC_APPLICATIONS = `
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var icon = workspace.iconForFile(path);
    var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
    thumbnail.lockFocus;
    icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    thumbnail.unlockFocus;
    var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
    var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0))
    });
  }
  return JSON.stringify(apps);
}`

/**
 * List registered handlers in OS preference order, including the current default and application icons.
 * @param path - verified absolute local file path.
 * @param signal - caller lifetime, propagated to the OS query.
 * @param internals - platform and command adapter for deterministic tests.
 * @returns current file handlers; an empty list when the platform has no association query.
 */
export async function nativeFileApplications(
  path: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<readonly NativeFileApplication[]> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform
  if (platform !== 'darwin') return []
  const run = internals.run ?? runNativeCommand
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', MAC_APPLICATIONS, path], signal)
  const value: unknown = JSON.parse(stdout)
  if (!Array.isArray(value)) throw new Error('Invalid native application list')
  const applications: NativeFileApplication[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null
      || typeof entry.id !== 'string' || entry.id.length === 0
      || typeof entry.name !== 'string' || typeof entry.default !== 'boolean'
      || !(entry.icon === null || (typeof entry.icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(entry.icon)))) {
      throw new Error('Invalid native application entry')
    }
    applications.push({ id: entry.id, name: entry.name, default: entry.default, icon: entry.icon })
  }
  return applications
}

/**
 * Open a file in a currently registered handler; stale or arbitrary application identifiers are rejected.
 * @param path - verified absolute local file path.
 * @param application - identifier returned by the file association query.
 * @param signal - caller lifetime, propagated to query and launch.
 * @param internals - platform and command adapter for deterministic tests.
 * @returns after the system launcher accepts the file.
 */
export async function openNativeFileApplication(
  path: string, application: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<void> {
  const apps = await nativeFileApplications(path, signal, internals)
  if (!apps.some(app => app.id === application)) throw new Error('Application is not registered for this file')
  const run = internals.run ?? runNativeCommand
  await run('open', ['-a', application, path], signal)
}
