param()
$ErrorActionPreference = 'Stop'
# Inspectable, persistent handle guard. The parent closes stdin only after SQLite closes.
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;
public static class PreflightPathGuard {
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    static readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    static readonly HashSet<string> directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, SafeFileHandle> sources = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    static string Full(string path) {
        string full = Path.GetFullPath(path).TrimEnd('\\');
        if (full.Length < 2 || full[1] != ':' || full.StartsWith("\\\\")) throw new IOException("Only local drive paths are accepted.");
        return full.Length == 2 ? full + "\\" : full;
    }
    static void Lock(string path, bool directory) {
        path = Full(path);
        // No write/delete sharing: neither reparse mutation nor rename/replacement is possible while held.
        SafeFileHandle handle = CreateFile(path, directory ? 0x80u : 0x80000000u, 1u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Cannot lock preflight path (Win32 " + Marshal.GetLastWin32Error() + "): " + path); }
        try {
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info)) throw new IOException("Cannot inspect locked preflight path.");
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) throw new IOException("Linked or unexpected preflight path refused: " + path);
            if (!directory && info.Links != 1) throw new IOException("Hard-linked preflight database refused.");
            StringBuilder final = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity) throw new IOException("Cannot resolve locked preflight path.");
            string actual = final.ToString();
            if (actual.StartsWith("\\\\?\\")) actual = actual.Substring(4);
            if (!String.Equals(Full(actual), path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Locked preflight path resolved elsewhere: " + path);
            handles.Add(handle);
            if (directory) directories.Add(path);
            else sources.Add(path, handle);
        } catch { handle.Dispose(); throw; }
    }
    static void LockDirectories(string path) {
        path = Full(path);
        string root = Path.GetPathRoot(path);
        string current = root;
        if (!directories.Contains(Full(current))) Lock(current, true);
        foreach (string part in path.Substring(root.Length).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
            current = Path.Combine(current, part);
            if (!directories.Contains(Full(current))) Lock(current, true);
        }
    }
    static void Snapshot(string source, string destination) {
        source = Full(source); destination = Full(destination);
        if (!directories.Contains(destination)) throw new IOException("Snapshot destination is not locked.");
        foreach (string suffix in new string[] {"", "-wal", "-shm", "-journal"}) {
            SafeFileHandle handle;
            if (!sources.TryGetValue(Path.Combine(source, "chat.sqlite" + suffix), out handle)) continue;
            string output = Path.Combine(destination, "chat.sqlite" + suffix);
            // FileStream owns a duplicate, not the lifetime-lock handle.
            SafeFileHandle duplicate;
            if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out duplicate, 0, false, 2)) throw new IOException("Cannot duplicate snapshot source handle.");
            using (var input = new FileStream(duplicate, FileAccess.Read))
            using (var copy = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { input.CopyTo(copy); copy.Flush(true); }
            Lock(output, false);
        }
    }
    static void CreateLocked(string path) {
        path = Full(path);
        if (!directories.Contains(Full(Path.GetDirectoryName(path)))) throw new IOException("Scratch parent must already be locked.");
        if (Directory.Exists(path) || File.Exists(path)) throw new IOException("Scratch path already exists.");
        var security = new System.Security.AccessControl.DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User;
        security.SetOwner(sid);
        security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(sid, System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit, System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
        Directory.CreateDirectory(path, security);
        Lock(path, true);
        if (Directory.GetFileSystemEntries(path).Length != 0) throw new IOException("Scratch directory is not empty.");
    }
    public static void Run() {
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var request = json.Deserialize<Dictionary<string, string>>(line);
                try {
                    string op = request["op"];
                    if (op == "source") {
                        string root = Full(request["root"]), data = Full(request["data"]);
                        if (!data.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException("Preflight source must be strictly inside the isolated temp directory.");
                        LockDirectories(root);
                        LockDirectories(data);
                        Lock(Path.Combine(data, "chat.sqlite"), false);
                        // WAL/SHM may contain committed source pages; pin any existing sidecars too.
                        foreach (string suffix in new string[] {"-wal", "-shm", "-journal"}) {
                            string sidecar = Path.Combine(data, "chat.sqlite" + suffix);
                            if (File.Exists(sidecar) || Directory.Exists(sidecar)) Lock(sidecar, false);
                        }
                    } else if (op == "root") { LockDirectories(request["path"]); }
                    else if (op == "mkdir") { CreateLocked(request["path"]); }
                    else if (op == "snapshot") { Snapshot(request["source"], request["destination"]); }
                    else throw new IOException("Unknown guard operation.");
                    Console.WriteLine(json.Serialize(new { ok = true }));
                    Console.Out.Flush();
                } catch (Exception error) {
                    Console.WriteLine(json.Serialize(new { ok = false, error = error.Message }));
                    Console.Out.Flush();
                    return;
                }
            }
        } finally { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); }
    }
}
'@
[PreflightPathGuard]::Run()
