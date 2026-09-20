/** Windows Shell association queries and invocation; paths are encoded data, never PowerShell expressions. */
import type { NativeCommandRunner } from './runner.ts'

/** Shell interfaces are declared in their native vtable order; Invoke preserves packaged-app and DDE handling. */
const WINDOWS_ASSOCIATIONS = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class DshFileAssociations {
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumHandlers {
    [PreserveSig] int Next(uint count, out IHandler handler, out uint fetched);
  }
  [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IHandler {
    void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
    [PreserveSig] int IsRecommended();
    void MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
    void Invoke(IDataObject data);
    void CreateInvoker(IDataObject data, [MarshalAs(UnmanagedType.Interface)] out object invoker);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IDataObject data);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumHandlers handlers);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint size);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr icon);

  public sealed class Application {
    public string id;
    public string name;
    public string icon;
    public bool @default;
  }
  static string Associated(string extension, uint kind) {
    uint size = 0;
    AssocQueryString(0, kind, extension, null, null, ref size);
    if (size == 0) return null;
    var text = new StringBuilder((int)size);
    return AssocQueryString(0, kind, extension, null, text, ref size) == 0 ? text.ToString() : null;
  }
  static string IconData(IHandler handler) {
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
    try {
      string source; int index;
      handler.GetIconLocation(out source, out index);
      source = Environment.ExpandEnvironmentVariables(source);
      if (Path.GetExtension(source).Equals(".png", StringComparison.OrdinalIgnoreCase)) {
        using (var original = Image.FromFile(source))
        using (var resized = new Bitmap(original, new Size(32, 32)))
        using (var stream = new MemoryStream()) {
          resized.Save(stream, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
        }
      }
      if (SHDefExtractIcon(source, index, 0, out large, out small, 32) != 0 || large == IntPtr.Zero) return null;
      using (var image = Icon.FromHandle(large))
      using (var bitmap = image.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } catch (Exception) {
      // Missing icon resources do not make the application unusable.
      return null;
    } finally {
      if (large != IntPtr.Zero) DestroyIcon(large);
      if (small != IntPtr.Zero) DestroyIcon(small);
    }
  }
  static void Visit(string path, Action<IHandler> visit) {
    var extension = Path.GetExtension(path);
    if (extension.Length == 0) return;
    IEnumHandlers handlers;
    SHAssocEnumHandlers(extension, 0, out handlers);
    try {
      while (true) {
        IHandler handler; uint fetched;
        int result = handlers.Next(1, out handler, out fetched);
        Marshal.ThrowExceptionForHR(result);
        if (fetched == 0) break;
        try { visit(handler); } finally { Marshal.FinalReleaseComObject(handler); }
      }
    } finally { Marshal.FinalReleaseComObject(handlers); }
  }
  public static Application[] List(string path) {
    var extension = Path.GetExtension(path);
    var executable = extension.Length == 0 ? null : Associated(extension, 2);
    var appId = extension.Length == 0 ? null : Associated(extension, 21);
    var apps = new List<Application>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Visit(path, delegate(IHandler handler) {
      string id, name;
      handler.GetName(out id); handler.GetUIName(out name);
      if (!seen.Add(id)) return;
      apps.Add(new Application { id = id, name = name, icon = IconData(handler),
        @default = String.Equals(id, executable, StringComparison.OrdinalIgnoreCase) || String.Equals(id, appId, StringComparison.OrdinalIgnoreCase) });
    });
    return apps.ToArray();
  }
  public static void Open(string path, string application) {
    bool opened = false;
    Visit(path, delegate(IHandler handler) {
      string id; handler.GetName(out id);
      if (opened || !String.Equals(id, application, StringComparison.OrdinalIgnoreCase)) return;
      var iid = typeof(IShellItem).GUID;
      IShellItem item;
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
      IDataObject data = null;
      try {
        var bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
        var dataIid = typeof(IDataObject).GUID;
        item.BindToHandler(IntPtr.Zero, ref bhid, ref dataIid, out data);
        handler.Invoke(data);
        opened = true;
      } finally {
        if (data != null) Marshal.FinalReleaseComObject(data);
        Marshal.FinalReleaseComObject(item);
      }
    });
    if (!opened) throw new InvalidOperationException("Application is not registered for this file");
  }
}`

/**
 * Execute the Windows Shell adapter in a Unicode STA PowerShell process.
 * @param path - Windows file path, translated by the caller for WSL.
 * @param application - registered handler to invoke; null requests the application list.
 * @param signal - caller cancellation.
 * @param run - native command runner.
 * @returns adapter output; query mode emits a JSON array.
 */
export async function windowsFileApplications(
  path: string, application: string | null, signal: AbortSignal, run: NativeCommandRunner,
): Promise<string> {
  const encodedPath = Buffer.from(path).toString('base64')
  const encodedApplication = Buffer.from(application ?? '').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System,System.Core,System.Drawing -TypeDefinition @'
${WINDOWS_ASSOCIATIONS}
'@
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$application = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedApplication}'))
${application === null ? 'ConvertTo-Json -InputObject @([DshFileAssociations]::List($path)) -Depth 4 -Compress' : '[DshFileAssociations]::Open($path, $application)'}
`
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], signal)
  return result.stdout
}
