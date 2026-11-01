using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class ChatForm : Form
{
    private HttpClient client;
    private readonly CancellationTokenSource closing = new CancellationTokenSource();
    private readonly SemaphoreSlim requestGate = new SemaphoreSlim(1, 1);
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 2000 };
    private readonly Dictionary<string, AgentData> agents = new Dictionary<string, AgentData>();
    private readonly List<MessageRow> messageRows = new List<MessageRow>();
    private readonly Dictionary<long, ConversationDraft> drafts = new Dictionary<long, ConversationDraft>();
    private readonly Dictionary<long, List<PendingAttachment>> attachmentDrafts = new Dictionary<long, List<PendingAttachment>>();
    private Button attachmentButton;
    private Label attachmentLabel;
    private ToolTip attachmentToolTip;
    private Button clearAttachmentButton;
    private Label pinnedLeaderboard;
    private bool loadingLeaderboard;
    private DateTime nextLeaderboardRefresh = DateTime.MinValue;
    private readonly StringBuilder transcript = new StringBuilder();
    private readonly Color ink = Color.FromArgb(27, 43, 62);
    private readonly Color muted = Color.FromArgb(116, 131, 148);
    private readonly Color green = Color.FromArgb(0, 139, 132);
    private ListView auditList, conversationList;
    private Form auditDialog;
    private Panel memberList;
    private SlimScrollBar memberScroll;
    private Label memberEmpty;
    private Button registrationButton, sendButton, newConversationButton;
    private ComboBox recipientBox;
    private TextBox messageInput;
    private HistoryPanel messageHistory;
    private Label groupTitle, groupSubtitle, memberSummary, memberHeading, auditEmpty, statusLabel, errorLabel, connectionLabel;
    private Button bulkApproveButton, bulkRevokeButton;
    private readonly Dictionary<string, MemberRow> memberRows = new Dictionary<string, MemberRow>();
    private MemberWheelFilter memberWheelFilter;
    private int memberScrollOffset, memberContentHeight;
    private bool layingOutMembers;
    private int hoverConversationIndex = -1;
    private bool hoverConversationDelete, suppressConversationSelection;
    private Panel loadingOverlay;
    private Label loadingLabel;
    private bool registrationOpen, connected, syncing, mutating, stopping, rendering;
    private long cursor, activeConversationId;
    private int messageCount, conversationCount;
    private bool browsingHistory, loadingHistory;
    private Button olderHistoryButton, newerHistoryButton;
    private string recipientsSignature = "";
    private bool handingOff;
    private int activeRequests;
    private bool uncertainOperation;
    private int uncertaintyRevision;
    private Button confirmUncertainButton;
    private string restoredWarning;
    private long restoredConversationId;

    public bool HandoffReady { get { return connected && activeConversationId > 0 && !syncing && (restoredConversationId == 0 || restoredConversationId == activeConversationId); } }
    public void HandoffAcknowledged() { restoredConversationId = 0; }
    public void FreezeCandidate() { Enabled = false; }
    public void ActivateCandidate() { Enabled = true; HandoffAcknowledged(); }
    public void CandidateRecoveryAvailable(Func<bool> recover)
    {
        poll.Stop();
        connected = false;
        SetStatus("更新中断 · 候选服务已停止，草稿保留", true);
        foreach (Control control in Controls) control.Enabled = false;
        Enabled = true;
        var button = Identify(new Button { Text = "确认旧窗口已关闭，重试恢复", AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Right, Location = new Point(Math.Max(0, ClientSize.Width - 230), 8) }, "RecoverCandidateButton", "确认旧窗口已关闭，重试恢复");
        button.Click += delegate
        {
            if (MessageBox.Show(this, "请确认旧窗口已关闭，再尝试恢复此窗口。", "恢复草稿", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            if (recover()) { Controls.Remove(button); button.Dispose(); foreach (Control control in Controls) control.Enabled = true; }
        };
        Controls.Add(button);
        button.BringToFront();
    }
    public void ControllerDisconnected()
    {
        MessageBox.Show(this, "更新控制器已断开，聊天窗口和草稿仍保留；关闭窗口将停止当前服务。", "更新控制器已断开", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    public void ServiceExitedWithDraft()
    {
        connected = false;
        poll.Stop();
        UpdateButtons();
        SetStatus("本地服务已停止 · 草稿仍保留，请先复制保存", true);
        MessageBox.Show(this, "本地服务意外退出。窗口和草稿仍保留，请先复制保存未发送内容；关闭本窗口会丢弃内存草稿。不会自动启动其他进程。", "服务已停止", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private static string HandoffString(Dictionary<string, object> state, string key, bool nullable)
    {
        object value;
        if (!state.TryGetValue(key, out value) || (value == null && !nullable) || (value != null && !(value is string)))
            throw new InvalidDataException("交接状态字段无效：" + key);
        return (string)value;
    }

    private static long HandoffInteger(Dictionary<string, object> state, string key)
    {
        object value;
        if (!state.TryGetValue(key, out value) || (!(value is int) && !(value is long)))
            throw new InvalidDataException("交接状态数字字段无效：" + key);
        return Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    private static IEnumerable<Dictionary<string, object>> HandoffRows(Dictionary<string, object> state, string key)
    {
        object value;
        if (!state.TryGetValue(key, out value) || !(value is System.Collections.IList)) throw new InvalidDataException("交接状态列表无效：" + key);
        foreach (object item in (System.Collections.IList)value)
        {
            var row = item as Dictionary<string, object>;
            if (row == null) throw new InvalidDataException("交接状态列表项无效：" + key);
            yield return row;
        }
    }

    public void RestoreHandoff(Dictionary<string, object> state)
    {
        if (state == null || HandoffInteger(state, "version") != 1 || String.IsNullOrWhiteSpace(HandoffString(state, "requestId", false)))
            throw new InvalidDataException("交接状态格式无效。");
        restoredConversationId = HandoffInteger(state, "activeConversationId");
        if (restoredConversationId <= 0) throw new InvalidDataException("交接当前对话标识无效。");
        var restoredDrafts = new Dictionary<long, ConversationDraft>();
        var restoredAttachments = new Dictionary<long, List<PendingAttachment>>();
        foreach (Dictionary<string, object> item in HandoffRows(state, "drafts"))
        {
            long id = HandoffInteger(item, "conversationId");
            if (id <= 0 || restoredDrafts.ContainsKey(id)) throw new InvalidDataException("交接草稿的对话标识无效或重复。");
            string draftText = HandoffString(item, "text", false);
            if (draftText.Length > 8000) throw new InvalidDataException("交接草稿超过输入长度限制。");
            restoredDrafts.Add(id, new ConversationDraft { Text = draftText, RecipientId = HandoffString(item, "recipientId", true) });
        }
        foreach (Dictionary<string, object> item in HandoffRows(state, "attachments"))
        {
            long id = HandoffInteger(item, "conversationId");
            string attachmentPath = HandoffString(item, "path", false);
            object uploadedId;
            if (id <= 0 || String.IsNullOrWhiteSpace(attachmentPath) || !item.TryGetValue("id", out uploadedId) || uploadedId != null)
                throw new InvalidDataException("交接附件无效或包含未确认的上传。");
            if (!restoredDrafts.ContainsKey(id)) throw new InvalidDataException("交接附件缺少所属对话草稿。");
            List<PendingAttachment> list;
            if (!restoredAttachments.TryGetValue(id, out list)) restoredAttachments[id] = list = new List<PendingAttachment>();
            if (list.Count >= 10) throw new InvalidDataException("单个对话的交接附件超过上限。");
            list.Add(new PendingAttachment { Path = attachmentPath, Id = null });
        }
        string warning = HandoffString(state, "warning", true);
        foreach (var pair in restoredDrafts) drafts.Add(pair.Key, pair.Value);
        foreach (var pair in restoredAttachments) attachmentDrafts.Add(pair.Key, pair.Value);
        restoredWarning = warning;
    }

    public void ResumeAfterHandoff()
    {
        if (!handingOff || stopping) return;
        handingOff = false;
        Enabled = true;
        poll.Start();
    }

    public async Task<object> PrepareHandoffAsync(string requestId)
    {
        if (handingOff || stopping) throw new InvalidOperationException("交接已开始。");
        if (!HandoffReady || String.IsNullOrWhiteSpace(requestId)) throw new InvalidOperationException("交接状态尚未就绪。");
        handingOff = true;
        poll.Stop();
        Enabled = false;
        try
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(25);
            while (mutating || syncing || loadingLeaderboard || loadingHistory || activeRequests != 0 || Application.OpenForms.Count > 1)
            {
                if (stopping || DateTime.UtcNow >= deadline) throw new InvalidOperationException("等待当前操作结束超时，已取消交接。");
                await Task.Delay(100);
            }
            Recipient recipient = recipientBox.SelectedItem as Recipient;
            if (activeConversationId > 0) drafts[activeConversationId] = new ConversationDraft { Text = messageInput.Text, RecipientId = recipient == null ? null : recipient.Id };
            if (uncertainOperation || (errorLabel.Visible && errorLabel.Text.Contains("未确认成功")))
                throw new InvalidOperationException("存在结果未确认的操作，请先核对后再更新。");
            foreach (var pair in attachmentDrafts) foreach (PendingAttachment item in pair.Value)
                if (item.Id != null || item.UploadUncertain) throw new InvalidOperationException("存在上传或发送结果未确认的附件，请先核对并处理草稿后再更新。");
            foreach (var pair in attachmentDrafts)
                if (!drafts.ContainsKey(pair.Key)) throw new InvalidOperationException("附件草稿缺少收件人状态，已取消交接。");
            var savedDrafts = new List<object>();
            foreach (var pair in drafts) savedDrafts.Add(new { conversationId = pair.Key, text = pair.Value.Text, recipientId = pair.Value.RecipientId });
            var savedAttachments = new List<object>();
            foreach (var pair in attachmentDrafts) foreach (PendingAttachment item in pair.Value)
                savedAttachments.Add(new { conversationId = pair.Key, path = item.Path, id = item.Id });
            string warning = errorLabel.Visible ? errorLabel.Text : restoredWarning;
            return new { version = 1, requestId = requestId, activeConversationId = activeConversationId, drafts = savedDrafts, attachments = savedAttachments, warning = warning };
        }
        catch
        {
            ResumeAfterHandoff();
            throw;
        }
    }
    public void ReconnectHandoff(string baseUrl, string adminToken)
    {
        var replacement = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false });
        replacement.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        replacement.Timeout = TimeSpan.FromSeconds(12);
        replacement.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        HttpClient previous = client;
        client = replacement;
        previous.Dispose();
        connected = false;
        ResumeAfterHandoff();
        if (!stopping) poll.Start();
    }


    public ChatForm(string baseUrl, string adminToken)
    {
        Text = "智能体本地聊天室";
        Name = "ChatForm";
        AccessibleName = Text;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        Font = new Font("Microsoft YaHei UI", 9F);
        ForeColor = ink;
        BackColor = Color.White;
        MinimumSize = new Size(1080, 700);
        Size = new Size(1360, 860);
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch (ArgumentException) { }
        catch (System.IO.IOException) { }
        var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
        client = new HttpClient(handler);
        client.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        client.Timeout = TimeSpan.FromSeconds(12);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        BuildWindow();
        WatchSystemPalette(this);
        UpdateSystemPalette(this);
        WireEvents();
        memberWheelFilter = new MemberWheelFilter(this);
        Application.AddMessageFilter(memberWheelFilter);
        UpdateButtons();
    }

    private static T Identify<T>(T control, string name, string accessible) where T : Control
    {
        control.Name = name;
        control.AccessibleName = accessible;
        return control;
    }

    private static bool HighContrast { get { return SystemInformation.HighContrast; } }

    private sealed class PaletteColors
    {
        public readonly Color Back, Fore;
        public PaletteColors(Control control) { Back = control.BackColor; Fore = control.ForeColor; }
    }

    private static readonly ConditionalWeakTable<Control, PaletteColors> normalPalette = new ConditionalWeakTable<Control, PaletteColors>();
    private bool paletteUpdatePending;

    private static void ApplySystemPalette(Control control)
    {
        normalPalette.GetValue(control, delegate(Control item) { return new PaletteColors(item); });
        foreach (Control child in control.Controls) ApplySystemPalette(child);
        bool input = control is TextBoxBase || control is ComboBox || control is ListView;
        control.BackColor = input ? SystemColors.Window : SystemColors.Control;
        control.ForeColor = input ? SystemColors.WindowText : SystemColors.ControlText;
        control.Invalidate();
    }

    private static void UpdateSystemPalette(Control control)
    {
        if (HighContrast) { ApplySystemPalette(control); return; }
        PaletteColors colors;
        bool changed = normalPalette.TryGetValue(control, out colors);
        if (changed)
        {
            control.BackColor = colors.Back;
            control.ForeColor = colors.Fore;
            normalPalette.Remove(control);
        }
        foreach (Control child in control.Controls) UpdateSystemPalette(child);
        if (changed) control.Invalidate();
    }

    private static void WatchSystemPalette(Control control)
    {
        control.ControlAdded += SystemPaletteControlAdded;
        foreach (Control child in control.Controls) WatchSystemPalette(child);
    }

    private static void SystemPaletteControlAdded(object sender, ControlEventArgs e)
    {
        WatchSystemPalette(e.Control);
        UpdateSystemPalette(e.Control);
    }

    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if ((message.Msg != 0x001A && message.Msg != 0x0015 && message.Msg != 0x031A) || recipientBox == null || paletteUpdatePending || IsDisposed || Disposing) return;
        // Coalesce the Windows settings/color/theme broadcasts after their caches update.
        paletteUpdatePending = true;
        BeginInvoke((MethodInvoker)delegate
        {
            paletteUpdatePending = false;
            if (!IsDisposed && !Disposing) UpdateSystemPalette(this);
        });
    }


    private Button MakeButton(string name, string text, bool primary)
    {
        var button = Identify(new ModernButton(primary), name, text);
        button.Text = text;
        button.AutoSize = false;
        button.MinimumSize = new Size(82, 32);
        button.Padding = new Padding(8, 2, 8, 2);
        button.Margin = new Padding(0, 0, 8, 6);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = primary ? green : Color.FromArgb(218, 222, 225);
        button.BackColor = primary ? green : Color.White;
        button.ForeColor = primary ? Color.White : ink;
        button.Cursor = Cursors.Hand;
        return button;
    }

    private Button MakeToolbarButton(string name, string text, bool featured, int width)
    {
        var button = Identify(new ModernButton(false, false, false, !featured), name, text);
        button.Text = text;
        button.Size = new Size(width, 34);
        button.MinimumSize = Size.Empty;
        button.Margin = new Padding(0, 0, 8, 0);
        button.Cursor = Cursors.Hand;
        return button;
    }

    private ListView MakeList(string name, params string[] columns)
    {
        var list = Identify(new RoundedListView(), name, name == "ConversationList" ? "历史对话列表" : "操作审计列表");
        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.MultiSelect = false;
        list.HideSelection = false;
        list.BorderStyle = BorderStyle.None;
        list.BackColor = Color.White;
        list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        list.ShowItemToolTips = true;
        foreach (string column in columns) list.Columns.Add(column, 100);
        return list;
    }

    private Button MakeDangerButton(string name, string text)
    {
        var button = Identify(new ModernButton(false, false, true), name, text);
        button.Text = text;
        button.AutoSize = false;
        button.MinimumSize = Size.Empty;
        button.Cursor = Cursors.Hand;
        return button;
    }

    private void BuildWindow()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Margin = Padding.Empty };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 310));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        Controls.Add(root);
        root.Controls.Add(BuildMembers(), 0, 0);
        var main = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));
        main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(24, 10, 22, 8), ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 408));
        heading.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        heading.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        groupTitle = Identify(new Label { Text = "本地协作群", Dock = DockStyle.Fill, Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), ForeColor = ink, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }, "GroupTitle", "本地协作群");
        groupSubtitle = new Label { Text = "人工指令 · 实时协作", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
        connectionLabel = Identify(new Label { Text = "●  正在连接", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleRight }, "ConnectionIndicator", "正在连接本机服务");
        var headingActions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = Padding.Empty, Padding = Padding.Empty };
        var scoringButton = MakeToolbarButton("ScoringButton", "工作证明", false, 96);
        scoringButton.Click += async delegate { await ShowScoringAsync(); await RefreshLeaderboardAsync(true); };
        var toolsButton = MakeToolbarButton("GroupToolsButton", "群工具", true, 88);
        toolsButton.Click += async delegate { await ShowGroupToolsAsync(); };
        var auditButton = MakeToolbarButton("AuditToggle", "操作审计", false, 96);
        auditButton.Click += delegate { ShowAuditDialog(); };
        var docButton = MakeToolbarButton("McpDocButton", "接入文档", false, 96);
        docButton.AccessibleName = "保存 MCP 接入文档";
        docButton.Margin = Padding.Empty;
        docButton.Click += delegate { SaveConnectionDocument(); };
        headingActions.Controls.Add(toolsButton);
        headingActions.Controls.Add(scoringButton);
        headingActions.Controls.Add(auditButton);
        headingActions.Controls.Add(docButton);
        heading.Controls.Add(groupTitle, 0, 0);
        heading.Controls.Add(groupSubtitle, 0, 1);
        heading.Controls.Add(connectionLabel, 1, 0);
        heading.Controls.Add(headingActions, 1, 1);
        main.Controls.Add(heading, 0, 0);
        var workspace = Identify(new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty }, "WorkspaceTabs", "群聊");
        workspace.Controls.Add(BuildChat());
        main.Controls.Add(workspace, 0, 1);
        root.Controls.Add(main, 1, 0);
        errorLabel = Identify(new Label { AutoSize = true, Dock = DockStyle.Fill, ForeColor = Color.FromArgb(177, 50, 40), BackColor = Color.FromArgb(255, 243, 240), Padding = new Padding(12, 6, 12, 6), Visible = false }, "ErrorLabel", "操作错误");
        root.Controls.Add(errorLabel, 0, 1);
        root.SetColumnSpan(errorLabel, 2);
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, BackColor = Color.FromArgb(249, 250, 251), Padding = new Padding(12, 0, 12, 0) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        statusLabel = Identify(new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Text = "正在连接…", ForeColor = muted, AutoEllipsis = true }, "StatusLabel", "正在连接…");
        var safety = new Label { Text = "同一系统账户不隔离 · 管理员可见私聊 · 不自动唤醒模型", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight, ForeColor = muted, AutoEllipsis = true };
        safety.AccessibleName = safety.Text;
        footer.Controls.Add(statusLabel, 0, 0);
        footer.Controls.Add(safety, 1, 0);
        confirmUncertainButton = MakeButton("ConfirmUncertainButton", "核对未确认操作", false);
        confirmUncertainButton.AutoSize = true;
        confirmUncertainButton.Enabled = false;
        confirmUncertainButton.Click += delegate
        {
            if (!uncertainOperation || mutating || activeRequests != 0) return;
            int revision = uncertaintyRevision;
            if (MessageBox.Show(this, "请先核对所有未确认操作的实际结果，包括消息、附件和管理操作。确认后仅解除更新阻塞，不会重试、撤销或修改任何操作。\r\n\r\n确定已经完成核对？", "确认已核对", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            if (revision != uncertaintyRevision || mutating || activeRequests != 0) { MessageBox.Show(this, "核对期间又有操作发生，请重新核对。", "确认已核对", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            uncertainOperation = false;
            if (errorLabel.Visible && errorLabel.Text.Contains("未确认成功")) errorLabel.Visible = false;
            restoredWarning = null;
            confirmUncertainButton.Enabled = false;
            SetStatus("已人工确认未确认操作；不会自动重试。", false);
        };
        footer.Controls.Add(confirmUncertainButton, 2, 0);
        root.Controls.Add(footer, 0, 2);
        root.SetColumnSpan(footer, 2);
    }

    private Control BuildMembers()
    {
        var sidebar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 9, Padding = new Padding(16, 16, 14, 12), BackColor = Color.FromArgb(245, 248, 251), Margin = Padding.Empty };
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 34));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 66));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        var conversationActions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 1, Margin = new Padding(0, 0, 0, 4) };
        conversationActions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        newConversationButton = MakeButton("NewConversationButton", "新建对话", true);
        newConversationButton.Dock = DockStyle.Fill;
        newConversationButton.MinimumSize = Size.Empty;
        newConversationButton.Margin = Padding.Empty;
        conversationActions.Controls.Add(newConversationButton, 0, 0);
        sidebar.Controls.Add(conversationActions, 0, 0);
        sidebar.Controls.Add(new Label { Text = "历史对话", Dock = DockStyle.Fill, ForeColor = muted, Font = new Font(Font.FontFamily, 8.5F), TextAlign = ContentAlignment.MiddleLeft }, 0, 1);
        conversationList = MakeList("ConversationList", "对话");
        conversationList.HeaderStyle = ColumnHeaderStyle.None;
        conversationList.BackColor = Color.FromArgb(250, 252, 254);
        conversationList.Columns[0].Width = 250;
        conversationList.Columns.Add("", Scaled(26));
        conversationList.SmallImageList = new ImageList { ImageSize = new Size(1, Scaled(30)), ColorDepth = ColorDepth.Depth32Bit };
        conversationList.OwnerDraw = true;
        conversationList.DrawColumnHeader += delegate(object sender, DrawListViewColumnHeaderEventArgs args) { };
        conversationList.DrawItem += delegate(object sender, DrawListViewItemEventArgs args) { args.DrawDefault = false; };
        conversationList.DrawSubItem += DrawConversationSubItem;
        conversationList.MouseDown += ConversationMouseDown;
        conversationList.MouseMove += ConversationMouseMove;
        conversationList.MouseLeave += delegate { if (hoverConversationIndex != -1) { hoverConversationIndex = -1; conversationList.Invalidate(); } conversationList.Cursor = Cursors.Default; };
        conversationList.MouseUp += ConversationMouseUp;
        conversationList.KeyDown += ConversationKeyDown;
        conversationList.Resize += delegate { conversationList.Columns[0].Width = Math.Max(80, conversationList.ClientSize.Width - Scaled(26) - SystemInformation.VerticalScrollBarWidth); };
        sidebar.Controls.Add(conversationList, 0, 2);
        memberHeading = Identify(new Label { Text = "群成员", Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold), ForeColor = ink, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, "MemberHeading", "群成员");
        sidebar.Controls.Add(memberHeading, 0, 3);
        registrationButton = MakeButton("RegistrationButton", "开启新成员登记", false);
        registrationButton.Dock = DockStyle.Fill;
        registrationButton.Margin = new Padding(0, 2, 0, 4);
        sidebar.Controls.Add(registrationButton, 0, 4);
        memberSummary = new Label { Text = "正在读取成员…", Dock = DockStyle.Fill, ForeColor = muted, Font = new Font(Font.FontFamily, 8.5F), TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
        sidebar.Controls.Add(memberSummary, 0, 5);
        var memberHost = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(245, 248, 251), Margin = new Padding(0, 2, 0, 8) };
        memberList = Identify(new BufferedPanel { Dock = DockStyle.Fill, AutoScroll = false, BackColor = Color.FromArgb(245, 248, 251), Margin = Padding.Empty }, "AgentList", "群成员列表");
        memberList.AccessibleRole = AccessibleRole.Pane;
        memberList.Resize += delegate { LayoutMemberRows(); };
        memberScroll = new SlimScrollBar { Name = "MemberScrollBar", AccessibleName = "群成员列表滚动条" };
        memberScroll.Visible = false;
        memberScroll.ValueChanged += delegate { SetMemberScrollOffset(memberScroll.Value); };
        memberEmpty = new Label { Dock = DockStyle.Fill, Text = "暂无成员\r\n开启登记后，等待智能体申请", TextAlign = ContentAlignment.MiddleCenter, ForeColor = muted, BackColor = Color.FromArgb(245, 248, 251), AutoEllipsis = true, Visible = false };
        memberHost.Controls.Add(memberList);
        memberHost.Controls.Add(memberScroll);
        memberHost.Controls.Add(memberEmpty);
        memberEmpty.BringToFront();
        memberHost.Resize += delegate { LayoutMemberScrollbar(); };
        sidebar.Controls.Add(memberHost, 0, 6);
        var bulkActions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(0, 4, 0, 0), Margin = Padding.Empty };
        bulkApproveButton = MakeButton("BulkApproveButton", "全部批准", false);
        bulkApproveButton.AutoSize = false;
        bulkApproveButton.MinimumSize = Size.Empty;
        bulkApproveButton.Size = new Size(118, 32);
        bulkApproveButton.Margin = new Padding(0, 0, 8, 0);
        bulkRevokeButton = MakeDangerButton("BulkRevokeButton", "全部撤销");
        bulkRevokeButton.Size = new Size(118, 32);
        bulkRevokeButton.Margin = new Padding(0, 0, 0, 0);
        bulkActions.Controls.Add(bulkApproveButton);
        bulkActions.Controls.Add(bulkRevokeButton);
        sidebar.Controls.Add(bulkActions, 0, 7);
        sidebar.Controls.Add(new Label { Text = "禁言可读不可发 · 批量操作立即生效", Dock = DockStyle.Fill, ForeColor = muted, Font = new Font(Font.FontFamily, 8.5F), AutoEllipsis = true }, 0, 8);
        return sidebar;
    }

    private Control BuildChat()
    {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Margin = Padding.Empty };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 210));
        var collaboration = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 1, BackColor = Color.White, Padding = new Padding(20, 3, 10, 3) };
        collaboration.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        collaboration.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        pinnedLeaderboard = Identify(new Label { Text = "积分排行：正在加载…", Dock = DockStyle.Fill, ForeColor = ink, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft }, "PinnedLeaderboard", "积分排行：正在加载");
        collaboration.Controls.Add(pinnedLeaderboard, 0, 0);
        layout.Controls.Add(collaboration, 0, 0);
        var historyHost = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Color.FromArgb(240, 244, 248) };
        messageHistory = Identify(new HistoryPanel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(240, 244, 248), AutoScroll = true, Margin = Padding.Empty }, "MessageHistory", "尚无消息，发送第一条消息开始协作。");
        messageHistory.Resize += delegate { LayoutMessages(false); };
        loadingOverlay = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(240, 244, 248), Visible = false };
        loadingLabel = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = muted, Font = new Font(Font.FontFamily, 11F, FontStyle.Bold), Text = "正在加载对话…" };
        loadingOverlay.Controls.Add(loadingLabel);
        historyHost.Controls.Add(messageHistory);
        historyHost.Controls.Add(loadingOverlay);
        loadingOverlay.BringToFront();
        layout.Controls.Add(historyHost, 0, 1);
        var compose = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(24, 12, 24, 12), BackColor = Color.White, Margin = Padding.Empty };
        compose.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        compose.RowStyles.Add(new RowStyle(SizeType.Absolute, 27));
        compose.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        compose.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        var targetRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        targetRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 66));
        targetRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        targetRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        targetRow.Controls.Add(new Label { Text = "发送给", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = muted }, 0, 0);
        recipientBox = Identify(new RecipientComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.None, Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(246, 248, 251), ForeColor = ink, DropDownWidth = 480, DrawMode = DrawMode.OwnerDrawFixed }, "RecipientBox", "消息接收者");
        recipientBox.ItemHeight = Math.Max(18, recipientBox.Font.Height + 4);
        recipientBox.DrawItem += DrawRecipientItem;
        recipientBox.Items.Add(new Recipient(null, "广播 · 所有已批准成员", true));
        recipientBox.SelectedIndex = 0;
        var recipientFrame = new InputFrame { Dock = DockStyle.Fill, Padding = new Padding(4, 3, 4, 3), BackColor = recipientBox.BackColor, Margin = Padding.Empty };
        recipientFrame.Controls.Add(recipientBox);
        recipientFrame.Layout += delegate
        {
            Rectangle area = recipientFrame.DisplayRectangle;
            recipientBox.SetBounds(area.Left, area.Top, Math.Max(1, area.Width), recipientBox.PreferredHeight);
        };
        targetRow.Controls.Add(recipientFrame, 1, 0);
        compose.Controls.Add(targetRow, 0, 0);
        compose.Controls.Add(new Label { Text = "直接输入任务，广播或指定智能体；进度与结果在聊天中回复。", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }, 0, 1);
        var inputFrame = new InputFrame { Dock = DockStyle.Fill, Padding = new Padding(10, 7, 10, 7), Margin = new Padding(0, 0, 0, 8), BackColor = Color.FromArgb(250, 252, 254) };
        messageInput = Identify(new TextBox { Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, MaxLength = 8000, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = inputFrame.BackColor, Font = new Font(Font.FontFamily, 10.5F), Margin = Padding.Empty }, "MessageInput", "消息内容");
        inputFrame.Controls.Add(messageInput);
        compose.Controls.Add(inputFrame, 0, 2);
        var sendRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, Margin = Padding.Empty, Padding = Padding.Empty };
        sendRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        attachmentLabel = new Label { Text = "回车发送 / Ctrl+回车换行", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, Margin = Padding.Empty, AutoEllipsis = true };
        attachmentLabel.Name = "AttachmentSummary";
        attachmentToolTip = new ToolTip();
        attachmentLabel.Click += delegate { ShowAttachmentNames(); };
        var attachmentMenu = new ContextMenuStrip();
        attachmentMenu.Items.Add("清除已选附件", null, delegate { ClearAttachments(); });
        attachmentLabel.ContextMenuStrip = attachmentMenu;
        attachmentLabel.AccessibleDescription = "右键可清除尚未上传的附件草稿";
        sendRow.Controls.Add(attachmentLabel, 0, 0);
        clearAttachmentButton = MakeToolbarButton("ClearAttachmentButton", "清除", false, 80);
        clearAttachmentButton.Dock = DockStyle.Fill;
        clearAttachmentButton.Margin = new Padding(0, 0, 8, 0);
        clearAttachmentButton.Click += delegate { ClearAttachments(); };
        sendRow.Controls.Add(clearAttachmentButton, 1, 0);
        attachmentButton = MakeToolbarButton("AttachmentButton", "附件", true, 88);
        attachmentButton.Dock = DockStyle.Fill;
        attachmentButton.Margin = new Padding(0, 0, 12, 0);
        sendRow.Controls.Add(attachmentButton, 2, 0);
        sendButton = MakeButton("SendButton", "发送", true);
        sendButton.MinimumSize = Size.Empty;
        sendButton.Dock = DockStyle.Fill;
        sendButton.Margin = Padding.Empty;
        sendRow.Controls.Add(sendButton, 3, 0);
        compose.Controls.Add(sendRow, 0, 3);
        layout.Controls.Add(compose, 0, 2);
        return layout;
    }


    private Control BuildAudit()
    {
        var panel = new Panel { Dock = DockStyle.Fill };
        auditEmpty = new Label { Text = "正在读取审计…", Dock = DockStyle.Top, Height = 35, ForeColor = muted };
        auditList = MakeList("AuditList", "时间", "操作者", "操作", "对象");
        auditList.Columns[0].Width = 160;
        auditList.Columns[1].Width = 150;
        auditList.Columns[2].Width = 155;
        auditList.Columns[3].Width = 260;
        panel.Controls.Add(auditList);
        panel.Controls.Add(auditEmpty);
        return panel;
    }

    private void ShowAuditDialog()
    {
        if (auditDialog != null && !auditDialog.IsDisposed) { auditDialog.Activate(); return; }
        auditDialog = new Form { Name = "AuditDialog", Text = "操作审计", StartPosition = FormStartPosition.CenterParent, Size = new Size(840, 520), MinimumSize = new Size(640, 360), Font = Font, BackColor = Color.White, Padding = new Padding(18), ShowInTaskbar = false };
        auditDialog.Controls.Add(BuildAudit());
        auditList.Columns[0].Width = 165; auditList.Columns[1].Width = 140; auditList.Columns[2].Width = 150;
        auditList.Resize += delegate { if (auditList != null && !auditList.IsDisposed) auditList.Columns[3].Width = Math.Max(160, auditList.ClientSize.Width - 465); };
        auditDialog.FormClosed += delegate { auditList = null; auditEmpty = null; auditDialog = null; };
        WatchSystemPalette(auditDialog); UpdateSystemPalette(auditDialog);
        auditDialog.Show(this);
        if (!stopping) { var refresh = RefreshAsync(); }
    }

    private void WireEvents()
    {
        Shown += async delegate
        {
            Rectangle area = Screen.FromControl(this).WorkingArea;
            MinimumSize = new Size(Math.Min(MinimumSize.Width, area.Width), Math.Min(MinimumSize.Height, area.Height));
            Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
            poll.Start();
            SetConversationLoading(true, "正在连接");
            try { await RefreshAsync(); if (!String.IsNullOrEmpty(restoredWarning)) { errorLabel.Text = restoredWarning; errorLabel.AccessibleName = restoredWarning; errorLabel.Visible = true; } } finally { SetConversationLoading(false, null); }
        };
        poll.Tick += async delegate { await RefreshAsync(); };
        newConversationButton.Click += async delegate { await ChangeConversationAsync(0); };
        conversationList.SelectedIndexChanged += async delegate
        {
            if (rendering || mutating || suppressConversationSelection || !connected || conversationList.SelectedItems.Count == 0) return;
            long id;
            if (Int64.TryParse(conversationList.SelectedItems[0].Name, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id != activeConversationId)
                await ChangeConversationAsync(id);
        };
        recipientBox.SelectedIndexChanged += delegate { UpdateButtons(); };
        messageInput.TextChanged += delegate { UpdateButtons(); };
        registrationButton.Click += async delegate { await MutateAsync("api/admin/registration", new { open = !registrationOpen }, "登记状态已更新。", null); };
        bulkApproveButton.Click += async delegate { await BulkChangeAgentsAsync("approve"); };
        bulkRevokeButton.Click += async delegate
        {
            int count = memberRows.Count;
            if (count == 0) return;
            if (MessageBox.Show(this, "将撤销全部 " + count + " 名成员，并释放其未完成任务。此操作不可恢复，继续？", "全部撤销", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                await BulkChangeAgentsAsync("revoke");
        };
        sendButton.Click += async delegate { await SendMessageAsync(); };
        attachmentButton.Click += delegate { SelectAttachments(); };
        messageInput.KeyDown += async delegate(object sender, KeyEventArgs e)
        {
            if (e.KeyCode != Keys.Enter || e.Alt || e.Shift) return;
            e.SuppressKeyPress = true;
            if (e.Control)
                messageInput.SelectedText = "\r\n";
            else if (sendButton.Enabled)
                await SendMessageAsync();
        };
    }

    private void SaveConnectionDocument()
    {
        string source = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "MCP.md");
        if (!File.Exists(source))
        {
            errorLabel.Text = "未找到 MCP.md，请保留完整项目目录后重试。";
            errorLabel.AccessibleName = errorLabel.Text;
            errorLabel.Visible = true;
            return;
        }
        using (var dialog = new SaveFileDialog())
        {
            dialog.Title = "保存 MCP 接入文档";
            dialog.Filter = "Markdown 文档 (*.md)|*.md|所有文件 (*.*)|*.*";
            dialog.DefaultExt = "md";
            dialog.AddExtension = true;
            dialog.OverwritePrompt = true;
            dialog.FileName = "Agent本地聊天室-MCP连接文档.md";
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (Directory.Exists(desktop)) dialog.InitialDirectory = desktop;
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            try
            {
                File.Copy(source, dialog.FileName, true);
                errorLabel.Visible = false;
                statusLabel.Text = "接入文档已保存 · " + dialog.FileName;
                statusLabel.AccessibleName = statusLabel.Text;
                statusLabel.ForeColor = HighContrast ? SystemColors.ControlText : muted;
            }
            catch (Exception ex)
            {
                errorLabel.Text = "保存接入文档失败：" + FriendlyError(ex);
                errorLabel.AccessibleName = errorLabel.Text;
                errorLabel.Visible = true;
            }
        }
    }

    private async Task BulkChangeAgentsAsync(string action)
    {
        await MutateAsync("api/admin/agents/bulk", new { action = action }, action == "approve" ? "全部待审批成员已批准。" : "全部成员已撤销。", null);
    }

    private async Task ChangeAgentAsync(string id, string status)
    {
        if (String.IsNullOrEmpty(id)) return;
        await MutateAsync("api/admin/agents/" + Uri.EscapeDataString(id), new { status = status }, "成员状态已更新。", null);
    }

    private async Task ChangeConversationAsync(long id)
    {
        string title = id == 0 ? "新建对话" : (conversationList.SelectedItems.Count > 0 ? conversationList.SelectedItems[0].Text : null);
        SetConversationLoading(true, title);
        try
        {
            string path = id == 0 ? "api/admin/conversations" : "api/admin/conversations/" + id.ToString(CultureInfo.InvariantCulture) + "/activate";
            await MutateAsync(path, new Dictionary<string, object>(), id == 0 ? "已新建对话。" : "已切换对话。", delegate(Dictionary<string, object> result)
            {
                var conversation = result["conversation"] as Dictionary<string, object>;
                if (conversation == null) throw new ChatClientException("服务返回的对话信息无效。");
                rendering = true;
                try
                {
                    long selectedId = Number(result, "activeConversationId");
                    ApplyConversation(selectedId, Value(conversation, "title"));
                    string key = selectedId.ToString(CultureInfo.InvariantCulture);
                    if (!conversationList.Items.ContainsKey(key))
                    {
                        var item = new ListViewItem(groupTitle.Text) { Name = key, ToolTipText = groupTitle.Text };
                        item.SubItems.Add("");
                        conversationList.Items.Insert(0, item);
                    }
                    SelectConversationRow();
                }
                finally { rendering = false; }
            });
        }
        finally { SetConversationLoading(false, null); }
    }

    private void SetConversationLoading(bool loading, string title)
    {
        if (loadingOverlay == null || loadingLabel == null) return;
        string text = "正在加载对话…";
        if (loading && !String.IsNullOrWhiteSpace(title)) text += "\r\n" + title;
        loadingLabel.Text = text;
        loadingLabel.AccessibleName = text;
        loadingOverlay.Visible = loading;
        if (messageHistory != null) messageHistory.Enabled = !loading;
        if (loading) loadingOverlay.BringToFront();
    }

    private void ApplyConversation(long id, string title)
    {
        if (id <= 0) throw new ChatClientException("服务返回的当前对话标识无效。");
        if (activeConversationId != id)
        {
            SetConversationLoading(true, title);
            Recipient recipient = recipientBox.SelectedItem as Recipient;
            if (activeConversationId > 0)
                drafts[activeConversationId] = new ConversationDraft { Text = messageInput.Text, RecipientId = recipient == null ? null : recipient.Id };
            activeConversationId = id;
            pinnedLeaderboard.Text = "积分排行：正在加载…";
            nextLeaderboardRefresh = DateTime.MinValue;
            cursor = 0;
            messageCount = 0;
            browsingHistory = false;
            transcript.Clear();
            messageHistory.SuspendLayout();
            try
            {
                foreach (MessageRow row in messageRows) row.Dispose();
                messageRows.Clear();
                hiddenMessages = 0;
                if (olderHistoryButton != null) { messageHistory.Controls.Remove(olderHistoryButton); olderHistoryButton.Dispose(); olderHistoryButton = null; }
                if (newerHistoryButton != null) { messageHistory.Controls.Remove(newerHistoryButton); newerHistoryButton.Dispose(); newerHistoryButton = null; }
                if (foldNotice != null) { messageHistory.Controls.Remove(foldNotice); foldNotice.Dispose(); foldNotice = null; }
                messageHistory.AutoScrollMinSize = Size.Empty;
                messageHistory.AutoScrollPosition = Point.Empty;
                messageHistory.AccessibleName = "尚无消息，发送第一条消息开始协作。";
            }
            finally { messageHistory.ResumeLayout(true); }
            messageHistory.Invalidate();
            ConversationDraft draft;
            drafts.TryGetValue(id, out draft);
            messageInput.Text = draft == null ? "" : draft.Text;
            RenderRecipients(draft == null ? null : draft.RecipientId);
        }
        groupTitle.Text = title;
        groupTitle.AccessibleName = title;
    }

    private void SelectConversationRow()
    {
        string key = activeConversationId.ToString(CultureInfo.InvariantCulture);
        foreach (ListViewItem item in conversationList.Items)
            if (item.Selected != (item.Name == key)) item.Selected = item.Name == key;
        ListViewItem selected = conversationList.Items[key];
        if (selected != null) selected.EnsureVisible();
        conversationList.Invalidate();
    }


    private async Task ShowGroupToolsAsync()
    {
        long conversationId = activeConversationId;
        if (conversationId <= 0) return;
        try
        {
            Dictionary<string, object> discovered = await RequestAsync("api/group-tools", null);
            using (var dialog = new Form { Text = "群工具", StartPosition = FormStartPosition.CenterParent, Size = new Size(960, 700), MinimumSize = new Size(760, 560) })
            {
                var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new Padding(12) };
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 210)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                var catalog = new TreeView { Dock = DockStyle.Fill, HideSelection = false, BorderStyle = BorderStyle.None, AccessibleName = "群工具分类" };
                var vote = catalog.Nodes.Add("投票"); var game = catalog.Nodes.Add("游戏"); var payment = catalog.Nodes.Add("支付 · ERC-20"); var other = catalog.Nodes.Add("其他");
                foreach (Dictionary<string, object> tool in Rows(discovered, "tools"))
                {
                    string name = Value(tool, "name");
                    TreeNode parent = name.StartsWith("poll.", StringComparison.Ordinal) ? vote : name.StartsWith("game.", StringComparison.Ordinal) ? game : name.StartsWith("payment.", StringComparison.Ordinal) ? payment : other;
                    parent.Nodes.Add(new TreeNode(GroupToolTitle(name)) { Tag = tool });
                }
                catalog.ExpandAll();
                var detail = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(12, 0, 0, 0) };
                detail.RowStyles.Add(new RowStyle(SizeType.Absolute, 72)); detail.RowStyles.Add(new RowStyle(SizeType.Percent, 55)); detail.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); detail.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
                var description = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, Text = "选择投票、游戏或支付工具。所有操作属于打开本窗口时的对话；切换对话后写操作将被拒绝。" };
                var fields = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
                fields.Resize += delegate { foreach (Control row in fields.Controls) row.Width = Math.Max(200, fields.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 8); };
                var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
                var invoke = MakeButton("InvokeGroupTool", "执行", true); invoke.Enabled = false;
                var copy = MakeButton("CopyGroupToolResult", "复制结果", false);
                var newRequest = MakeButton("NewGroupToolRequest", "新请求", false);
                var copyPayment = MakeButton("CopyPaymentUri", "复制付款链接", false); copyPayment.AutoSize = true; copyPayment.Enabled = false;
                string paymentUri = null;
                var output = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, AccessibleName = "群工具结果" };
                actions.Controls.Add(invoke); actions.Controls.Add(newRequest); actions.Controls.Add(copy); actions.Controls.Add(copyPayment);
                detail.Controls.Add(description, 0, 0); detail.Controls.Add(fields, 0, 1); detail.Controls.Add(actions, 0, 2); detail.Controls.Add(output, 0, 3);
                layout.Controls.Add(catalog, 0, 0); layout.Controls.Add(detail, 1, 0); dialog.Controls.Add(layout);
                var inputs = new Dictionary<string, Control>(); var specs = new Dictionary<string, Dictionary<string, object>>();
                Dictionary<string, object> selected = null; string requestKey = null; bool running = false;
                Action invalidateResult = delegate { requestKey = null; paymentUri = null; copyPayment.Enabled = false; output.Clear(); };
                catalog.AfterSelect += delegate
                {
                    if (running) return;
                    selected = catalog.SelectedNode.Tag as Dictionary<string, object>;
                    invalidateResult();
                    while (fields.Controls.Count > 0) { Control old = fields.Controls[0]; fields.Controls.RemoveAt(0); old.Dispose(); }
                    inputs.Clear(); specs.Clear();
                    invoke.Enabled = selected != null;
                    if (selected == null) return;
                    description.Text = Value(selected, "description") + (Value(selected, "name").StartsWith("payment.", StringComparison.Ordinal) ? "\r\n非托管：不保存私钥、不自动转账；必须从填写的钱包付款。" : "");
                    object raw = null; var schema = selected.TryGetValue("inputSchema", out raw) ? raw as Dictionary<string, object> : null;
                    var properties = schema != null && schema.TryGetValue("properties", out raw) ? raw as Dictionary<string, object> : null;
                    if (properties == null) return;
                    foreach (var property in properties)
                    {
                        if (property.Key == "conversationId" || property.Key == "clientRequestId") continue;
                        var spec = property.Value as Dictionary<string, object>; if (spec == null) continue;
                        Control input;
                        object choices;
                        if (spec.TryGetValue("enum", out choices) && choices is System.Collections.IEnumerable)
                        {
                            var combo = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
                            foreach (object choice in (System.Collections.IEnumerable)choices) combo.Items.Add(Convert.ToString(choice, CultureInfo.InvariantCulture));
                            if (combo.Items.Count > 0) combo.SelectedIndex = 0;
                            combo.SelectedIndexChanged += delegate { invalidateResult(); };
                            input = combo;
                        }
                        else
                        {
                            bool multiline = Value(spec, "type") == "array";
                            var text = new TextBox { Dock = DockStyle.Fill, Multiline = multiline, ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None, MaxLength = 8000 };
                            text.TextChanged += delegate { invalidateResult(); };
                            input = text;
                        }
                        input.AccessibleName = GroupToolField(property.Key); inputs.Add(property.Key, input); specs.Add(property.Key, spec);
                        var fieldRow = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, Height = Value(spec, "type") == "array" ? 100 : 38, Width = Math.Max(200, fields.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 8), Margin = Padding.Empty };
                        fieldRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150)); fieldRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); fieldRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
                        fieldRow.Controls.Add(new Label { Text = GroupToolField(property.Key), Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0); fieldRow.Controls.Add(input, 1, 0); fields.Controls.Add(fieldRow);
                    }
                };
                invoke.Click += async delegate
                {
                    if (running || selected == null) return;
                    running = true; invoke.Enabled = false; catalog.Enabled = false; fields.Enabled = false;
                    paymentUri = null; copyPayment.Enabled = false; newRequest.Enabled = false; output.Clear();
                    try
                    {
                        var args = new Dictionary<string, object>(); object raw = null;
                        var schema = selected.TryGetValue("inputSchema", out raw) ? raw as Dictionary<string, object> : null;
                        var properties = schema != null && schema.TryGetValue("properties", out raw) ? raw as Dictionary<string, object> : null;
                        var required = new HashSet<string>();
                        if (schema != null && schema.TryGetValue("required", out raw) && raw is System.Collections.IEnumerable)
                            foreach (object item in (System.Collections.IEnumerable)raw) required.Add(Convert.ToString(item, CultureInfo.InvariantCulture));
                        if (properties != null && properties.ContainsKey("conversationId")) args.Add("conversationId", conversationId);
                        if (properties != null && properties.ContainsKey("clientRequestId")) { if (requestKey == null) requestKey = Guid.NewGuid().ToString("N"); args.Add("clientRequestId", requestKey); }
                        foreach (var pair in inputs)
                        {
                            string value = pair.Value.Text;
                            if (String.IsNullOrWhiteSpace(value) && !required.Contains(pair.Key)) continue;
                            string type = Value(specs[pair.Key], "type");
                            if (type == "integer") { long number; if (!Int64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number)) throw new ChatClientException(GroupToolField(pair.Key) + "必须是整数。"); args.Add(pair.Key, number); }
                            else if (type == "array") args.Add(pair.Key, value.Replace("\r", "").Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries));
                            else args.Add(pair.Key, value);
                        }
                        string name = Value(selected, "name");
                        if (name == "payment.configure" && MessageBox.Show(dialog, "收款网络、合约和地址必须准确；配置不会发起转账。确认保存？", "支付配置", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
                        var result = await RequestAsync("api/group-tools/invoke", new { name = name, arguments = args });
                        if (!dialog.IsDisposed)
                        {
                            output.Text = json.Serialize(result);
                            object value; var payload = result.TryGetValue("result", out value) ? value as Dictionary<string, object> : null;
                            var request = payload != null && payload.TryGetValue("request", out value) ? value as Dictionary<string, object> : null;
                            paymentUri = request == null ? null : Value(request, "paymentUri");
                            copyPayment.Enabled = !String.IsNullOrEmpty(paymentUri);
                        }
                    }
                    catch (Exception ex) { if (!dialog.IsDisposed) output.Text = FriendlyError(ex) + "\r\n请求不会自动重发；未改参数时再次执行沿用同一请求标识。"; }
                    finally { running = false; if (!dialog.IsDisposed) { invoke.Enabled = true; catalog.Enabled = true; fields.Enabled = true; newRequest.Enabled = true; } }
                };
                newRequest.Click += delegate { if (!running) { invalidateResult(); output.Text = "已开始新请求，下次执行将生成新的请求标识。"; } };
                copy.Click += delegate { if (!String.IsNullOrEmpty(output.Text)) { try { Clipboard.SetText(output.Text); } catch (System.Runtime.InteropServices.ExternalException) { MessageBox.Show(dialog, "剪贴板暂不可用，请稍后重试。"); } } };
                copyPayment.Click += delegate { if (!String.IsNullOrEmpty(paymentUri)) { try { Clipboard.SetText(paymentUri); } catch (System.Runtime.InteropServices.ExternalException) { MessageBox.Show(dialog, "剪贴板暂不可用，请稍后重试。"); } } };
                dialog.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running && !stopping) { e.Cancel = true; MessageBox.Show(dialog, "工具请求尚未完成，请等待结果后关闭。", "群工具"); } };
                WatchSystemPalette(dialog); UpdateSystemPalette(dialog);
                dialog.ShowDialog(this);
            }
        }
        catch (Exception ex) { if (!stopping) MessageBox.Show(this, FriendlyError(ex), "群工具", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static string GroupToolTitle(string name)
    {
        switch (name)
        {
            case "poll.create": return "创建投票"; case "poll.list": return "投票与统计"; case "poll.vote": return "投票 / 改票"; case "poll.close": return "结束投票";
            case "game.roll": return "掷骰子"; case "game.rps": return "石头剪刀布"; case "game.history": return "游戏记录";
            case "payment.configure": return "配置收款网络"; case "payment.config": return "查看收款配置"; case "payment.create": return "创建付款请求"; case "payment.list": return "付款请求记录"; case "payment.verify": return "核验链上付款";
            case "text.length": return "文本长度"; default: return name;
        }
    }

    private static string GroupToolField(string name)
    {
        switch (name)
        {
            case "question": return "投票问题"; case "options": return "选项（每行一个）"; case "pollId": return "投票编号"; case "optionIndex": return "选项序号（从0起）";
            case "count": return "骰子数量"; case "sides": return "骰子面数"; case "move": return "出拳";
            case "payerAddress": return "付款钱包地址";
            case "chainId": return "网络 chainId"; case "rpcUrl": return "HTTPS RPC 地址"; case "tokenAddress": return "代币合约地址"; case "recipientAddress": return "收款地址"; case "decimals": return "代币小数位"; case "symbol": return "代币符号"; case "confirmations": return "确认数"; case "amount": return "代币数量"; case "requestId": return "付款请求编号"; case "txHash": return "交易哈希"; case "text": return "文本"; default: return name;
        }
    }

    private async Task RefreshLeaderboardAsync(bool force)
    {
        long conversationId = activeConversationId;
        if (conversationId <= 0 || loadingLeaderboard || (!force && DateTime.UtcNow < nextLeaderboardRefresh)) return;
        loadingLeaderboard = true;
        try
        {
            Dictionary<string, object> result = await RequestAsync("api/scoring?conversationId=" + conversationId.ToString(CultureInfo.InvariantCulture), null);
            if (activeConversationId != conversationId || stopping) return;
            var text = new StringBuilder("积分排行：");
            int rank = 0;
            foreach (Dictionary<string, object> item in Rows(result, "leaderboard"))
            {
                if (rank > 0) text.Append("    ");
                rank++;
                text.Append(rank).Append(". ").Append(Value(item, "name")).Append(" ").Append(Value(item, "points")).Append("分");
            }
            if (rank == 0) text.Append("暂无积分");
            pinnedLeaderboard.Text = text.ToString();
            pinnedLeaderboard.AccessibleName = pinnedLeaderboard.Text;
        }
        catch (Exception)
        {
            if (activeConversationId == conversationId && !stopping)
            {
                pinnedLeaderboard.Text = "积分排行：加载失败，将自动重试";
                pinnedLeaderboard.AccessibleName = pinnedLeaderboard.Text;
            }
        }
        finally
        {
            loadingLeaderboard = false;
            if (activeConversationId == conversationId) nextLeaderboardRefresh = DateTime.UtcNow.AddSeconds(10);
        }
    }

    private async Task ShowScoringAsync()
    {
        long conversationId = activeConversationId;
        if (conversationId <= 0) return;
        using (var dialog = new Form { Text = "积分排行与随机审计", StartPosition = FormStartPosition.CenterParent, Size = new Size(700, 560), MinimumSize = new Size(520, 400) })
        {
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(12) };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            var heading = new Label { Text = "当前对话积分排行 / 审计轮次", Dock = DockStyle.Fill };
            var ranking = new RoundedListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, BorderStyle = BorderStyle.None };
            ranking.Columns.Add("成员", 230); ranking.Columns.Add("积分", 100); ranking.Columns.Add("审计次数", 100);
            var rounds = new RoundedListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = false, BorderStyle = BorderStyle.None };
            rounds.Columns.Add("轮次", 160); rounds.Columns.Add("抽中成员", 180); rounds.Columns.Add("得分", 80); rounds.Columns.Add("证据 / 理由", 220);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            var select = MakeButton("SelectAuditRound", "随机抽取", false);
            var award = MakeButton("AwardAuditRound", "为选中轮次评分", false); award.AutoSize = true;
            var refresh = MakeButton("RefreshScoring", "刷新", false);
            actions.Controls.Add(select); actions.Controls.Add(award); actions.Controls.Add(refresh);
            layout.Controls.Add(heading, 0, 0); layout.Controls.Add(ranking, 0, 1); layout.Controls.Add(rounds, 0, 2); layout.Controls.Add(actions, 0, 3);
            dialog.Controls.Add(layout);
            Func<Task> load = async delegate
            {
                Dictionary<string, object> result = await RequestAsync("api/scoring?conversationId=" + conversationId.ToString(CultureInfo.InvariantCulture), null);
                ranking.Items.Clear(); rounds.Items.Clear();
                foreach (Dictionary<string, object> item in Rows(result, "leaderboard"))
                    ranking.Items.Add(new ListViewItem(new string[] { Value(item, "name"), Value(item, "points"), Value(item, "audits") }));
                foreach (Dictionary<string, object> item in Rows(result, "rounds"))
                {
                    var entry = new ListViewItem(new string[] { Value(item, "roundKey"), Number(item, "id") == 0 ? "待抽取" : DisplayName(Value(item, "selectedAgentId")), Number(item, "id") == 0 ? "待抽取" : Value(item, "scoredAt") == "" ? "待评分" : Value(item, "points"), Value(item, "evidence") + " / " + Value(item, "rationale") });
                    entry.Tag = item; rounds.Items.Add(entry);
                }
            };
            refresh.Click += async delegate { try { await load(); } catch (Exception ex) { MessageBox.Show(dialog, FriendlyError(ex), "积分排行"); } };
            select.Click += async delegate
            {
                string key = rounds.SelectedItems.Count > 0 && Number((Dictionary<string, object>)rounds.SelectedItems[0].Tag, "id") == 0 ? Value((Dictionary<string, object>)rounds.SelectedItems[0].Tag, "roundKey") : PromptText(dialog, "随机审计", "轮次标识（相同标识返回同一次抽取）：", Guid.NewGuid().ToString("N"));
                if (String.IsNullOrWhiteSpace(key)) return;
                try { await RequestAsync("api/admin/scoring/rounds", new { conversationId = conversationId, roundKey = key }); await load(); }
                catch (Exception ex) { MessageBox.Show(dialog, FriendlyError(ex), "随机审计"); }
            };
            award.Click += async delegate
            {
                if (rounds.SelectedItems.Count == 0) return;
                var round = (Dictionary<string, object>)rounds.SelectedItems[0].Tag;
                if (Number(round, "id") == 0) { MessageBox.Show(dialog, "该轮次尚未抽取成员，请选中后点击随机抽取。"); return; }
                if (Value(round, "scoredAt") != "") { MessageBox.Show(dialog, "该轮次已评分。"); return; }
                string score = PromptText(dialog, "审计评分", "积分（0–100）：", "0");
                if (score == null) return;
                int points;
                if (!Int32.TryParse(score, out points) || points < 0 || points > 100) { MessageBox.Show(dialog, "积分必须为 0 至 100 的整数。"); return; }
                string evidence = PromptText(dialog, "审计评分", "工作量证据：", ""); if (String.IsNullOrWhiteSpace(evidence)) return;
                string rationale = PromptText(dialog, "审计评分", "评分理由：", ""); if (String.IsNullOrWhiteSpace(rationale)) return;
                try { await RequestAsync("api/admin/scoring/rounds/" + Number(round, "id").ToString(CultureInfo.InvariantCulture) + "/award", new { points = points, evidence = evidence, rationale = rationale }); await load(); }
                catch (Exception ex) { MessageBox.Show(dialog, FriendlyError(ex), "审计评分"); }
            };
            try { await load(); dialog.ShowDialog(this); }
            catch (Exception ex) { if (!stopping) MessageBox.Show(this, FriendlyError(ex), "积分排行"); }
        }
    }

    private static string PromptText(IWin32Window owner, string title, string label, string initial)
    {
        using (var dialog = new Form { Text = title, StartPosition = FormStartPosition.CenterParent, Size = new Size(500, 180), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false })
        {
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Padding = new Padding(12) };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            var frame = new InputFrame { Dock = DockStyle.Fill, Padding = new Padding(8, 5, 8, 5), BackColor = Color.White };
            var input = new TextBox { Dock = DockStyle.Fill, Text = initial, MaxLength = 8000, BorderStyle = BorderStyle.None, BackColor = frame.BackColor };
            frame.Controls.Add(input);
            var ok = new ModernButton(true) { Text = "确定", DialogResult = DialogResult.OK, Dock = DockStyle.Right, Width = 82 };
            layout.Controls.Add(new Label { Text = label, Dock = DockStyle.Fill }, 0, 0); layout.Controls.Add(frame, 0, 1); layout.Controls.Add(ok, 0, 2);
            dialog.Controls.Add(layout); dialog.AcceptButton = ok;
            return dialog.ShowDialog(owner) == DialogResult.OK ? input.Text : null;
        }
    }

    private sealed class PendingAttachment
    {
        public string Path;
        public object Id;
        public bool UploadUncertain;
    }

    private void ShowAttachmentNames()
    {
        List<PendingAttachment> pending;
        if (!attachmentDrafts.TryGetValue(activeConversationId, out pending) || pending.Count == 0) return;
        var names = new List<string>();
        foreach (PendingAttachment item in pending) names.Add(System.IO.Path.GetFileName(item.Path));
        MessageBox.Show(this, String.Join("\r\n", names.ToArray()), "已选择的附件", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void ClearAttachments()
    {
        if (mutating) return;
        List<PendingAttachment> pending;
        if (!attachmentDrafts.TryGetValue(activeConversationId, out pending)) return;
        if (pending.Exists(delegate(PendingAttachment item) { return item.Id != null || item.UploadUncertain; }))
        {
            if (uncertainOperation || MessageBox.Show(this, "请确认已核对消息及附件实际状态。移除仅清除本窗口草稿，不删除服务端附件，也不会重试发送。确定移除？", "移除已核对附件草稿", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        }
        attachmentDrafts.Remove(activeConversationId);
        UpdateButtons();
    }

    private void SelectAttachments()
    {
        if (activeConversationId <= 0) return;
        List<PendingAttachment> existing;
        if (attachmentDrafts.TryGetValue(activeConversationId, out existing) && existing.Exists(delegate(PendingAttachment item) { return item.Id != null || item.UploadUncertain; }))
        {
            MessageBox.Show(this, "已有附件上传但发送结果未确认。请先核对消息和未关联附件，避免覆盖草稿。", "附件");
            return;
        }
        using (var dialog = new OpenFileDialog { Title = "选择附件（最多 10 个，每个不超过 10 MiB）", Multiselect = true, CheckFileExists = true })
        {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            if (dialog.FileNames.Length > 10) { MessageBox.Show(this, "最多选择 10 个附件。", "附件"); return; }
            var selected = new List<PendingAttachment>();
            try
            {
                foreach (string path in dialog.FileNames)
                {
                    if (new FileInfo(path).Length > 10L * 1024 * 1024) throw new ChatClientException("附件不能超过 10 MiB：" + System.IO.Path.GetFileName(path));
                    selected.Add(new PendingAttachment { Path = path });
                }
                attachmentDrafts[activeConversationId] = selected;
                UpdateButtons();
            }
            catch (Exception ex) { MessageBox.Show(this, FriendlyError(ex), "附件", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
    }

    private static string AttachmentContentType(string path)
    {
        switch (System.IO.Path.GetExtension(path).ToLowerInvariant())
        {
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".mp4": return "video/mp4";
            case ".wav": return "audio/wav";
            case ".mp3": return "audio/mpeg";
            case ".m4a": return "audio/mp4";
            case ".ogg": return "audio/ogg";
            case ".webm": return "video/webm";
            case ".avi": return "video/x-msvideo";
            case ".mov": return "video/quicktime";
            case ".pdf": return "application/pdf";
            case ".txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    private async Task SendMessageAsync()
    {
        var target = recipientBox.SelectedItem as Recipient;
        long conversationId = activeConversationId;
        List<PendingAttachment> attachments;
        attachmentDrafts.TryGetValue(conversationId, out attachments);
        if (attachments != null && attachments.Exists(delegate(PendingAttachment item) { return item.UploadUncertain; }))
        { MessageBox.Show(this, "附件上传结果未确认。请核对后清除该附件草稿，再明确重新选择附件。", "附件上传未确认", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        if (conversationId <= 0 || target == null || !target.Available || (String.IsNullOrWhiteSpace(messageInput.Text) && (attachments == null || attachments.Count == 0))) return;
        string text = messageInput.Text;
        if (attachments == null || attachments.Count == 0)
        {
            await MutateAsync("api/messages", new { text = text, to = target.Id, conversationId = conversationId }, "消息已发送。", delegate(Dictionary<string, object> result)
            {
                if (activeConversationId == conversationId) { if (messageInput.Text == text) messageInput.Clear(); }
                else { ConversationDraft draft; if (drafts.TryGetValue(conversationId, out draft) && draft.Text == text) draft.Text = ""; }
            });
            return;
        }
        if (stopping || mutating || !connected) return;
        mutating = true;
        UpdateButtons();
        bool entered = false, applied = false, requestInFlight = false;
        try
        {
            await requestGate.WaitAsync(closing.Token);
            entered = true;
            var ids = new List<object>();
            foreach (PendingAttachment attachment in attachments)
            {
                if (attachment.Id == null)
                {
                    SetStatus("正在上传附件 · " + System.IO.Path.GetFileName(attachment.Path), false);
                    byte[] bytes = File.ReadAllBytes(attachment.Path);
                    if (bytes.Length > 10 * 1024 * 1024) throw new ChatClientException("附件不能超过 10 MiB。 ");
                    attachment.UploadUncertain = true;
                    requestInFlight = true;
                    Dictionary<string, object> uploaded = await RequestAsync("api/attachments", new { name = System.IO.Path.GetFileName(attachment.Path), contentType = AttachmentContentType(attachment.Path), data = Convert.ToBase64String(bytes) });
                    object item;
                    var metadata = uploaded.TryGetValue("attachment", out item) ? item as Dictionary<string, object> : null;
                    object uploadedId;
                    if (metadata == null || !metadata.TryGetValue("id", out uploadedId) || uploadedId == null) throw new ChatClientException("上传响应缺少附件标识。 ");
                    attachment.Id = uploadedId;
                    attachment.UploadUncertain = false;
                    requestInFlight = false;
                }
                ids.Add(attachment.Id);
            }
            requestInFlight = true;
            await RequestAsync("api/messages", new { text = text, to = target.Id, conversationId = conversationId, attachmentIds = ids });
            requestInFlight = false;
            applied = true;
            attachmentDrafts.Remove(conversationId);
            if (activeConversationId == conversationId && messageInput.Text == text) messageInput.Clear();
            errorLabel.Visible = false;
            await LoadStateAsync();
            SetStatus("已连接 · 消息已发送。", false);
        }
        catch (Exception ex)
        {
            if (!applied && requestInFlight) MarkUncertainOperation();
            if (!stopping)
            {
                if (applied || requestInFlight) connected = false;
                string detail = (applied ? "消息已发送，但刷新失败：" : requestInFlight ? "操作未确认成功（不会自动重试，请先查看最新状态）：" : "消息未发送，请检查附件后重试：") + FriendlyError(ex);
                errorLabel.Text = detail;
                errorLabel.AccessibleName = detail;
                errorLabel.Visible = true;
                SetStatus(applied || requestInFlight ? "操作异常 · 等待重新同步" : "发送准备失败 · 草稿已保留", true);
            }
        }
        finally
        {
            if (entered) requestGate.Release();
            mutating = false;
            if (!stopping) UpdateButtons();
        }
    }

    private async Task<Dictionary<string, object>> RequestAsync(string path, object body)
    {
        activeRequests++;
        try
        {
        using (var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, path))
        {
            if (body != null) request.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
            using (HttpResponseMessage response = await client.SendAsync(request, closing.Token))
            {
                string text = await response.Content.ReadAsStringAsync();
                closing.Token.ThrowIfCancellationRequested();
                Dictionary<string, object> result;
                try { result = json.Deserialize<Dictionary<string, object>>(text); }
                catch (ArgumentException) { throw new ChatClientException("服务返回的数据格式无效（HTTP " + (int)response.StatusCode + "）。"); }
                if (!response.IsSuccessStatusCode)
                    throw new ChatClientException("HTTP " + (int)response.StatusCode + " · " + ApiErrorText((int)response.StatusCode, result == null ? "" : Value(result, "error")));
                if (result == null) throw new ChatClientException("服务返回了空响应。");
                return result;
            }
        }
        }
        catch { if (body != null) MarkUncertainOperation(); throw; }
        finally { activeRequests--; }
    }

    private async Task RefreshAsync()
    {
        if (stopping || handingOff || syncing || mutating) return;
        syncing = true;
        bool entered = false;
        try
        {
            await requestGate.WaitAsync(closing.Token);
            entered = true;
            await LoadStateAsync();
        }
        catch (Exception ex)
        {
            if (!stopping) { connected = false; SetStatus("连接异常 · " + FriendlyError(ex), true); }
        }
        finally
        {
            if (entered) requestGate.Release();
            syncing = false;
            if (!stopping) { SetConversationLoading(false, null); UpdateButtons(); }
        }
    }

    private async Task MutateAsync(string path, object body, string success, Action<Dictionary<string, object>> committed)
    {
        if (stopping || handingOff || mutating || !connected) return;
        mutating = true;
        UpdateButtons();
        bool entered = false, applied = false;
        try
        {
            await requestGate.WaitAsync(closing.Token);
            entered = true;
            SetStatus("正在提交操作…", false);
            Dictionary<string, object> result = await RequestAsync(path, body);
            applied = true;
            if (committed != null) committed(result);
            errorLabel.Visible = false;
            await LoadStateAsync();
            SetStatus("已连接 · " + success, false);
        }
        catch (Exception ex)
        {
            if (!applied) MarkUncertainOperation();
            if (!stopping)
            {
                connected = false;
                string detail = (applied ? "操作已成功，但刷新失败：" : "操作未确认成功（不会自动重试，请先查看最新状态）：") + FriendlyError(ex);
                errorLabel.Text = detail;
                errorLabel.AccessibleName = detail;
                errorLabel.Visible = true;
                SetStatus("操作异常 · 等待重新同步", true);
            }
        }
        finally
        {
            if (entered) requestGate.Release();
            mutating = false;
            if (!stopping) UpdateButtons();
        }
    }

        private static void PerfLog(string message)
    {
        if (Environment.GetEnvironmentVariable("CHAT_PERF_LOG") != "1") return;
        try { File.AppendAllText(Path.Combine(Application.StartupPath, "perf.log"), DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine); } catch { }
    }

private async Task LoadStateAsync()
    {
        var perf = Stopwatch.StartNew();
        Dictionary<string, object> state = await RequestAsync("api/admin/state", null);
        PerfLog("phase state=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
        RenderState(state);
        await RefreshLeaderboardAsync(false);
        PerfLog("phase render=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
        long conversationId = activeConversationId;
        long snapshotLastId = cursor;
        var stateMessages = new List<Dictionary<string, object>>();
        foreach (Dictionary<string, object> item in Rows(state, "messages"))
        {
            if (Number(item, "conversationId") != conversationId) continue;
            stateMessages.Add(item);
            snapshotLastId = Math.Max(snapshotLastId, Number(item, "id"));
        }
        // First load: state already carries the newest 200 messages; render a tail of them
        // instead of replaying the entire history through /api/messages (the old slow path).
        if (cursor == 0 && stateMessages.Count > 0)
        {
            int tailStart = Math.Max(0, stateMessages.Count - 20);
            AppendMessages(stateMessages.GetRange(tailStart, stateMessages.Count - tailStart));
            cursor = snapshotLastId;
            if (messageRows.Count > 0) hiddenMessages = Math.Max(1, hiddenMessages);
            hiddenMessages += tailStart;
            PerfLog("phase append=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
        }
        // State contains only the latest 200 messages; traverse this conversation's independent cursor stream.
        do
        {
            Dictionary<string, object> page = await RequestAsync("api/messages?conversationId=" + conversationId.ToString(CultureInfo.InvariantCulture) + "&after=" + cursor.ToString(CultureInfo.InvariantCulture) + "&limit=200", null);
            if (activeConversationId != conversationId || Number(page, "conversationId") != conversationId)
                throw new ChatClientException("对话已变化，正在等待重新同步。");
            foreach (Dictionary<string, object> row in Rows(page, "messages"))
                if (Number(row, "conversationId") != conversationId) throw new ChatClientException("消息所属对话不一致，已停止载入。");
            long previousCursor = cursor;
            long next = Number(page, "cursor");
            int added = browsingHistory ? 0 : AppendMessages(Rows(page, "messages"));
            if (next < cursor || (added > 0 && next <= cursor)) throw new ChatClientException("消息游标未推进，已保留现有历史。");
            cursor = next;
            if (next <= previousCursor || cursor >= snapshotLastId || (!browsingHistory && added == 0)) break;
            SetStatus("正在载入完整历史 · " + messageCount + " 条", false);
            await Task.Yield();
            closing.Token.ThrowIfCancellationRequested();
        } while (true);
        if (messagesPendingLayout)
        {
            bool followAll = messageHistory.AtBottom || pendingOwnMessage;
            messagesPendingLayout = false;
            pendingOwnMessage = false;
            PerfLog("phase prelayout=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
            LayoutMessages(followAll);
            PerfLog("phase layout=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
        }
        connected = true;
        SetStatus("已连接 · " + messageCount + " 条消息 · " + DateTime.Now.ToString("T", CultureInfo.CurrentUICulture), false);
        SetConversationLoading(false, null);
        UpdateButtons();
        PerfLog("load rows=" + messageRows.Count.ToString(CultureInfo.InvariantCulture) + " count=" + messageCount.ToString(CultureInfo.InvariantCulture) + " ms=" + perf.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
    }

    private void RenderState(Dictionary<string, object> state)
    {
        rendering = true;
        try
        {
            long selectedId = Number(state, "activeConversationId");
            string title = null;
            var conversationRows = new List<string[]>();
            foreach (Dictionary<string, object> row in Rows(state, "conversations"))
            {
                conversationRows.Add(new string[] { Value(row, "id"), Value(row, "title"), "" });
                if (Number(row, "id") == selectedId) title = Value(row, "title");
            }
            if (title == null) throw new ChatClientException("当前对话不在历史列表中，请等待重新同步。");
            conversationCount = conversationRows.Count;
            hoverConversationIndex = -1;
            hoverConversationDelete = false;
            suppressConversationSelection = false;
            ReconcileList(conversationList, conversationRows);
            ApplyConversation(selectedId, title);
            SelectConversationRow();
            conversationList.Invalidate();
            registrationOpen = state.ContainsKey("registrationOpen") && Convert.ToBoolean(state["registrationOpen"], CultureInfo.InvariantCulture);
            registrationButton.Text = registrationOpen ? "关闭新成员登记" : "开启新成员登记";
            registrationButton.AccessibleName = registrationButton.Text;
            agents.Clear();
            int active = 0, pending = 0, mutedCount = 0;
            var visibleAgents = new List<AgentData>();
            foreach (Dictionary<string, object> row in Rows(state, "agents"))
            {
                var agent = new AgentData { Id = Value(row, "id"), Name = Value(row, "name"), Status = Value(row, "status"), Model = Value(row, "model") };
                agents.Add(agent.Id, agent);
                // Revoked identities stay resolvable for history and audit, but leave the member list.
                if (agent.Status == "revoked") continue;
                if (agent.Status == "active") active++;
                if (agent.Status == "pending") pending++;
                if (agent.Status == "paused") mutedCount++;
                visibleAgents.Add(agent);
            }
            visibleAgents.Sort(delegate(AgentData left, AgentData right)
            {
                int rank = MemberRank(left.Status).CompareTo(MemberRank(right.Status));
                return rank != 0 ? rank : StringComparer.CurrentCultureIgnoreCase.Compare(left.Name, right.Name);
            });
            ReconcileMembers(visibleAgents);
            memberHeading.Text = "群成员 · " + visibleAgents.Count;
            memberHeading.AccessibleName = memberHeading.Text;
            memberSummary.Text = visibleAgents.Count == 0 ? "暂无成员 · 开启登记后等待申请" : "已批准 " + active + " · 待审批 " + pending + " · 已禁言 " + mutedCount;
            groupSubtitle.Text = active + " 位可协作成员" + (mutedCount > 0 ? " · " + mutedCount + " 人禁言" : "") + "  /  " + (registrationOpen ? "登记开放" : "登记关闭") + "  /  管理员视图";
            RenderRecipients();
            if (auditDialog != null && !auditDialog.IsDisposed && auditList != null && auditEmpty != null)
            {
            var auditRows = new List<string[]>();
            foreach (Dictionary<string, object> row in Rows(state, "audit"))
                auditRows.Add(new string[] { Value(row, "id"), DateText(Value(row, "createdAt")), DisplayName(Value(row, "actor")), AuditActionText(Value(row, "action")), Value(row, "target") == "registration" ? "成员登记" : DisplayName(Value(row, "target")) });
            auditRows.Reverse();
            ReconcileList(auditList, auditRows);
            auditEmpty.Text = auditRows.Count == 0 ? "暂无操作记录。" : "最近 " + auditRows.Count + " 条审计记录（服务最多提供最近 200 条）";
            }
        }
        finally { rendering = false; }
    }

    private int ConversationDeleteLeft(int index)
    {
        return conversationList.Columns[0].Width;
    }

    private void DrawConversationSubItem(object sender, DrawListViewSubItemEventArgs e)
    {
        if (e.ColumnIndex == 0)
        {
            e.DrawDefault = true;
            return;
        }
        bool selected = e.Item.Selected;
        bool hovered = e.ItemIndex == hoverConversationIndex;
        bool canDelete = conversationCount > 1 && !mutating;
        Color back = selected ? Color.FromArgb(13, 148, 136) : hovered ? Color.FromArgb(234, 246, 244) : Color.FromArgb(250, 252, 254);
        if (HighContrast) back = selected || hovered ? SystemColors.Highlight : SystemColors.Window;
        using (var brush = new SolidBrush(back)) e.Graphics.FillRectangle(brush, e.Bounds);
        if (hovered && hoverConversationDelete && canDelete && !HighContrast)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(e.Bounds, Scaled(8)))
            using (var fill = new SolidBrush(Color.FromArgb(250, 228, 222)))
            {
                e.Graphics.FillPath(fill, path);
            }
        }
        Color glyph = !canDelete ? Color.FromArgb(196, 207, 216) : hovered && hoverConversationDelete ? Color.FromArgb(166, 72, 60) : selected ? Color.White : Color.FromArgb(150, 162, 173);
        if (HighContrast) glyph = !canDelete ? SystemColors.GrayText : selected || hovered ? SystemColors.HighlightText : SystemColors.WindowText;
        DrawConversationDeleteGlyph(e.Graphics, e.Bounds, glyph);
    }

    // 垃圾桶图标：桶身、桶盖、提手全部用 GraphicsPath 绘制，始终居中在对话行右侧 gutter 内。
    private void DrawConversationDeleteGlyph(Graphics graphics, Rectangle slot, Color color)
    {
        int width = Scaled(14);
        int height = Scaled(16);
        var box = new Rectangle(slot.Left + Math.Max(0, (slot.Width - width) / 2), slot.Top + Math.Max(0, (slot.Height - height) / 2), width, height);
        float unit = Math.Max(0.5f, box.Width / 14f);
        GraphicsState state = graphics.Save();
        try
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(color, Math.Max(1.5f, unit * 1.5f)))
            using (GraphicsPath handle = new GraphicsPath())
            using (GraphicsPath lid = new GraphicsPath())
            using (GraphicsPath body = new GraphicsPath())
            using (var fill = new SolidBrush(Color.FromArgb(24, color)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                handle.AddArc(new RectangleF(box.Left + unit * 5f, box.Top + unit * 1.5f, unit * 4f, unit * 6f), 180f, 180f);
                lid.AddLine(box.Left + unit * 1.5f, box.Top + unit * 4.5f, box.Left + unit * 12.5f, box.Top + unit * 4.5f);
                body.AddLine(box.Left + unit * 2.5f, box.Top + unit * 6f, box.Left + unit * 4f, box.Top + unit * 15.5f);
                body.AddLine(box.Left + unit * 4f, box.Top + unit * 15.5f, box.Left + unit * 10f, box.Top + unit * 15.5f);
                body.AddLine(box.Left + unit * 10f, box.Top + unit * 15.5f, box.Left + unit * 11.5f, box.Top + unit * 6f);
                body.AddLine(box.Left + unit * 11.5f, box.Top + unit * 6f, box.Left + unit * 2.5f, box.Top + unit * 6f);
                graphics.DrawPath(pen, handle);
                graphics.DrawPath(pen, lid);
                graphics.FillPath(fill, body);
                graphics.DrawPath(pen, body);
            }
        }
        finally
        {
            graphics.Restore(state);
        }
    }

    private ListViewItem ConversationItemAtGutter(int x, int y)
    {
        return conversationList.GetItemAt(Math.Max(1, conversationList.Columns[0].Width - 2), y);
    }

    private void ConversationMouseDown(object sender, MouseEventArgs e)
    {
        ListViewItem item = ConversationItemAtGutter(e.X, e.Y);
        suppressConversationSelection = item != null && e.Button == MouseButtons.Left && e.X >= ConversationDeleteLeft(item.Index);
    }

    private void ConversationMouseMove(object sender, MouseEventArgs e)
    {
        ListViewItem item = ConversationItemAtGutter(e.X, e.Y);
        int index = item == null ? -1 : item.Index;
        bool onDelete = item != null && e.X >= ConversationDeleteLeft(item.Index);
        if (index != hoverConversationIndex || onDelete != hoverConversationDelete)
        {
            int old = hoverConversationIndex;
            hoverConversationIndex = index;
            hoverConversationDelete = onDelete;
            if (old >= 0 && old < conversationList.Items.Count) conversationList.Invalidate(conversationList.GetItemRect(old));
            if (index >= 0) conversationList.Invalidate(conversationList.GetItemRect(index));
        }
        conversationList.Cursor = onDelete && conversationCount > 1 && !mutating ? Cursors.Hand : Cursors.Default;
    }

    private async void ConversationMouseUp(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left)
        {
            suppressConversationSelection = false;
            return;
        }
        ListViewItem item = ConversationItemAtGutter(e.X, e.Y);
        bool onDelete = item != null && e.X >= ConversationDeleteLeft(item.Index);
        bool suppressed = suppressConversationSelection;
        suppressConversationSelection = false;
        if (!onDelete)
        {
            if (suppressed) RestoreConversationSelection();
            return;
        }
        if (conversationCount <= 1 || mutating)
        {
            ShowConversationDeleteError();
            RestoreConversationSelection();
            return;
        }
        long id;
        if (!Int64.TryParse(item.Name, NumberStyles.None, CultureInfo.InvariantCulture, out id)) return;
        if (MessageBox.Show(this, "删除对话「" + item.Text + "」及其全部消息和任务？此操作不可恢复。", "删除对话", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
            await DeleteConversationAsync(id);
        else
            RestoreConversationSelection();
    }

    private async void ConversationKeyDown(object sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.Delete || conversationList.SelectedItems.Count == 0) return;
        e.Handled = true;
        e.SuppressKeyPress = true;
        if (conversationCount <= 1 || mutating)
        {
            ShowConversationDeleteError();
            return;
        }
        ListViewItem item = conversationList.SelectedItems[0];
        long id;
        if (!Int64.TryParse(item.Name, NumberStyles.None, CultureInfo.InvariantCulture, out id)) return;
        if (MessageBox.Show(this, "删除对话「" + item.Text + "」及其全部消息和任务？此操作不可恢复。", "删除对话", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
            await DeleteConversationAsync(id);
    }

    private void RestoreConversationSelection()
    {
        rendering = true;
        try { SelectConversationRow(); } finally { rendering = false; }
    }

    private void ShowConversationDeleteError()
    {
        errorLabel.Text = "至少需要保留一个对话，无法删除最后一个对话。";
        errorLabel.AccessibleName = errorLabel.Text;
        errorLabel.Visible = true;
    }

    private async Task DeleteConversationAsync(long id)
    {
        await MutateAsync("api/admin/conversations/" + id.ToString(CultureInfo.InvariantCulture) + "/delete", new Dictionary<string, object>(), "对话已删除。", delegate(Dictionary<string, object> result) { drafts.Remove(id); attachmentDrafts.Remove(id); });
    }

    private static int MemberRank(string status)
    {
        switch (status)
        {
            case "pending": return 0;
            case "paused": return 1;
            case "active": return 2;
            default: return 3;
        }
    }

    private void ReconcileMembers(List<AgentData> visible)
    {
        var retained = new HashSet<string>();
        memberList.SuspendLayout();
        try
        {
            foreach (AgentData agent in visible)
            {
                retained.Add(agent.Id);
                MemberRow row;
                if (!memberRows.TryGetValue(agent.Id, out row))
                {
                    row = new MemberRow(agent.Id);
                    row.Perform = delegate(string status) { var ignored = ChangeAgentAsync(row.AgentId, status); };
                    memberRows.Add(agent.Id, row);
                    memberList.Controls.Add(row);
                }
                row.UpdateMember(agent.Name, agent.Status, agent.Model, connected && !mutating && !stopping);
            }
            var removed = new List<string>();
            foreach (string id in memberRows.Keys)
                if (!retained.Contains(id)) removed.Add(id);
            foreach (string id in removed)
            {
                MemberRow row = memberRows[id];
                memberRows.Remove(id);
                memberList.Controls.Remove(row);
                row.Dispose();
            }
        }
        finally { memberList.ResumeLayout(true); }
        memberEmpty.Visible = visible.Count == 0;
        LayoutMemberRows();
    }

    private int Scaled(int value)
    {
        return (int)Math.Round(value * DeviceDpi / 96.0);
    }

    private void LayoutMemberRows()
    {
        if (memberList == null || layingOutMembers) return;
        layingOutMembers = true;
        try
        {
            int width = Math.Max(140, memberList.ClientSize.Width - Scaled(12));
            int gap = Scaled(8);
            int content = 0;
            foreach (Control control in memberList.Controls) content += control.Height + gap;
            memberContentHeight = Math.Max(0, content - gap);
            int limit = Math.Max(0, memberContentHeight - memberList.ClientSize.Height);
            if (memberScrollOffset > limit) memberScrollOffset = limit;
            if (memberScrollOffset < 0) memberScrollOffset = 0;
            int y = -memberScrollOffset;
            foreach (Control control in memberList.Controls)
            {
                control.SetBounds(0, y, width, control.Height);
                y += control.Height + gap;
            }
        }
        finally { layingOutMembers = false; }
        UpdateMemberScrollbar();
        LayoutMemberScrollbar();
    }

    private void SetMemberScrollOffset(int value)
    {
        int limit = Math.Max(0, memberContentHeight - memberList.ClientSize.Height);
        int clamped = Math.Min(Math.Max(0, value), limit);
        if (clamped == memberScrollOffset) return;
        memberScrollOffset = clamped;
        LayoutMemberRows();
    }

    private void ScrollMembers(int delta)
    {
        SetMemberScrollOffset(memberScrollOffset + delta);
    }

    private void LayoutMemberScrollbar()
    {
        if (memberScroll == null || memberScroll.Parent == null) return;
        int width = Scaled(9), pad = Scaled(1);
        memberScroll.SetBounds(memberScroll.Parent.ClientSize.Width - width - pad, pad, width, Math.Max(12, memberScroll.Parent.ClientSize.Height - pad * 2));
        if (memberScroll.Visible) memberScroll.BringToFront();
    }

    private void UpdateMemberScrollbar()
    {
        if (memberScroll == null || memberList == null) return;
        memberScroll.SetState(memberContentHeight, memberList.ClientSize.Height, memberScrollOffset);
    }

    private static void ReconcileList(ListView list, List<string[]> rows)
    {
        string selected = list.SelectedItems.Count == 0 ? null : list.SelectedItems[0].Name;
        string top = list.TopItem == null ? null : list.TopItem.Name;
        var retained = new HashSet<string>();
        list.BeginUpdate();
        try
        {
            for (int index = 0; index < rows.Count; index++)
            {
                string[] row = rows[index];
                retained.Add(row[0]);
                ListViewItem item = list.Items[row[0]];
                if (item == null)
                {
                    item = new ListViewItem(row[1]) { Name = row[0] };
                    for (int column = 2; column < row.Length; column++) item.SubItems.Add(row[column]);
                    list.Items.Insert(Math.Min(index, list.Items.Count), item);
                }
                else
                {
                    for (int column = 1; column < row.Length; column++)
                        if (item.SubItems[column - 1].Text != row[column]) item.SubItems[column - 1].Text = row[column];
                }
                item.ToolTipText = String.Join(" · ", row, 1, row.Length - 1);
            }
            for (int index = list.Items.Count - 1; index >= 0; index--)
                if (!retained.Contains(list.Items[index].Name)) list.Items.RemoveAt(index);
            if (selected != null && list.Items.ContainsKey(selected)) list.Items[selected].Selected = true;
            if (top != null && list.Items.ContainsKey(top)) list.TopItem = list.Items[top];
        }
        finally { list.EndUpdate(); list.Invalidate(); }
    }

    private void DrawRecipientItem(object sender, DrawItemEventArgs e)
    {
        if (e.Index < 0) { e.DrawBackground(); return; }
        Recipient item = recipientBox.Items[e.Index] as Recipient;
        string text = item == null ? string.Empty : item.Label;
        Rectangle bounds = e.Bounds;
        bounds.Inflate(-4, 0);
        bool selected = (e.State & DrawItemState.Selected) != 0;
        bool field = (e.State & DrawItemState.ComboBoxEdit) != 0;
        if (field && selected && !HighContrast)
        {
            e.Graphics.Clear(recipientBox.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle highlight = Rectangle.Inflate(e.Bounds, -1, -2);
            if (highlight.Width > 2 && highlight.Height > 2)
                using (GraphicsPath path = RoundedPath(highlight, Math.Min(Scaled(8), highlight.Height)))
                using (var brush = new SolidBrush(SystemColors.Highlight)) e.Graphics.FillPath(brush, path);
        }
        else e.DrawBackground();
        Color color = selected ? SystemColors.HighlightText : recipientBox.ForeColor;
        TextRenderer.DrawText(e.Graphics, text, e.Font == null ? recipientBox.Font : e.Font, bounds, color,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        if ((e.State & DrawItemState.Focus) != 0) e.DrawFocusRectangle();
    }

    private void RenderRecipients()
    {
        Recipient selected = recipientBox.SelectedItem as Recipient;
        string selectedId = selected == null ? null : selected.Id;
        RenderRecipients(selectedId);
    }

    private void RenderRecipients(string selectedId)
    {
        var options = new List<Recipient>();
        options.Add(new Recipient(null, "广播 · 所有已批准成员", true));
        foreach (AgentData agent in agents.Values)
            if (agent.Status == "active") options.Add(new Recipient(agent.Id, "定向 · " + agent.Name, true));
        if (selectedId != null && !options.Exists(delegate(Recipient option) { return option.Id == selectedId; }))
            options.Add(new Recipient(selectedId, "定向 · " + DisplayName(selectedId) + "（当前不可发送）", false));
        var signature = new StringBuilder();
        foreach (Recipient option in options) signature.Append(option.Id).Append('\n').Append(option.Label).Append('\n');
        signature.Append("selected:").Append(selectedId);
        Recipient current = recipientBox.SelectedItem as Recipient;
        if (signature.ToString() == recipientsSignature && current != null && current.Id == selectedId) return;
        recipientsSignature = signature.ToString();
        recipientBox.BeginUpdate();
        try
        {
            recipientBox.Items.Clear();
            int selection = 0;
            for (int index = 0; index < options.Count; index++)
            {
                recipientBox.Items.Add(options[index]);
                if (options[index].Id == selectedId) selection = index;
            }
            recipientBox.SelectedIndex = selection;
        }
        finally { recipientBox.EndUpdate(); recipientBox.Invalidate(); }
    }

    private async Task<byte[]> DownloadAttachmentAsync(string id, CancellationToken token)
    {
        activeRequests++;
        try
        {
            using (HttpResponseMessage response = await client.GetAsync("api/attachments/" + Uri.EscapeDataString(id), HttpCompletionOption.ResponseHeadersRead, token))
            {
                if (!response.IsSuccessStatusCode) throw new ChatClientException("附件下载失败（HTTP " + (int)response.StatusCode + "）。");
                if (response.Content.Headers.ContentLength > 10L * 1024 * 1024) throw new ChatClientException("附件超过 10 MiB。 ");
                using (Stream input = await response.Content.ReadAsStreamAsync())
                using (var output = new MemoryStream())
                {
                    byte[] buffer = new byte[81920];
                    int count;
                    while ((count = await input.ReadAsync(buffer, 0, buffer.Length, token)) != 0)
                    {
                        if (output.Length + count > 10L * 1024 * 1024) throw new ChatClientException("附件超过 10 MiB。 ");
                        output.Write(buffer, 0, count);
                    }
                    return output.ToArray();
                }
            }
        }
        finally { activeRequests--; }
    }

    private async Task SaveAttachmentAsync(string id, string name)
    {
        try
        {
            using (var dialog = new SaveFileDialog { FileName = System.IO.Path.GetFileName(name), Title = "保存附件" })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                byte[] bytes = await DownloadAttachmentAsync(id, closing.Token);
                string path = dialog.FileName;
                await Task.Run(delegate { File.WriteAllBytes(path, bytes); });
            }
        }
        catch (Exception ex) { if (!stopping) MessageBox.Show(this, FriendlyError(ex), "保存附件", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }



    private async Task ShowHistoryPageAsync(bool latest)
    {
        if (loadingHistory || stopping || activeConversationId <= 0 || messageRows.Count == 0) return;
        long conversationId = activeConversationId;
        long boundary;
        if (latest)
        {
            if (cursor == Int64.MaxValue) return;
            boundary = cursor + 1;
        }
        else if (!Int64.TryParse(messageRows[0].Name.Substring("Message_".Length), out boundary)) return;
        loadingHistory = true;
        if (olderHistoryButton != null) olderHistoryButton.Enabled = false;
        if (newerHistoryButton != null) newerHistoryButton.Enabled = false;
        bool entered = false;
        try
        {
            await requestGate.WaitAsync(closing.Token);
            entered = true;
            if (conversationId != activeConversationId) return;
            if (latest)
            {
                if (cursor == Int64.MaxValue) return;
                boundary = cursor + 1;
            }
            var page = await RequestAsync("api/messages?conversationId=" + conversationId.ToString(CultureInfo.InvariantCulture) + "&before=" + boundary.ToString(CultureInfo.InvariantCulture) + "&limit=20", null);
            if (conversationId != activeConversationId || Number(page, "conversationId") != conversationId) return;
            var rows = new List<Dictionary<string, object>>();
            foreach (Dictionary<string, object> item in Rows(page, "messages"))
            {
                if (Number(item, "conversationId") != conversationId || Number(item, "id") >= boundary)
                    throw new ChatClientException("历史消息数据不一致，已保留当前显示。");
                rows.Add(item);
            }
            if (rows.Count == 0 && !latest)
            {
                hiddenMessages = 0;
                LayoutMessages(false);
                SetStatus("已经是最早的消息。", false);
                return;
            }
            foreach (MessageRow row in messageRows) { messageHistory.Controls.Remove(row); row.Dispose(); }
            messageRows.Clear();
            long savedCursor = cursor;
            int savedCount = messageCount, transcriptLength = transcript.Length;
            cursor = 0;
            try { AppendMessages(rows); }
            finally { cursor = savedCursor; messageCount = savedCount; transcript.Length = transcriptLength; messageHistory.AccessibleName = transcript.ToString(); pendingOwnMessage = false; messagesPendingLayout = false; }
            browsingHistory = !latest;
            long earliest = Number(page, "earliest_available_id");
            hiddenMessages = rows.Count > 0 && (earliest <= 0 || Number(rows[0], "id") > earliest) ? 1 : 0;
            LayoutMessages(latest);
            if (!latest) messageHistory.AutoScrollPosition = Point.Empty;
            SetStatus(latest ? "已返回最新消息。" : "正在查看较早消息。", false);
        }
        catch (Exception ex) { if (!stopping && conversationId == activeConversationId) SetStatus("加载历史失败 · " + FriendlyError(ex), true); }
        finally
        {
            if (entered) requestGate.Release();
            loadingHistory = false;
            if (olderHistoryButton != null) olderHistoryButton.Enabled = true;
            if (newerHistoryButton != null) newerHistoryButton.Enabled = true;
        }
    }

    private int AppendMessages(IEnumerable<Dictionary<string, object>> rows)
    {
        int added = 0;
        messageHistory.SuspendLayout();
        try
        {
            foreach (Dictionary<string, object> data in rows)
            {
                long id = Number(data, "id");
                if (id <= cursor) continue;
                string from = Value(data, "from"), to = Value(data, "to");
                if (from == "admin") pendingOwnMessage = true;
                string name = DisplayName(from), text = Value(data, "text");
                bool routeKnown = data.ContainsKey("to");
                bool directed = routeKnown && !String.IsNullOrEmpty(to);
                string route = !routeKnown ? "路由未知" : directed ? "定向 · " + name + " → " + DisplayName(to) + "（管理员可见）" : "广播";
                long replyTo = Number(data, "replyTo");
                if (replyTo > 0) route += " · 回复 #" + replyTo.ToString(CultureInfo.InvariantCulture);
                object mentionedValue;
                var mentions = data.TryGetValue("mentions", out mentionedValue) ? mentionedValue as System.Collections.IEnumerable : null;
                if (mentions != null)
                {
                    var mentionedNames = new List<string>();
                    foreach (object mentioned in mentions) if (mentioned != null) mentionedNames.Add(DisplayName(Convert.ToString(mentioned, CultureInfo.InvariantCulture)));
                    if (mentionedNames.Count > 0) route += " · @ " + String.Join("、", mentionedNames.ToArray());
                }
                string time = DateText(Value(data, "createdAt"));
                var row = new MessageRow(id, name, route, time, text, from == "admin", directed, replyTo > 0, Font);
                foreach (Dictionary<string, object> attachment in Rows(data, "attachments"))
                {
                    string attachmentId = Value(attachment, "id"), attachmentName = Value(attachment, "name"), contentType = Value(attachment, "contentType");
                    if (String.IsNullOrEmpty(attachmentId)) continue;
                    row.AddAttachment(attachmentName, contentType, delegate(CancellationToken token) { return DownloadAttachmentAsync(attachmentId, token); }, async delegate { await SaveAttachmentAsync(attachmentId, attachmentName); });
                }
                messageRows.Add(row);
                messageHistory.Controls.Add(row);
                transcript.Append('#').Append(id).Append(' ').Append(time).Append(" · ").Append(name).Append(" · ").Append(route).AppendLine().AppendLine(text).AppendLine();
                messageCount++;
                added++;
            }
            if (added > 0)
            {
                messagesPendingLayout = true;
                // Hard cap before measuring: creating/measuring thousands of rows is what made
                // opening a long conversation slow.
                while (messageRows.Count > 30)
                {
                    MessageRow oldest = messageRows[0];
                    messageRows.RemoveAt(0);
                    messageHistory.Controls.Remove(oldest);
                    oldest.Dispose();
                    hiddenMessages++;
                }
                messageHistory.AccessibleName = transcript.ToString();
                if (loadingOverlay != null) loadingOverlay.Visible = false;
            }
        }
        finally { messageHistory.ResumeLayout(false); messageHistory.Invalidate(); }
        return added;
    }

    private bool layingOutMessages;
    private bool layoutQueued;
    private bool messagesPendingLayout;
    private bool pendingOwnMessage;
    private Label foldNotice;
    private int hiddenMessages;

    private void SafeBeginInvoke(Action action)
    {
        if (action == null || IsDisposed || !IsHandleCreated || !messageHistory.IsHandleCreated) return;
        try { BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    private void LayoutMessages(bool follow)
    {
        if (messageHistory == null || stopping) return;
        if (layingOutMessages) { layoutQueued = true; return; }
        layingOutMessages = true;
        int oldScroll = -messageHistory.AutoScrollPosition.Y;
        int width = Math.Max(260, messageHistory.ClientSize.Width - 2);
        int y = 12;
        messageHistory.SuspendLayout();
        try
        {
            messageHistory.AutoScrollPosition = Point.Empty;
            while (messageRows.Count > 30)
            {
                MessageRow dropped = messageRows[0];
                messageRows.RemoveAt(0);
                messageHistory.Controls.Remove(dropped);
                dropped.Dispose();
                hiddenMessages++;
            }
            foreach (MessageRow row in messageRows)
            {
                try { row.SetRowWidth(width); } catch { }
            }
            // Win32 child coordinates are 16-bit: rows below y=32767 collapse onto the same
            // line. Keep the rendered window under 30000px and drop the oldest rows first.
            long total = 0;
            foreach (MessageRow row in messageRows) total += Math.Max(1, row.Height);
            while (messageRows.Count > 1 && total + 14 > 30000)
            {
                int dropIndex = browsingHistory ? messageRows.Count - 1 : 0;
                MessageRow oldest = messageRows[dropIndex];
                total -= Math.Max(1, oldest.Height);
                messageRows.RemoveAt(dropIndex);
                messageHistory.Controls.Remove(oldest);
                oldest.Dispose();
                if (!browsingHistory) hiddenMessages++;
            }
            if (olderHistoryButton == null)
            {
                olderHistoryButton = MakeButton("OlderHistoryButton", "加载更早消息", false);
                olderHistoryButton.Click += async delegate { await ShowHistoryPageAsync(false); };
                messageHistory.Controls.Add(olderHistoryButton);
                newerHistoryButton = MakeButton("LatestHistoryButton", "返回最新消息", false);
                newerHistoryButton.Click += async delegate { await ShowHistoryPageAsync(true); };
                messageHistory.Controls.Add(newerHistoryButton);
            }
            olderHistoryButton.Visible = hiddenMessages > 0;
            newerHistoryButton.Visible = browsingHistory;
            if (olderHistoryButton.Visible || newerHistoryButton.Visible)
            {
                int buttonWidth = Math.Min(150, width / 2);
                olderHistoryButton.SetBounds(Math.Max(0, width / 2 - buttonWidth), 8, buttonWidth, 28);
                newerHistoryButton.SetBounds(width / 2, 8, buttonWidth, 28);
                y = 44;
            }
            if (foldNotice != null) foldNotice.Visible = false;
            foreach (MessageRow row in messageRows)
            {
                int rowHeight = Math.Max(1, row.Height);
                row.Location = new Point(0, y);
                y += rowHeight;
            }
            messageHistory.AutoScrollMinSize = new Size(0, y + 14);
        }
        finally
        {
            messageHistory.ResumeLayout(true);
            layingOutMessages = false;
            if (layoutQueued) { layoutQueued = false; SafeBeginInvoke(delegate { LayoutMessages(follow); }); }
        }
        // Scroll only after WinForms has recomputed the display rectangle and scrollbar range.
        messageHistory.AutoScrollPosition = new Point(0, follow ? Int32.MaxValue : oldScroll);
        messageHistory.Invalidate(true);
        SafeBeginInvoke(delegate
        {
            if (!stopping) { messageHistory.Invalidate(true); messageHistory.Refresh(); }
        });
    }


    private void UpdateButtons()
    {
        if (registrationButton == null || sendButton == null) return;
        bool ready = connected && !mutating && !stopping;
        newConversationButton.Enabled = ready;
        conversationList.Enabled = ready;
        messageInput.ReadOnly = mutating || activeConversationId <= 0;
        recipientBox.Enabled = ready && activeConversationId > 0;
        registrationButton.Enabled = ready;
        foreach (MemberRow row in memberRows.Values) row.SetEnabled(ready);
        int visibleMembers = 0, pendingMembers = 0;
        foreach (AgentData agent in agents.Values)
        {
            if (agent.Status == "revoked") continue;
            visibleMembers++;
            if (agent.Status == "pending") pendingMembers++;
        }
        bulkApproveButton.Enabled = ready && pendingMembers > 0;
        bulkRevokeButton.Enabled = ready && visibleMembers > 0;
        Recipient recipient = recipientBox.SelectedItem as Recipient;
        List<PendingAttachment> pending;
        int attachmentCount = attachmentDrafts.TryGetValue(activeConversationId, out pending) ? pending.Count : 0;
        attachmentButton.Enabled = ready && activeConversationId > 0;
        clearAttachmentButton.Enabled = !mutating && !stopping && attachmentCount > 0;
        if (attachmentCount == 0)
        {
            attachmentLabel.Text = "回车发送 / Ctrl+回车换行";
            attachmentLabel.AccessibleName = attachmentLabel.Text;
            attachmentLabel.AccessibleDescription = "尚未选择附件";
            attachmentToolTip.SetToolTip(attachmentLabel, "");
        }
        else
        {
            var names = new List<string>();
            foreach (PendingAttachment item in pending) names.Add(System.IO.Path.GetFileName(item.Path));
            string allNames = String.Join("\r\n", names.ToArray());
            attachmentLabel.Text = "附件：" + String.Join("、", names.ToArray());
            attachmentLabel.AccessibleName = "已选择 " + attachmentCount + " 个附件：" + String.Join("、", names.ToArray());
            attachmentLabel.AccessibleDescription = "点击查看全部文件名；右键清除附件草稿";
            attachmentToolTip.SetToolTip(attachmentLabel, allNames);
        }
        sendButton.Enabled = ready && activeConversationId > 0 && recipient != null && recipient.Available && (!String.IsNullOrWhiteSpace(messageInput.Text) || attachmentCount > 0);
    }

    private void MarkUncertainOperation()
    {
        uncertainOperation = true;
        uncertaintyRevision++;
        if (confirmUncertainButton != null) confirmUncertainButton.Enabled = true;
    }

    private void SetStatus(string text, bool error)
    {
        statusLabel.Text = text;
        statusLabel.AccessibleName = text;
        statusLabel.ForeColor = HighContrast ? SystemColors.ControlText : error ? Color.FromArgb(177, 50, 40) : muted;
        connectionLabel.Text = error ? "●  连接异常" : connected ? "●  本机已连接" : "●  正在连接";
        connectionLabel.AccessibleName = connectionLabel.Text;
        connectionLabel.ForeColor = HighContrast ? SystemColors.ControlText : error ? Color.FromArgb(177, 50, 40) : connected ? green : muted;
    }

    private static string FriendlyError(Exception error)
    {
        if (error is TaskCanceledException || error is OperationCanceledException) return "请求超时，请检查本机服务。";
        if (error is HttpRequestException) return "无法连接本机服务，请检查聊天室服务是否仍在运行。";
        if (error is ChatClientException) return error.Message;
        return "客户端处理请求时发生异常（错误代码 0x" + error.HResult.ToString("X8", CultureInfo.InvariantCulture) + "），请检查服务状态后重新打开聊天室。";
    }

    private sealed class ChatClientException : Exception
    {
        public ChatClientException(string message) : base(message) { }
    }

    private static string AuditActionText(string action)
    {
        switch (action)
        {
            case "conversation.create": return "新建对话";
            case "conversation.activate": return "切换对话";
            case "conversation.delete": return "删除对话";
            case "registration.open": return "开启成员登记";
            case "registration.close": return "关闭成员登记";
            case "agent.join": return "申请加入";
            case "agent.active": return "批准或解禁";
            case "agent.paused": return "禁言成员";
            case "agent.revoked": return "撤销成员";
            case "task.create": return "创建任务";
            case "task.claim": return "认领任务";
            case "task.release": return "释放任务";
            case "task.complete": return "完成任务";
            case "task.reopen": return "重新打开任务";
            default: return "其他操作";
        }
    }

    private static string ApiErrorText(int status, string error)
    {
        switch (error)
        {
            case "Agent not found.": return "成员不存在。";
            case "Recipient not found.": return "消息接收者不存在。";
            case "Recipient is not active.": return "接收者当前未获批准或已被禁言、撤销，请查看最新成员状态。";
            case "Agent status transition is not allowed.": return "当前成员状态不允许此操作，请查看最新成员状态。";
            case "A valid bearer token is required.": return "身份凭据无效或已失效，请关闭并重新打开聊天室。";
            case "Administrator authorization is required.": return "此操作需要管理员授权。";
            case "Agent is not active; administrator approval is required.": return "智能体尚未获准访问，需要管理员批准。";
            case "Agent is muted; write operations are not allowed.": return "成员已被禁言，暂不能发送消息或变更任务。";
            case "An agent identity is required.": return "此操作需要智能体身份。";
            case "Local Host required.": return "服务只允许本机访问。";
            case "Cross-origin requests are not allowed.": return "服务拒绝了跨来源请求。";
            case "New registration is closed.": return "新成员登记已关闭。";
            case "Name is already registered.": return "该名称已被登记。";
            case "Server is stopping.": return "服务正在停止。";
            case "Request body is too large.": return "提交内容过大。";
            case "Internal server error.": return "服务内部发生错误，操作结果未能确认。";
            case "Invalid agent id.": return "成员标识无效。";
            case "Invalid agent status.": return "成员状态参数无效。";
            case "open must be a boolean.": return "成员登记开关参数无效。";
        }
        if (error.StartsWith("text must ", StringComparison.Ordinal))
            return "消息内容必须为 1 至 8000 个字符，不能仅含空白或包含空字符。";
        switch (status)
        {
            case 400: return "请求参数或数据格式不符合服务要求。";
            case 401: return "身份认证失败，请重新打开聊天室。";
            case 403: return "服务拒绝访问，请检查当前身份权限。";
            case 404: return "请求的对象或接口不存在。";
            case 405: return "该接口不支持此次请求方式。";
            case 408: return "服务处理请求超时。";
            case 409: return "操作与当前状态冲突，请先查看最新状态。";
            case 413: return "提交内容超过服务允许的大小。";
            case 415: return "服务不支持此次请求的数据格式。";
            case 429: return "请求过于频繁，请稍后手动重试。";
            case 500: return "服务内部发生错误。";
            case 502: return "服务网关返回错误。";
            case 503: return "服务暂时不可用。";
            case 504: return "服务网关响应超时。";
            default: return "服务拒绝或未能完成请求，请根据状态码检查服务。";
        }
    }

    private string DisplayName(string id)
    {
        if (String.IsNullOrEmpty(id)) return "未分配";
        if (id == "admin") return "管理员";
        AgentData agent;
        return agents.TryGetValue(id, out agent) ? agent.Name : id;
    }

    private static string StatusName(string status)
    {
        switch (status)
        {
            case "pending": return "待审批";
            case "active": return "已批准";
            case "paused": return "已禁言";
            case "revoked": return "已撤销";
            default: return status;
        }
    }

    private static string Value(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : "";
    }

    private static long Number(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : 0;
    }

    private static IEnumerable<Dictionary<string, object>> Rows(Dictionary<string, object> data, string key)
    {
        object value;
        if (!data.TryGetValue(key, out value)) yield break;
        var collection = value as System.Collections.IEnumerable;
        if (collection == null) yield break;
        foreach (object item in collection)
        {
            var row = item as Dictionary<string, object>;
            if (row != null) yield return row;
        }
    }

    private static string DateText(string value)
    {
        DateTimeOffset time;
        if (DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out time))
            return time.ToLocalTime().ToString("G", CultureInfo.CurrentUICulture);
        long milliseconds;
        if (Int64.TryParse(value, out milliseconds))
        {
            try { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(milliseconds).ToLocalTime().ToString("G", CultureInfo.CurrentUICulture); }
            catch (ArgumentOutOfRangeException) { }
        }
        return value;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (e.Cancel) return;
        stopping = true;
        poll.Stop();
        closing.Cancel();
        client.CancelPendingRequests();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            stopping = true;
            if (attachmentToolTip != null) attachmentToolTip.Dispose();
            if (auditDialog != null) auditDialog.Dispose();
            if (memberWheelFilter != null) Application.RemoveMessageFilter(memberWheelFilter);
            poll.Dispose();
            closing.Cancel();
            client.Dispose();
            // The cancellation source and gate are retained until their in-flight continuations finish.
        }
        base.Dispose(disposing);
    }

    private sealed class AgentData { public string Id, Name, Status, Model; }
    private sealed class ConversationDraft { public string Text, RecipientId; }
    private sealed class Recipient
    {
        public readonly string Id, Label;
        public readonly bool Available;
        public Recipient(string id, string label, bool available) { Id = id; Label = label; Available = available; }
        public override string ToString() { return Label; }
    }

    // One member card with immediate approve/mute/revoke actions; revoked members never reach this control.
    private sealed class MemberRow : Panel
    {
        public readonly string AgentId;
        public Action<string> Perform;
        private readonly Label memberName;
        private readonly Label modelName;
        private readonly PillLabel badge;
        private readonly FlowLayoutPanel actions;
        private string status;

        public MemberRow(string agentId)
        {
            AgentId = agentId;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Color.White;
            Margin = Padding.Empty;
            Height = Dpi(84);
            memberName = new Label { AutoEllipsis = true, UseMnemonic = false, BackColor = Color.White, ForeColor = Color.FromArgb(27, 43, 62), Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
            modelName = new Label { AutoEllipsis = true, UseMnemonic = false, BackColor = Color.White, ForeColor = Color.FromArgb(118, 133, 148), Font = new Font("Microsoft YaHei UI", 8F), TextAlign = ContentAlignment.MiddleLeft };
            badge = new PillLabel();
            actions = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, BackColor = Color.White, Margin = Padding.Empty, Padding = Padding.Empty };
            Controls.Add(memberName);
            Controls.Add(modelName);
            Controls.Add(badge);
            Controls.Add(actions);
            if (HighContrast) ApplySystemPalette(this);
        }

        public void UpdateMember(string name, string agentStatus, string model, bool enabled)
        {
            memberName.Text = name;
            memberName.AccessibleName = name;
            modelName.Text = "模型 · " + (String.IsNullOrWhiteSpace(model) ? "未声明" : model);
            modelName.AccessibleName = modelName.Text;
            AccessibleName = name + " · " + StatusText(agentStatus) + " · " + modelName.Text;
            badge.SetStatus(agentStatus);
            if (status != agentStatus)
            {
                status = agentStatus;
                actions.Controls.Clear();
                if (agentStatus == "pending")
                {
                    AddAction("批准", "active", true, false);
                    AddAction("撤销", "revoked", false, true);
                }
                else if (agentStatus == "active")
                {
                    AddAction("禁言", "paused", false, false);
                    AddAction("撤销", "revoked", false, true);
                }
                else if (agentStatus == "paused")
                {
                    AddAction("解禁", "active", true, false);
                    AddAction("撤销", "revoked", false, true);
                }
            }
            SetEnabled(enabled);
            PerformLayout();
        }

        public void SetEnabled(bool enabled)
        {
            foreach (Control control in actions.Controls) control.Enabled = enabled;
        }

        private void AddAction(string text, string next, bool primary, bool danger)
        {
            var button = new ModernButton(primary, true, danger);
            var font = new Font("Microsoft YaHei UI", 9F);
            button.Name = "AgentAction_" + next + "_" + AgentId;
            button.Text = text;
            button.AccessibleName = text + " " + memberName.Text;
            button.AutoSize = false;
            button.MinimumSize = Size.Empty;
            button.Font = font;
            button.Size = new Size(Math.Max(Dpi(52), TextRenderer.MeasureText(text, font).Width + Dpi(20)), Dpi(28));
            button.Margin = new Padding(Dpi(8), 0, 0, 0);
            button.Cursor = Cursors.Hand;
            button.Click += delegate { Action<string> perform = Perform; if (perform != null) perform(next); };
            actions.Controls.Add(button);
        }

        private static string StatusText(string value)
        {
            switch (value)
            {
                case "pending": return "待审批";
                case "active": return "已批准";
                case "paused": return "已禁言";
                default: return value;
            }
        }

        private int Dpi(int value)
        {
            return (int)Math.Round(value * DeviceDpi / 96.0);
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            if (actions == null || memberName == null || badge == null || modelName == null) return;
            int pad = Dpi(12);
            Size actionSize = actions.GetPreferredSize(Size.Empty);
            int actionWidth = Math.Min(actionSize.Width, Math.Max(0, Width - Dpi(88)));
            actions.SetBounds(Width - pad - actionWidth, Dpi(28), actionWidth, actionSize.Height);
            memberName.SetBounds(pad, Dpi(6), Math.Max(Dpi(40), Width - pad * 2), Dpi(22));
            badge.SetBounds(pad, Dpi(31), badge.Width, badge.Height);
            modelName.SetBounds(pad, Dpi(60), Math.Max(Dpi(40), Width - pad * 2), Dpi(18));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 4 || Height < 4) return;
            e.Graphics.Clear(Parent == null ? Color.White : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), Dpi(12)))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Control : Color.White))
            using (var pen = new Pen(HighContrast ? SystemColors.ControlText : Color.FromArgb(226, 235, 242)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    private sealed class PillLabel : Label
    {
        private Color fill = Color.FromArgb(238, 242, 246);
        private Color textColor = Color.FromArgb(90, 105, 120);

        public PillLabel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            AutoSize = false;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 8F);
            Height = Dpi(20);
            Width = Dpi(48);
        }

        public void SetStatus(string status)
        {
            switch (status)
            {
                case "pending":
                    Text = "待审批";
                    fill = Color.FromArgb(232, 240, 252);
                    textColor = Color.FromArgb(37, 99, 168);
                    break;
                case "active":
                    Text = "已批准";
                    fill = Color.FromArgb(227, 245, 238);
                    textColor = Color.FromArgb(11, 107, 95);
                    break;
                case "paused":
                    Text = "已禁言";
                    fill = Color.FromArgb(255, 243, 224);
                    textColor = Color.FromArgb(154, 82, 0);
                    break;
                default:
                    Text = status;
                    fill = Color.FromArgb(238, 242, 246);
                    textColor = Color.FromArgb(90, 105, 120);
                    break;
            }
            Width = TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.NoPadding).Width + Dpi(16);
            Height = Dpi(20);
            Invalidate();
        }

        private int Dpi(int value)
        {
            return (int)Math.Round(value * DeviceDpi / 96.0);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? Color.White : Parent.BackColor);
            if (Width < 3 || Height < 3) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), Height - 1))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Highlight : fill))
            {
                e.Graphics.FillPath(brush, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, HighContrast ? SystemColors.HighlightText : textColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        }
    }

    private static GraphicsPath RoundedPath(Rectangle bounds, int diameter)
    {
        diameter = Math.Max(2, Math.Min(diameter, Math.Min(bounds.Width, bounds.Height)));
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private sealed class BufferedPanel : Panel
    {
        public BufferedPanel() { DoubleBuffered = true; }
    }

    private sealed class MemberWheelFilter : IMessageFilter
    {
        private const int WM_MOUSEWHEEL = 0x020A;
        private readonly ChatForm owner;

        public MemberWheelFilter(ChatForm form) { owner = form; }

        public bool PreFilterMessage(ref Message message)
        {
            if (message.Msg != WM_MOUSEWHEEL) return false;
            Panel list = owner.memberList;
            if (list == null || !list.IsHandleCreated || !list.Visible) return false;
            if (!list.RectangleToScreen(list.ClientRectangle).Contains(Cursor.Position)) return false;
            int delta = (short)((message.WParam.ToInt64() >> 16) & 0xFFFF);
            owner.ScrollMembers(delta > 0 ? -owner.Scaled(64) : owner.Scaled(64));
            return true;
        }
    }

    // Slim, flat scrollbar that replaces the native panel scrollbar in the member list.
    private sealed class SlimScrollBar : Control
    {
        private int maximum, large, value, dragOffset;
        private bool dragging, hovered;
        public event EventHandler ValueChanged;

        public SlimScrollBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Color.FromArgb(245, 248, 251);
            AccessibleRole = AccessibleRole.ScrollBar;
            AccessibleName = "成员列表滚动条";
            TabStop = false;
            Cursor = Cursors.Hand;
        }

        public int Value { get { return value; } }

        public void SetState(int contentHeight, int viewportHeight, int current)
        {
            maximum = Math.Max(0, contentHeight);
            large = Math.Max(1, viewportHeight);
            int limit = Math.Max(0, maximum - large);
            value = Math.Min(Math.Max(0, current), limit);
            bool needed = maximum > large + 1;
            if (Visible != needed) Visible = needed;
            Invalidate();
        }

        private int TrackHeight { get { return Math.Max(0, Height - Dpi(4)); } }

        private int ThumbHeight
        {
            get
            {
                int track = TrackHeight;
                if (track <= 0) return 0;
                if (maximum <= 0) return track;
                int height = (int)Math.Round((double)large / maximum * track);
                return Math.Max(Math.Min(Dpi(28), track), Math.Min(track, height));
            }
        }

        private int ThumbTop
        {
            get
            {
                int limit = maximum - large;
                int travel = Math.Max(0, TrackHeight - ThumbHeight);
                if (limit <= 0 || travel <= 0) return Dpi(2);
                return Dpi(2) + (int)Math.Round((double)value / limit * travel);
            }
        }

        private int Dpi(int amount)
        {
            return (int)Math.Round(amount * DeviceDpi / 96.0);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? Color.FromArgb(245, 248, 251) : Parent.BackColor);
            if (Width < 4 || Height < 8) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int pad = Dpi(1);
            var track = new Rectangle(pad, Dpi(2), Width - pad * 2, Height - Dpi(4));
            using (GraphicsPath path = RoundedPath(track, track.Width))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Window : Color.FromArgb(237, 243, 248)))
            {
                e.Graphics.FillPath(brush, path);
            }
            int thumbHeight = ThumbHeight;
            if (thumbHeight <= 0) return;
            var thumb = new Rectangle(pad, ThumbTop, Width - pad * 2, thumbHeight);
            Color fill = dragging ? Color.FromArgb(133, 156, 175) : hovered ? Color.FromArgb(165, 185, 202) : Color.FromArgb(193, 208, 220);
            if (HighContrast) fill = dragging || hovered ? SystemColors.Highlight : SystemColors.WindowText;
            using (GraphicsPath path = RoundedPath(thumb, thumb.Width))
            using (var brush = new SolidBrush(fill))
            {
                e.Graphics.FillPath(brush, path);
            }
        }

        private void SetValueFromThumbTop(int thumbTop)
        {
            int travel = TrackHeight - ThumbHeight;
            int limit = maximum - large;
            if (travel <= 0 || limit <= 0) return;
            int clamped = Math.Min(Math.Max(Dpi(2), thumbTop), Dpi(2) + travel);
            int next = (int)Math.Round((double)(clamped - Dpi(2)) / travel * limit);
            if (next == value) return;
            value = next;
            EventHandler handler = ValueChanged;
            if (handler != null) handler(this, EventArgs.Empty);
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            int top = ThumbTop, bottom = top + ThumbHeight;
            if (e.Y >= top && e.Y <= bottom)
            {
                dragging = true;
                dragOffset = e.Y - top;
                Capture = true;
            }
            else
            {
                SetValueFromThumbTop(e.Y - ThumbHeight / 2);
            }
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
            {
                SetValueFromThumbTop(e.Y - dragOffset);
                return;
            }
            bool inside = e.Y >= ThumbTop && e.Y <= ThumbTop + ThumbHeight;
            if (inside != hovered) { hovered = inside; Invalidate(); }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            dragging = false;
            Capture = false;
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hovered = false;
            Invalidate();
        }
    }

    // Keep the native combo's dropdown, keyboard and accessibility behavior; only
    // replace the collapsed-field paint that otherwise leaves a square native edge.
    private sealed class RecipientComboBox : ComboBox
    {
        protected override void WndProc(ref Message message)
        {
            base.WndProc(ref message);
            if (message.Msg == 0x0007 || message.Msg == 0x0008 || message.Msg == 0x000A || message.Msg == 0x0047 || message.Msg == 0x031A)
            { Invalidate(); return; }
            if (message.Msg != 0x000F && message.Msg != 0x0318) return; // WM_PAINT / WM_PRINTCLIENT
            if (Width < 3 || Height < 3) return;
            using (Graphics graphics = message.Msg == 0x0318 && message.WParam != IntPtr.Zero ? Graphics.FromHdc(message.WParam) : Graphics.FromHwnd(Handle))
            {
                bool selected = Focused && !DroppedDown;
                Color fill = HighContrast ? SystemColors.Window : BackColor;
                Color text = Enabled ? (HighContrast ? SystemColors.WindowText : ForeColor) : SystemColors.GrayText;
                graphics.Clear(fill);
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                int inset = Math.Max(2, (int)Math.Round(3.0 * DeviceDpi / 96.0));
                Rectangle field = Rectangle.Inflate(ClientRectangle, -inset, -inset);
                if (selected)
                {
                    fill = SystemColors.Highlight;
                    text = SystemColors.HighlightText;
                    using (GraphicsPath path = RoundedPath(field, Math.Max(4, inset * 3)))
                    using (var brush = new SolidBrush(fill)) graphics.FillPath(brush, path);
                }
                int arrowWidth = Math.Max(16, SystemInformation.VerticalScrollBarWidth);
                Rectangle label = new Rectangle(field.Left + inset, field.Top, Math.Max(0, field.Width - arrowWidth - inset), field.Height);
                TextRenderer.DrawText(graphics, GetItemText(SelectedItem), Font, label, text, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
                int x = Width - arrowWidth / 2 - inset, y = Height / 2;
                using (var pen = new Pen(text, Math.Max(1F, DeviceDpi / 96F)))
                {
                    graphics.DrawLine(pen, x - inset, y - 1, x, y + inset - 1);
                    graphics.DrawLine(pen, x, y + inset - 1, x + inset, y - 1);
                }
                if (selected && ShowFocusCues) ControlPaint.DrawFocusRectangle(graphics, Rectangle.Inflate(field, -1, -1), text, fill);
            }
        }
        protected override void OnSelectedIndexChanged(EventArgs e) { base.OnSelectedIndexChanged(e); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnDropDownClosed(EventArgs e) { base.OnDropDownClosed(e); Invalidate(); }
    }


    private sealed class ModernButton : Button
    {
        private readonly bool primary, compact, destructive, quiet;
        private bool hovered, pressed;
        public ModernButton(bool accent) : this(accent, false, false) { }
        public ModernButton(bool accent, bool small, bool danger) : this(accent, small, danger, false) { }
        public ModernButton(bool accent, bool small, bool danger, bool subdued)
        {
            primary = accent;
            compact = small;
            destructive = danger;
            quiet = subdued;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            UseVisualStyleBackColor = false;
            AccessibleRole = AccessibleRole.PushButton;
        }
        protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 3 || Height < 3) return;
            e.Graphics.Clear(Parent == null ? Color.White : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = primary ? Color.FromArgb(13, 148, 136) : Color.White;
            Color border = primary ? fill : Color.FromArgb(214, 226, 235);
            Color text = primary ? Color.White : Color.FromArgb(38, 61, 79);
            if (quiet) { fill = Color.FromArgb(246, 249, 251); border = fill; text = Color.FromArgb(66, 85, 103); }
            if (destructive) { fill = Color.FromArgb(253, 241, 237); border = Color.FromArgb(240, 209, 201); text = Color.FromArgb(176, 58, 46); }
            if (!Enabled)
            {
                fill = quiet ? (Parent == null ? Color.White : Parent.BackColor) : primary ? Color.FromArgb(220, 232, 234) : Color.FromArgb(243, 246, 248);
                border = fill; text = Color.FromArgb(133, 147, 160);
            }
            else if (pressed)
            {
                fill = primary ? Color.FromArgb(10, 124, 114) : destructive ? Color.FromArgb(250, 226, 220) : Color.FromArgb(226, 238, 243);
                border = primary ? fill : destructive ? Color.FromArgb(232, 191, 181) : Color.FromArgb(205, 220, 231);
            }
            else if (hovered)
            {
                fill = primary ? Color.FromArgb(20, 164, 150) : destructive ? Color.FromArgb(252, 234, 229) : Color.FromArgb(240, 247, 250);
                border = primary ? fill : destructive ? Color.FromArgb(236, 199, 190) : Color.FromArgb(195, 213, 226);
            }
            if (HighContrast)
            {
                bool highlight = Enabled && (primary || hovered || pressed);
                fill = highlight ? SystemColors.Highlight : SystemColors.Control;
                border = Enabled ? SystemColors.ControlText : SystemColors.GrayText;
                text = !Enabled ? SystemColors.GrayText : highlight ? SystemColors.HighlightText : SystemColors.ControlText;
            }
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), compact ? 10 : 12))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(border))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), text, fill);
        }
    }

    private sealed class RoundedListView : ListView
    {
        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width < 2 || Height < 2) return;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width, Height), Math.Max(2, (int)Math.Round(12.0 * DeviceDpi / 96.0))))
            {
                Region previous = Region;
                Region = new Region(path);
                if (previous != null) previous.Dispose();
            }
        }
    }

    private sealed class InputFrame : Panel
    {
        public InputFrame() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 3 || Height < 3) return;
            e.Graphics.Clear(Parent == null ? SystemColors.Control : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), Math.Max(2, (int)Math.Round(12.0 * DeviceDpi / 96.0))))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Window : BackColor))
            using (var pen = new Pen(HighContrast ? SystemColors.WindowText : Color.FromArgb(218, 228, 237)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    private sealed class HistoryPanel : Panel
    {
        public HistoryPanel() { DoubleBuffered = true; AccessibleRole = AccessibleRole.Pane; }
        public bool AtBottom { get { return !VerticalScroll.Visible || VerticalScroll.Value >= VerticalScroll.Maximum - VerticalScroll.LargeChange - 45; } }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Controls.Count != 0) return;
            int cardWidth = Math.Min(360, Math.Max(220, ClientSize.Width - 64));
            int cardHeight = 106;
            var card = new Rectangle((ClientSize.Width - cardWidth) / 2, (ClientSize.Height - cardHeight) / 2, cardWidth, cardHeight);
            if (card.Width < 4) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(card, 14))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Window : Color.White))
            using (var pen = new Pen(HighContrast ? SystemColors.WindowText : Color.FromArgb(226, 235, 242)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            using (var titleFont = new Font(Font.FontFamily, 10.5F, FontStyle.Bold))
            {
                TextRenderer.DrawText(e.Graphics, "暂无消息", titleFont, new Rectangle(card.Left, card.Top + 20, card.Width, 24), HighContrast ? SystemColors.WindowText : Color.FromArgb(52, 71, 91), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
            TextRenderer.DrawText(e.Graphics, "发送第一条消息，开始本机协作", Font, new Rectangle(card.Left, card.Top + 54, card.Width, 28), HighContrast ? SystemColors.WindowText : Color.FromArgb(137, 148, 160), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        protected override Point ScrollToControl(Control activeControl)
        {
            // A focused message/input must not drag the history back after an explicit append scroll.
            return AutoScrollPosition;
        }
    }

    private sealed class AvatarBadge : Label
    {
        public Color FillColor = Color.Gray;
        public AvatarBadge()
        {
            SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
            BackColor = Color.Transparent;
            ForeColor = Color.White;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), Math.Max(2, Math.Min(Width, Height))))
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Highlight : FillColor))
                e.Graphics.FillPath(brush, path);
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, HighContrast ? SystemColors.HighlightText : ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    private sealed class InlineAttachment : Panel
    {
        private static readonly SemaphoreSlim downloads = new SemaphoreSlim(3, 3);
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly SemaphoreSlim mediaGate = new SemaphoreSlim(1, 1);
        private readonly Func<CancellationToken, Task<byte[]>> download;
        private readonly bool image, video, audio;
        private readonly string name;
        private readonly Label status;
        private readonly PictureBox picture;
        private readonly System.Windows.Controls.MediaElement player;
        private System.Windows.Controls.Button videoPlay;
        private System.Windows.Controls.TextBlock videoDuration;
        private bool playing;
        private Panel audioCard;
        private Button audioPlay;
        private TrackBar audioProgress;
        private Label audioTime, audioName;
        private System.Windows.Forms.Timer audioTimer;
        private string file;
        private bool opened, started;

        public InlineAttachment(string name, string contentType, Func<CancellationToken, Task<byte[]>> download, Action save)
        {
            this.name = name;
            this.download = download;
            image = contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);
            video = contentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase);
            audio = contentType.StartsWith("audio/", StringComparison.OrdinalIgnoreCase);
            BackColor = Color.Transparent;
            var menu = new ContextMenuStrip();
            menu.Items.Add("保存原文件", null, delegate { save(); });
            ContextMenuStrip = menu;
            status = new Label { Dock = DockStyle.Bottom, Height = 24, AutoEllipsis = true, Text = image || video || audio ? "正在加载附件…" : "右键保存附件", ForeColor = Color.FromArgb(90, 95, 100) };
            Controls.Add(status);
            if (image)
            {
                picture = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, AccessibleName = "图片 " + name };
                picture.ContextMenuStrip = menu;
                Controls.Add(picture); picture.BringToFront();
            }
            if (audio || video)
            {
                player = new System.Windows.Controls.MediaElement {
                    LoadedBehavior = System.Windows.Controls.MediaState.Manual,
                    UnloadedBehavior = System.Windows.Controls.MediaState.Manual,
                    Stretch = System.Windows.Media.Stretch.Uniform
                };
                player.MediaOpened += delegate {
                    if (IsDisposed || lifetime.IsCancellationRequested) return;
                    if (!playing) { player.Pause(); player.IsMuted = false; }
                    if (videoDuration != null && player.NaturalDuration.HasTimeSpan) videoDuration.Text = player.NaturalDuration.TimeSpan.ToString(@"mm\:ss");
                    UpdateAudioProgress();
                    if (opened) SetPlaybackState(playing ? "正在播放" : "点击播放", !playing, playing, playing);
                };
                player.MediaEnded += delegate { if (!IsDisposed && opened) { player.Stop(); playing = false; if (audioTimer != null) audioTimer.Stop(); UpdateAudioProgress(); if (videoPlay != null) videoPlay.Visibility = System.Windows.Visibility.Visible; if (opened) SetPlaybackState("播放完毕", true, false, false); } };
                player.MediaFailed += delegate(object sender, System.Windows.ExceptionRoutedEventArgs e) {
                    if (!IsDisposed && !lifetime.IsCancellationRequested) { opened = false; playing = false; if (audioTimer != null) audioTimer.Stop(); SetPlaybackState("播放失败：" + e.ErrorException.Message + "；可保存原文件。", false, false, false); }
                };
                System.Windows.UIElement content = player;
                if (video)
                {
                    var grid = new System.Windows.Controls.Grid();
                    grid.Children.Add(player);
                    videoPlay = new System.Windows.Controls.Button { Content = "▶", Width = 48, Height = 48, Opacity = 0.85, HorizontalAlignment = System.Windows.HorizontalAlignment.Center, VerticalAlignment = System.Windows.VerticalAlignment.Center, IsEnabled = false, ToolTip = "播放视频" };
                    var template = new System.Windows.Controls.ControlTemplate(typeof(System.Windows.Controls.Button));
                    var circle = new System.Windows.FrameworkElementFactory(typeof(System.Windows.Controls.Border));
                    circle.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new System.Windows.CornerRadius(24));
                    circle.SetValue(System.Windows.Controls.Border.BackgroundProperty, System.Windows.Media.Brushes.DimGray);
                    var symbol = new System.Windows.FrameworkElementFactory(typeof(System.Windows.Controls.ContentPresenter));
                    symbol.SetValue(System.Windows.FrameworkElement.HorizontalAlignmentProperty, System.Windows.HorizontalAlignment.Center);
                    symbol.SetValue(System.Windows.FrameworkElement.VerticalAlignmentProperty, System.Windows.VerticalAlignment.Center);
                    circle.AppendChild(symbol);
                    template.VisualTree = circle;
                    videoPlay.Foreground = System.Windows.Media.Brushes.White;
                    videoPlay.Template = template;
                    System.Windows.Automation.AutomationProperties.SetName(videoPlay, "播放视频 " + name);
                    videoPlay.Click += delegate { TogglePlayback(); };
                    grid.Children.Add(videoPlay);
                    videoDuration = new System.Windows.Controls.TextBlock { Foreground = System.Windows.Media.Brushes.White, Background = System.Windows.Media.Brushes.Black, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = System.Windows.VerticalAlignment.Bottom, Margin = new System.Windows.Thickness(4) };
                    grid.Children.Add(videoDuration);
                    var videoMenu = new System.Windows.Controls.ContextMenu();
                    var saveItem = new System.Windows.Controls.MenuItem { Header = "保存原文件" };
                    saveItem.Click += delegate { save(); };
                    videoMenu.Items.Add(saveItem);
                    grid.ContextMenu = videoMenu;
                    grid.Background = System.Windows.Media.Brushes.Transparent;
                    grid.MouseLeftButtonUp += delegate(object sender, System.Windows.Input.MouseButtonEventArgs e) { if (!e.Handled && e.OriginalSource != videoPlay) TogglePlayback(); };
                    content = grid;
                }
                var host = new System.Windows.Forms.Integration.ElementHost { Dock = video ? DockStyle.Fill : DockStyle.None, BackColor = Color.Black, Child = content, AccessibleName = (video ? "视频 " : "音频 ") + name };
                if (video) host.Resize += delegate {
                    if (host.Width <= 0 || host.Height <= 0) return;
                    using (GraphicsPath shape = RoundedPath(new Rectangle(0, 0, host.Width, host.Height), 12)) {
                        Region old = host.Region; host.Region = new Region(shape); if (old != null) old.Dispose();
                    }
                };
                if (!video) host.Size = new Size(1, 1);
                Controls.Add(host);
                if (video) host.BringToFront();
                if (audio)
                {
                    audioCard = new Panel { Dock = DockStyle.Fill, BackColor = Color.WhiteSmoke, ContextMenuStrip = menu };
                    audioPlay = new ModernButton(false, true, false) { Text = "▶", AccessibleName = "播放或暂停音频 " + name, ContextMenuStrip = menu, Enabled = false };
                    audioPlay.Click += delegate { TogglePlayback(); };
                    audioProgress = new TrackBar { Minimum = 0, Maximum = 1000, TickStyle = TickStyle.None, AutoSize = false, Enabled = false, AccessibleName = "音频播放进度 " + name, ContextMenuStrip = menu };
                    audioTime = new Label { Text = "0:00 / 0:00", AutoSize = false, TextAlign = ContentAlignment.MiddleRight, ForeColor = Color.FromArgb(90, 95, 100), ContextMenuStrip = menu };
                    audioName = new Label { Text = name, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.FromArgb(50, 55, 60), ContextMenuStrip = menu };
                    audioProgress.Scroll += delegate { SeekAudio(); };
                    audioCard.Controls.Add(audioPlay);
                    audioCard.Controls.Add(audioProgress);
                    audioCard.Controls.Add(audioTime);
                    audioCard.Controls.Add(audioName);
                    audioCard.Resize += delegate {
                        if (audioCard.Width <= 0 || audioCard.Height <= 0) return;
                        using (GraphicsPath shape = RoundedPath(new Rectangle(0, 0, audioCard.Width, audioCard.Height), 12)) {
                            Region old = audioCard.Region; audioCard.Region = new Region(shape); if (old != null) old.Dispose();
                        }
                        int buttonWidth = Math.Min(42, audioCard.Width);
                        int timeWidth = Math.Min(90, Math.Max(0, audioCard.Width - buttonWidth));
                        audioPlay.SetBounds(0, 0, buttonWidth, audioCard.Height);
                        audioName.SetBounds(buttonWidth, 2, Math.Max(0, audioCard.Width - buttonWidth - 8), Math.Max(0, audioCard.Height / 2 - 2));
                        audioTime.SetBounds(audioCard.Width - timeWidth - 4, audioCard.Height / 2, timeWidth, audioCard.Height - audioCard.Height / 2);
                        audioProgress.SetBounds(buttonWidth, Math.Max(0, audioCard.Height / 2 + (audioCard.Height / 2 - 24) / 2), Math.Max(0, audioCard.Width - buttonWidth - timeWidth - 4), 24);
                    };
                    audioTimer = new System.Windows.Forms.Timer { Interval = 250 };
                    audioTimer.Tick += delegate { UpdateAudioProgress(); };
                    Controls.Add(audioCard); audioCard.BringToFront();
                }
            }
        }

        public Action MediaSizeChanged;
        public Size PreferredMediaSize(int maxWidth, float scale)
        {
            if (!image || picture == null || picture.Image == null) return new Size(maxWidth, (int)((image || video ? 220 : audio ? 78 : 50) * scale));
            double ratio = Math.Min(1.0, Math.Min((double)maxWidth / picture.Image.Width, (300.0 * scale) / picture.Image.Height));
            return new Size(Math.Max(1, (int)Math.Round(picture.Image.Width * ratio)), Math.Max(1, (int)Math.Round(picture.Image.Height * ratio)));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!started && (image || video || audio)) { started = true; LoadAsync(); }
        }

        private async void LoadAsync()
        {
            bool entered = false;
            try
            {
                await downloads.WaitAsync(lifetime.Token); entered = true;
                byte[] bytes = await download(lifetime.Token);
                if (bytes.Length > 10 * 1024 * 1024) throw new InvalidOperationException("附件超过 10 MiB，无法预览。");
                lifetime.Token.ThrowIfCancellationRequested();
                if (image)
                {
                    Image decoded = await Task.Run(delegate { using (var stream = new MemoryStream(bytes)) using (Image source = Image.FromStream(stream)) return new Bitmap(source); });
                    if (IsDisposed || lifetime.IsCancellationRequested) { decoded.Dispose(); return; }
                    picture.Image = decoded;
                    status.Visible = false;
                    AccessibleDescription = "图片预览";
                    if (MediaSizeChanged != null) MediaSizeChanged();
                }
                else
                {
                    string extension = System.IO.Path.GetExtension(name);
                    if (extension.Length > 10 || extension.Length < 2) extension = "";
                    foreach (char c in extension.Substring(Math.Min(1, extension.Length))) if (!Char.IsLetterOrDigit(c)) { extension = ""; break; }
                    string path = System.IO.Path.Combine(@"D:\OMP\temp\chat-media-preview", Guid.NewGuid().ToString("N") + extension);
                    await mediaGate.WaitAsync();
                    try
                    {
                        if (lifetime.IsCancellationRequested) return;
                        file = path;
                        await Task.Run(delegate { Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)); File.WriteAllBytes(path, bytes); });
                        if (lifetime.IsCancellationRequested || IsDisposed) return;
                        player.Source = new Uri(path, UriKind.Absolute);
                        opened = true;
                        if (videoPlay != null) videoPlay.IsEnabled = true;
                        player.IsMuted = true; player.Play();
                        SetPlaybackState("点击播放", true, false, false);
                    }
                    finally { mediaGate.Release(); }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { if (!IsDisposed && !lifetime.IsCancellationRequested) { status.Text = "预览失败：" + ex.Message + "；可保存原文件。"; status.Visible = true; } }
            finally { if (entered) downloads.Release(); }
        }

        private void SetPlaybackState(string text, bool canPlay, bool canPause, bool canStop)
        {
            status.Text = text;
            status.Visible = text.StartsWith("播放失败", StringComparison.Ordinal);
            AccessibleDescription = text;
            if (audioPlay != null) { audioPlay.Enabled = opened; audioPlay.Text = playing ? "Ⅱ" : "▶"; }
            if (audioProgress != null) audioProgress.Enabled = opened && player.NaturalDuration.HasTimeSpan && player.NaturalDuration.TimeSpan > TimeSpan.Zero;
            if (videoPlay != null) videoPlay.IsEnabled = opened;
        }

        private static string FormatAudioTime(TimeSpan value)
        {
            if (value < TimeSpan.Zero) value = TimeSpan.Zero;
            return ((int)value.TotalMinutes).ToString() + ":" + value.Seconds.ToString("00");
        }

        private void UpdateAudioProgress()
        {
            if (audioProgress == null || !opened) return;
            try
            {
                TimeSpan duration = player.NaturalDuration.HasTimeSpan ? player.NaturalDuration.TimeSpan : TimeSpan.Zero;
                TimeSpan position = player.Position;
                if (duration > TimeSpan.Zero && position > duration) position = duration;
                audioProgress.Enabled = duration > TimeSpan.Zero;
                if (!audioProgress.Capture) audioProgress.Value = duration > TimeSpan.Zero ? Math.Max(0, Math.Min(audioProgress.Maximum, (int)(position.TotalSeconds / duration.TotalSeconds * audioProgress.Maximum))) : 0;
                audioTime.Text = FormatAudioTime(position) + " / " + FormatAudioTime(duration);
            }
            catch (Exception ex) { AudioPlaybackFailed(ex); }
        }

        private void SeekAudio()
        {
            if (!opened || !player.NaturalDuration.HasTimeSpan) return;
            try
            {
                player.Position = TimeSpan.FromTicks((long)(player.NaturalDuration.TimeSpan.Ticks * ((double)audioProgress.Value / audioProgress.Maximum)));
                UpdateAudioProgress();
            }
            catch (Exception ex) { AudioPlaybackFailed(ex); }
        }

        private void AudioPlaybackFailed(Exception ex)
        {
            opened = false; playing = false;
            if (audioTimer != null) audioTimer.Stop();
            SetPlaybackState("播放失败：" + ex.Message + "；可保存原文件。", false, false, false);
        }

        private void TogglePlayback()
        {
            if (!opened) return;
            try
            {
                if (!playing) { player.IsMuted = false; player.Play(); playing = true; if (audioTimer != null) audioTimer.Start(); }
                else { player.Pause(); playing = false; if (audioTimer != null) audioTimer.Stop(); }
                if (videoPlay != null) videoPlay.Visibility = playing ? System.Windows.Visibility.Collapsed : System.Windows.Visibility.Visible;
                UpdateAudioProgress();
                if (opened) SetPlaybackState(playing ? "正在播放" : "已暂停", !playing, playing, playing);
            }
            catch (Exception ex) { AudioPlaybackFailed(ex); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                lifetime.Cancel();
                if (audioTimer != null) { audioTimer.Stop(); audioTimer.Dispose(); audioTimer = null; }
                opened = false;
                if (player != null) { player.Close(); player.Source = null; }
                if (picture != null && picture.Image != null) { Image old = picture.Image; picture.Image = null; old.Dispose(); }
                CleanupMediaAsync();
            }
            base.Dispose(disposing);
        }

        private async void CleanupMediaAsync()
        {
            await mediaGate.WaitAsync();
            try
            {
                string path = file;
                await Task.Run(delegate { try { if (path != null && File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { } });
            }
            finally { mediaGate.Release(); }
        }
    }

    private sealed class MessageRow : Panel
    {
        private readonly Label timestamp, sender, avatar;
        private readonly BubblePanel bubble;
        private readonly TextBox body;
        private readonly List<InlineAttachment> attachments = new List<InlineAttachment>();
        private readonly bool own;
        private readonly Font messageFont;
        private int lastWidth = -1;

        public MessageRow(long id, string name, string route, string time, string text, bool admin, bool directed, bool reply, Font uiFont)
        {
            DoubleBuffered = true;
            own = admin;
            Font = uiFont;
            Margin = Padding.Empty;
            Name = "Message_" + id;
            AccessibleName = name + " · " + route + " · " + text;
            timestamp = new Label { Text = time, ForeColor = Color.FromArgb(148, 153, 159), TextAlign = ContentAlignment.MiddleCenter };
            sender = new Label { Text = name + " · " + route, ForeColor = route.Contains(" · @ ") ? Color.FromArgb(24, 92, 174) : Color.FromArgb(111, 119, 126), AutoEllipsis = true, TextAlign = own ? ContentAlignment.MiddleRight : ContentAlignment.MiddleLeft };
            string initial = String.IsNullOrWhiteSpace(name) ? "?" : StringInfo.GetNextTextElement(name);
            avatar = new AvatarBadge { Text = own ? "我" : initial, FillColor = own ? Color.FromArgb(0, 139, 132) : AvatarColor(name), Font = new Font(uiFont.FontFamily, 12F, FontStyle.Bold) };
            Color bubbleColor = directed && reply ? Color.FromArgb(255, 235, 204) : directed ? (own ? Color.FromArgb(218, 232, 251) : Color.FromArgb(242, 229, 250)) : (own ? Color.FromArgb(213, 241, 233) : Color.White);
            // Retain the normal colors so leaving high contrast restores this existing row.
            bubble = new BubblePanel(bubbleColor);
            messageFont = new Font(uiFont.FontFamily, 10.5F);
            body = new TextBox { Name = "MessageText_" + id, AccessibleName = name + " · " + route + " · " + text, Text = text.Replace("\r\n", "\n").Replace("\n", "\r\n"), ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, BackColor = bubbleColor, ForeColor = Color.FromArgb(35, 39, 42), Font = messageFont, WordWrap = true, TabStop = true, ScrollBars = ScrollBars.None };
            bubble.Controls.Add(body);
            Controls.AddRange(new Control[] { timestamp, sender, avatar, bubble });
            if (HighContrast) ApplySystemPalette(this);
        }

        public void AddAttachment(string name, string contentType, Func<CancellationToken, Task<byte[]>> download, Action save)
        {
            var attachment = new InlineAttachment(name, contentType, download, save);
            attachment.MediaSizeChanged = delegate { lastWidth = -1; ChatForm form = FindForm() as ChatForm; if (form != null) form.LayoutMessages(false); };
            attachments.Add(attachment);
            Controls.Add(attachment);
        }

        public void SetRowWidth(int width)
        {
            if (lastWidth == width) return;
            lastWidth = width;
            Width = width;
            float scale;
            using (Graphics graphics = CreateGraphics()) scale = graphics.DpiX / 96F;
            int avatarSize = (int)(26 * scale), edge = (int)(10 * scale), gap = (int)(6 * scale);
            int padV = (int)(8 * scale), padL = (int)(8 * scale), padR = own && !HighContrast ? 0 : (int)(8 * scale);
            int maxBody = Math.Max(110, Math.Min((int)(width * 0.94), width - edge - avatarSize - gap - padL - padR - 6));
            Size measured = TextRenderer.MeasureText(own ? body.Text : body.Text + " ", messageFont, new Size(maxBody, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix);
            int bodyWidth = Math.Min(maxBody, Math.Max(24, measured.Width + (own ? 1 : 4)));
            int attachmentWidth = Math.Min(maxBody, (int)(320 * scale));
            body.Width = bodyWidth;
            // Re-measure only when the bubble narrowed; for full-width text the first pass is exact.
            if (bodyWidth < maxBody)
                measured = TextRenderer.MeasureText(own ? body.Text : body.Text + " ", messageFont, new Size(bodyWidth, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix);
            int fullHeight = Math.Max(body.Font.Height + 4, measured.Height + body.Font.Height / 2 + 4);
            // TextRenderer over-estimates at non-96 DPI; the TextBox's own wrapped line count
            // is exact, which removes the empty band under short and long messages alike.
            try
            {
                if (body.IsHandleCreated && body.TextLength > 0)
                {
                    int lines = body.GetLineFromCharIndex(body.TextLength - 1) + 1;
                    bool plausible = lines > 1 || measured.Height <= body.Font.Height * 2 + 6;
                    if (plausible) fullHeight = Math.Max(body.Font.Height + 4, lines * body.Font.Height + 4);
                }
            }
            catch { }
            int bodyHeight = fullHeight;
            body.ScrollBars = ScrollBars.None;
            int attachmentHeight = 0;
            foreach (InlineAttachment attachment in attachments) attachmentHeight += attachment.PreferredMediaSize(attachmentWidth, scale).Height + gap;
            bool hasText = body.TextLength > 0;
            int bubbleWidth = bodyWidth + padL + padR, bubbleHeight = hasText ? bodyHeight + padV * 2 : 0;
            int top = (int)(23 * scale), nameHeight = (int)(22 * scale);
            int avatarX = own ? width - edge - avatarSize : edge;
            int bubbleX = own ? avatarX - gap - bubbleWidth : avatarX + avatarSize + gap;
            int mediaX = own ? avatarX - gap - attachmentWidth : avatarX + avatarSize + gap;
            timestamp.SetBounds(0, 0, width, (int)(20 * scale));
            avatar.SetBounds(avatarX, top + nameHeight, avatarSize, avatarSize);
            sender.SetBounds(own ? edge : bubbleX, top, own ? width - 2 * edge : width - edge - avatarSize - gap, nameHeight);
            bubble.Visible = hasText;
            bubble.SetBounds(bubbleX, top + nameHeight, bubbleWidth, bubbleHeight);
            body.SetBounds(padL, padV, bodyWidth, bodyHeight);
            int attachmentY = top + nameHeight + bubbleHeight + (hasText && attachments.Count > 0 ? gap : 0);
            foreach (InlineAttachment attachment in attachments)
            {
                Size size = attachment.PreferredMediaSize(attachmentWidth, scale);
                int h = size.Height;
                attachment.SetBounds(own ? avatarX - gap - size.Width : mediaX, attachmentY, size.Width, h);
                attachmentY += h + gap;
            }
            Height = top + nameHeight + Math.Max(avatarSize, bubbleHeight + attachmentHeight + (hasText && attachments.Count > 0 ? gap : 0)) + (int)(14 * scale);
        }

        private static Color AvatarColor(string name)
        {
            int hash = 0;
            foreach (char letter in name) hash = unchecked(hash * 31 + letter);
            Color[] colors = { Color.FromArgb(99, 144, 178), Color.FromArgb(159, 133, 185), Color.FromArgb(185, 143, 96), Color.FromArgb(87, 158, 151), Color.FromArgb(185, 122, 130) };
            return colors[(hash & Int32.MaxValue) % colors.Length];
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { messageFont.Dispose(); avatar.Font.Dispose(); }
            base.Dispose(disposing);
        }
    }

    private sealed class BubblePanel : Panel
    {
        private readonly Color fill;
        public BubblePanel(Color color) { fill = color; DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Width < 2 || Height < 2) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            int radius = 16;
            using (var path = new GraphicsPath())
            using (var brush = new SolidBrush(HighContrast ? SystemColors.Window : fill))
            {
                path.AddArc(bounds.Left, bounds.Top, radius, radius, 180, 90);
                path.AddArc(bounds.Right - radius, bounds.Top, radius, radius, 270, 90);
                path.AddArc(bounds.Right - radius, bounds.Bottom - radius, radius, radius, 0, 90);
                path.AddArc(bounds.Left, bounds.Bottom - radius, radius, radius, 90, 90);
                path.CloseFigure();
                e.Graphics.FillPath(brush, path);
                if (HighContrast) using (var pen = new Pen(SystemColors.WindowText)) e.Graphics.DrawPath(pen, path);
            }
        }
    }
}
