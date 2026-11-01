using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Globalization;
using System.Collections.Generic;
using System.Web.Script.Serialization;

internal static class Launcher
{
    private static Process server;
    private static int stopRequested;
    private static readonly ManualResetEvent ready = new ManualResetEvent(false);
    private static readonly StringBuilder diagnostics = new StringBuilder();
    private static string serviceUrl;
    private static string adminToken;
    private static bool controlledLaunch = false;
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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

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
        if (controlledLaunch) { try { Console.Error.WriteLine(message); } catch (IOException) { } }
        else MessageBox.Show(message, "智能体本地聊天室 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static readonly JavaScriptSerializer controlJson = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private static StreamReader controlInput;
    private static StreamWriter controlOutput;
    private static void SendControl(object value)
    {
        lock (controlOutput) { controlOutput.WriteLine(controlJson.Serialize(value)); controlOutput.Flush(); }
    }

    private static Dictionary<string, object> ReadControl()
    {
        var line = new StringBuilder();
        while (true)
        {
            int ch = controlInput.Read();
            if (ch < 0) { if (line.Length == 0) return null; throw new InvalidDataException("控制消息不完整。"); }
            if (ch == '\n') break;
            if (line.Length >= 2097152) throw new InvalidDataException("控制消息过长。");
            line.Append((char)ch);
        }
        return controlJson.Deserialize<Dictionary<string, object>>(line.ToString());
    }

    private static string ControlString(Dictionary<string, object> command, string key)
    {
        object value;
        return command != null && command.TryGetValue(key, out value) ? value as string : null;
    }
    private static void StartServer(string root, string arguments)
    {
        ready.Reset(); serviceUrl = null; adminToken = null; stopRequested = 0;
        lock (diagnostics) diagnostics.Clear();
        server = new Process();
        server.StartInfo = new ProcessStartInfo("node.exe", arguments)
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
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
        { if (e.Data != null) lock (diagnostics) { if (diagnostics.Length < 8000) diagnostics.AppendLine(e.Data); } };
        server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine();
        if (!ready.WaitOne(15000) || server.HasExited || serviceUrl == null || adminToken == null)
        {
            if (!server.HasExited) { Stop(); if (!server.WaitForExit(7000)) { server.Kill(); server.WaitForExit(); } }
            throw new InvalidOperationException("无法启动聊天室服务，请检查端口和数据目录。");
        }
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
        Dictionary<string, object> restoreState = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--help")
            {
                MessageBox.Show("LocalAgentChat.exe [--port PORT] [--data-dir PATH]\n\n启动本地聊天窗口并自动连接管理员。关闭窗口会停止本次服务。", "智能体本地聊天室");
                return 0;
            }
            if (args[i] == "--hot-control")
            {
                if (controlledLaunch) return 1;
                controlledLaunch = true;
                continue;
            }
            if ((args[i] != "--port" && args[i] != "--data-dir") || i + 1 >= args.Length)
            {
                Fail("参数：--port PORT、--data-dir PATH。默认直接打开本地聊天窗口。");
                return 1;
            }
            arguments.Append(' ').Append(Quote(args[i]));
            arguments.Append(' ').Append(Quote(args[++i]));
        }
        if (controlledLaunch)
        {
            if (!SetHandleInformation(GetStdHandle(-10), 1, 0) || !SetHandleInformation(GetStdHandle(-11), 1, 0)) return 1;
            try
            {
                controlInput = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
                controlOutput = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                var start = ReadControl();
                if (ControlString(start, "type") != "start" || !start.ContainsKey("state")) return 1;
                object state = start["state"];
                if (state != null && (restoreState = state as Dictionary<string, object>) == null) return 1;
                if (!start.ContainsKey("requestId") || (state == null ? start["requestId"] != null : ControlString(start, "requestId") == null || ControlString(start, "requestId") != ControlString(restoreState, "requestId"))) return 1;
            }
            catch (Exception) { return 1; }
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

            StartServer(root, arguments.ToString());
            int result = 0;
            using (ChatForm window = new ChatForm(serviceUrl, adminToken))
            using (System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer())
            {
                if (restoreState != null) { window.RestoreHandoff(restoreState); window.FreezeCandidate(); }
                bool candidateFrozen = restoreState != null;
                bool announced = false, preparing = false, serviceStopped = false, pipeLost = false;
                string preparedId = null;
                Func<System.Threading.Tasks.Task> recover = async delegate
                {
                    while (preparing) await System.Threading.Tasks.Task.Delay(100);
                    if (preparedId == null) return;
                    try
                    {
                        if (serviceStopped)
                        {
                            for (int attempt = 0; ; attempt++)
                            {
                                if (server != null)
                                {
                                    if (!server.HasExited && !server.WaitForExit(7000)) throw new InvalidOperationException("原服务仍在排空，请稍后重试。");
                                    server.Dispose();
                                }
                                try { StartServer(root, arguments.ToString()); break; }
                                catch (InvalidOperationException)
                                {
                                    if (!pipeLost || attempt >= 9) throw;
                                }
                                await System.Threading.Tasks.Task.Delay(1000);
                            }
                            window.ReconnectHandoff(serviceUrl, adminToken);
                            serviceStopped = false;
                        }
                        else window.ResumeAfterHandoff();
                        string id = preparedId;
                        if (pipeLost) preparedId = null;
                        if (!pipeLost)
                        {
                            DateTime deadline = DateTime.UtcNow.AddSeconds(20);
                            while (!window.HandoffReady && DateTime.UtcNow < deadline) await System.Threading.Tasks.Task.Delay(100);
                            if (!window.HandoffReady) throw new InvalidOperationException("恢复后服务未就绪。");
                            SendControl(new { type = "aborted", requestId = id });
                            preparedId = null;
                        }
                    }
                    catch (Exception error)
                    {
                        if (!pipeLost) { try { SendControl(new { type = "error", requestId = preparedId, error = error.Message }); } catch (IOException) { } }
                        MessageBox.Show(window, "自动恢复失败，草稿仍保留在此窗口，请先关闭占用服务的其他窗口再处理。\n" + error.Message, "交接恢复失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                };
                if (controlledLaunch)
                {
                    window.Shown += delegate
                    {
                        Thread reader = new Thread(delegate()
                        {
                            try
                            {
                                while (true)
                                {
                                    var command = ReadControl();
                                    if (command == null) break;
                                    window.BeginInvoke((Action)(async delegate
                                    {
                                        try
                                        {
                                        string type = ControlString(command, "type");
                                        string id = ControlString(command, "requestId");
                                        if (type == "prepare")
                                        {
                                            if (!announced || candidateFrozen || preparing || preparedId != null || String.IsNullOrWhiteSpace(id) || id.Length > 128)
                                            { SendControl(new { type = "error", requestId = id, error = "交接状态无效或尚未就绪。" }); return; }
                                            preparing = true;
                                            try
                                            {
                                                object state = await window.PrepareHandoffAsync(id);
                                                string serialized = controlJson.Serialize(new { type = "prepared", requestId = id, state = state });
                                                if (serialized.Length > 1900000) { window.ResumeAfterHandoff(); throw new InvalidOperationException("草稿状态过大，已取消更新并保留当前窗口。"); }
                                                preparedId = id;
                                                lock (controlOutput) { controlOutput.WriteLine(serialized); controlOutput.Flush(); }
                                            }
                                            catch (Exception error) { try { SendControl(new { type = "error", requestId = id, error = error.Message }); } catch (IOException) { } }
                                            finally { preparing = false; }
                                        }
                                        else if (type == "stop-service" && id != null && id == preparedId && !serviceStopped)
                                        {
                                            serviceStopped = true;
                                            Stop();
                                            if (!server.WaitForExit(7000)) { SendControl(new { type = "error", requestId = id, error = "服务排空超时。" }); }
                                            else SendControl(new { type = "service-stopped", requestId = id });
                                        }
                                        else if (type == "abort" && id != null && id == preparedId)
                                            await recover();
                                        else if (type == "commit" && id != null && id == preparedId && serviceStopped)
                                        { monitor.Stop(); window.Close(); }
                                        else if (type == "activate" && candidateFrozen && announced && id == ControlString(restoreState, "requestId"))
                                        { candidateFrozen = false; window.ActivateCandidate(); SendControl(new { type = "activated", requestId = id }); }
                                        else if (type == "shutdown" && !preparing && preparedId == null)
                                        { monitor.Stop(); window.Close(); }
                                        else SendControl(new { type = "error", requestId = id, error = "控制命令无效或交接标识不匹配。" });
                                        }
                                        // A controller can disappear after sending a command but
                                        // before its acknowledgement. Let the reader's EOF recovery
                                        // keep this window and its draft, not an async-void exception.
                                        catch (IOException) { }
                                    }));
                                }
                            }
                            catch (Exception) { }
                            try { window.BeginInvoke((Action)(async delegate
                            {
                                pipeLost = true;
                                if (preparing || preparedId != null) await recover();
                                else if (candidateFrozen)
                                {
                                    serviceStopped = true;
                                    Stop();
                                    if (!server.WaitForExit(7000))
                                    {
                                        MessageBox.Show(window, "候选服务仍在排空，草稿保留。确认旧窗口已关闭且服务退出后可重试恢复。", "更新中断", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                                        window.CandidateRecoveryAvailable(delegate
                                        {
                                            try {
                                                if (!server.HasExited) throw new InvalidOperationException("候选服务仍在排空。");
                                                server.Dispose(); StartServer(root, arguments.ToString()); window.ReconnectHandoff(serviceUrl, adminToken); serviceStopped = false; candidateFrozen = false; window.ActivateCandidate(); return true;
                                            } catch (Exception error) { MessageBox.Show(window, "恢复失败，草稿仍保留：" + error.Message, "更新中断", MessageBoxButtons.OK, MessageBoxIcon.Warning); return false; }
                                        });
                                    }
                                    else
                                    {
                                        while (MessageBox.Show(window, "更新控制器已断开，候选服务已停止，草稿仍保留。仅在确认旧窗口已关闭后选择重试以恢复本窗口；选择取消可稍后再次选择。", "更新中断", MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Retry)
                                        {
                                            try { server.Dispose(); StartServer(root, arguments.ToString()); window.ReconnectHandoff(serviceUrl, adminToken); serviceStopped = false; candidateFrozen = false; window.ActivateCandidate(); break; }
                                            catch (Exception error) { MessageBox.Show(window, "恢复失败，草稿仍保留：" + error.Message, "更新中断", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                                        }
                                        if (candidateFrozen) window.CandidateRecoveryAvailable(delegate
                                        {
                                            try { server.Dispose(); StartServer(root, arguments.ToString()); window.ReconnectHandoff(serviceUrl, adminToken); serviceStopped = false; candidateFrozen = false; window.ActivateCandidate(); return true; }
                                            catch (Exception error) { MessageBox.Show(window, "恢复失败，草稿仍保留：" + error.Message, "更新中断", MessageBoxButtons.OK, MessageBoxIcon.Warning); return false; }
                                        });
                                    }
                                }
                                else window.ControllerDisconnected();
                            })); } catch (InvalidOperationException) { }
                        });
                        reader.IsBackground = true;
                        reader.Start();
                    };
                }
                monitor.Interval = 250;
                monitor.Tick += delegate
                {
                    if (controlledLaunch && !pipeLost && !announced && window.HandoffReady)
                    {
                        try { SendControl(new { type = "ready" }); announced = true; if (!candidateFrozen) window.HandoffAcknowledged(); }
                        catch (IOException) { pipeLost = true; window.ControllerDisconnected(); }
                    }
                    if (serviceStopped || !server.HasExited) return;
                    if (controlledLaunch)
                    {
                        monitor.Stop();
                        window.ServiceExitedWithDraft();
                        return;
                    }
                    monitor.Stop();
                    result = 1;
                    if (!controlledLaunch) MessageBox.Show(window, "本地服务已退出，聊天窗口将关闭。请重新启动并检查数据目录或端口。", "服务已停止", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
