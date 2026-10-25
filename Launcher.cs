using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Globalization;

internal static class Launcher
{
    private static Process server;
    private static int stopRequested;
    private static readonly ManualResetEvent ready = new ManualResetEvent(false);
    private static readonly StringBuilder diagnostics = new StringBuilder();
    private static string serviceUrl;
    private static string adminToken;
    private static IntPtr job = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr handle, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);

    // Windows CommandLineToArgvW quoting: preserve spaces, quotes and trailing backslashes.
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static void Stop()
    {
        if (Interlocked.Exchange(ref stopRequested, 1) != 0) return;
        try { server.StandardInput.WriteLine("stop"); server.StandardInput.Flush(); }
        catch (InvalidOperationException) { }
        catch (IOException) { }
    }

    private static void Fail(string message)
    {
        MessageBox.Show(message, "智能体本地聊天室 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Thread.CurrentThread.CurrentCulture = CultureInfo.CurrentUICulture;
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.CurrentUICulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.CurrentUICulture;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string host = Path.Combine(root, "launcher-host.mjs");
        StringBuilder arguments = new StringBuilder(Quote(host));
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--help")
            {
                MessageBox.Show("LocalAgentChat.exe [--port PORT] [--data-dir PATH]\n\n启动本地聊天窗口并自动连接管理员。关闭窗口会停止本次服务。", "智能体本地聊天室");
                return 0;
            }
            if ((args[i] != "--port" && args[i] != "--data-dir") || i + 1 >= args.Length)
            {
                Fail("参数：--port PORT、--data-dir PATH。默认直接打开本地聊天窗口。");
                return 1;
            }
            arguments.Append(' ').Append(Quote(args[i]));
            arguments.Append(' ').Append(Quote(args[++i]));
        }
        if (!File.Exists(host) || !File.Exists(Path.Combine(root, "server.mjs")))
        {
            Fail("请保留完整项目目录；EXE 必须与 launcher-host.mjs、server.mjs 和 public 文件夹放在一起。");
            return 1;
        }
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new InvalidOperationException("无法建立子进程生命周期保护。");
            // Assign before spawning Node so every service child inherits the job atomically.
            if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
                throw new InvalidOperationException("无法设置进程保护；请从普通 Windows 桌面或终端启动。");

            server = new Process();
            server.StartInfo = new ProcessStartInfo("node.exe", arguments.ToString())
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            server.EnableRaisingEvents = true;
            server.Exited += delegate { ready.Set(); };
            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                if (e.Data.StartsWith("Admin token: ", StringComparison.Ordinal)) adminToken = e.Data.Substring(13);
                if (e.Data.StartsWith("Listening: http://127.0.0.1:", StringComparison.Ordinal)) serviceUrl = e.Data.Substring(11);
                if (adminToken != null && serviceUrl != null) ready.Set();
            };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (diagnostics) { if (diagnostics.Length < 8000) diagnostics.AppendLine(e.Data); }
            };
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            if (!ready.WaitOne(15000) || server.HasExited || serviceUrl == null || adminToken == null)
            {
                string detail;
                lock (diagnostics) detail = diagnostics.ToString();
                string reason = detail.Contains("port is already in use") ? "端口已被占用，请关闭之前的聊天室或改用其他端口。"
                    : detail.Contains("data directory") ? "数据目录无法使用，请检查访问权限、数据库及是否已有服务使用该目录。"
                    : detail.Contains("Port must") ? "端口必须是 0 到 65535 的整数。"
                    : "请检查 Node.js 22.13 以上版本、端口、数据目录和服务文件是否完整。";
                Fail("无法启动聊天室。" + reason);
                return 1;
            }
            int result = 0;
            using (ChatForm window = new ChatForm(serviceUrl, adminToken))
            using (System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer())
            {
                monitor.Interval = 1000;
                monitor.Tick += delegate
                {
                    if (!server.HasExited) return;
                    monitor.Stop();
                    result = 1;
                    MessageBox.Show(window, "本地服务已退出，聊天窗口将关闭。请重新启动并检查数据目录或端口。", "服务已停止", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    window.Close();
                };
                monitor.Start();
                Application.Run(window);
                monitor.Stop();
            }
            Stop();
            if (!server.WaitForExit(7000)) { server.Kill(); server.WaitForExit(); result = 1; }
            return result == 0 ? server.ExitCode : result;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            Fail("无法运行 node.exe。请安装 Node.js 22.13 或更新版本，并确保 node 在 PATH 中。");
            return 1;
        }
        catch (Exception error)
        {
            Fail(error.Message);
            return 1;
        }
        finally
        {
            adminToken = null;
            if (server != null)
            {
                try
                {
                    if (!server.HasExited) { Stop(); if (!server.WaitForExit(7000)) server.Kill(); }
                }
                catch (InvalidOperationException) { }
                finally { server.Dispose(); }
            }
            // The OS closes our job on process exit, killing any remaining service child.
            // Closing it manually would terminate this launcher before delivering its exit code.
        }
    }
}
