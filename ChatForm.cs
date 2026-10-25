using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class ChatForm : Form
{
    private readonly HttpClient client;
    private readonly CancellationTokenSource closing = new CancellationTokenSource();
    private readonly SemaphoreSlim requestGate = new SemaphoreSlim(1, 1);
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 2000 };
    private readonly Dictionary<string, AgentData> agents = new Dictionary<string, AgentData>();
    private readonly List<MessageRow> messageRows = new List<MessageRow>();
    private readonly Dictionary<long, ConversationDraft> drafts = new Dictionary<long, ConversationDraft>();
    private readonly StringBuilder transcript = new StringBuilder();
    private readonly Color ink = Color.FromArgb(27, 43, 62);
    private readonly Color muted = Color.FromArgb(116, 131, 148);
    private readonly Color green = Color.FromArgb(0, 139, 132);
    private ListView agentList, auditList, conversationList;
    private Button registrationButton, approveButton, pauseButton, revokeButton, sendButton, newConversationButton;
    private ComboBox recipientBox;
    private TextBox messageInput;
    private HistoryPanel messageHistory;
    private Label groupTitle, groupSubtitle, memberSummary, auditEmpty, statusLabel, errorLabel, connectionLabel;
    private bool registrationOpen, connected, syncing, mutating, stopping, rendering;
    private long cursor, activeConversationId;
    private int messageCount;
    private string recipientsSignature = "";

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
        MinimumSize = new Size(1000, 680);
        Size = new Size(1240, 820);
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
        WireEvents();
        UpdateButtons();
    }

    private static T Identify<T>(T control, string name, string accessible) where T : Control
    {
        control.Name = name;
        control.AccessibleName = accessible;
        return control;
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

    private ListView MakeList(string name, params string[] columns)
    {
        var list = Identify(new ListView(), name, name == "AgentList" ? "群成员列表" : name == "ConversationList" ? "历史对话列表" : "操作审计列表");
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

    private void BuildWindow()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Margin = Padding.Empty };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 274));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        Controls.Add(root);
        root.Controls.Add(BuildMembers(), 0, 0);
        var main = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(24, 14, 22, 12), ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 126));
        heading.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        heading.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        groupTitle = Identify(new Label { Text = "本地协作群", Dock = DockStyle.Fill, Font = new Font(Font.FontFamily, 15F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }, "GroupTitle", "本地协作群");
        groupSubtitle = new Label { Text = "人工指令 · 实时协作", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
        connectionLabel = Identify(new Label { Text = "●  正在连接", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleRight }, "ConnectionIndicator", "正在连接本机服务");
        var auditButton = MakeButton("AuditToggle", "操作审计", false);
        auditButton.Dock = DockStyle.Fill;
        auditButton.Margin = new Padding(12, 0, 0, 0);
        auditButton.MinimumSize = Size.Empty;
        heading.Controls.Add(groupTitle, 0, 0);
        heading.Controls.Add(groupSubtitle, 0, 1);
        heading.Controls.Add(connectionLabel, 1, 0);
        heading.Controls.Add(auditButton, 1, 1);
        main.Controls.Add(heading, 0, 0);
        var workspace = Identify(new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty }, "WorkspaceTabs", "群聊与审计");
        Control chat = BuildChat();
        Control audit = BuildAudit();
        audit.Padding = new Padding(22, 14, 22, 14);
        audit.Visible = false;
        workspace.Controls.Add(chat);
        workspace.Controls.Add(audit);
        auditButton.Click += delegate
        {
            bool showAudit = !audit.Visible;
            audit.Visible = showAudit;
            chat.Visible = !showAudit;
            auditButton.Text = showAudit ? "返回群聊" : "操作审计";
            auditButton.AccessibleName = auditButton.Text;
            if (showAudit) audit.BringToFront(); else chat.BringToFront();
        };
        main.Controls.Add(workspace, 0, 1);
        root.Controls.Add(main, 1, 0);
        errorLabel = Identify(new Label { AutoSize = true, Dock = DockStyle.Fill, ForeColor = Color.FromArgb(177, 50, 40), BackColor = Color.FromArgb(255, 243, 240), Padding = new Padding(12, 6, 12, 6), Visible = false }, "ErrorLabel", "操作错误");
        root.Controls.Add(errorLabel, 0, 1);
        root.SetColumnSpan(errorLabel, 2);
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Color.FromArgb(249, 250, 251), Padding = new Padding(12, 0, 12, 0) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        statusLabel = Identify(new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Text = "正在连接…", ForeColor = muted, AutoEllipsis = true }, "StatusLabel", "正在连接…");
        var safety = new Label { Text = "同一系统账户不隔离 · 管理员可见私聊 · 不自动唤醒模型", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight, ForeColor = muted, AutoEllipsis = true };
        safety.AccessibleName = safety.Text;
        footer.Controls.Add(statusLabel, 0, 0);
        footer.Controls.Add(safety, 1, 0);
        root.Controls.Add(footer, 0, 2);
        root.SetColumnSpan(footer, 2);
    }

    private Control BuildMembers()
    {
        var sidebar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 9, Padding = new Padding(18, 16, 16, 14), BackColor = Color.FromArgb(246, 248, 251), Margin = Padding.Empty };
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 38));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 62));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 90));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        newConversationButton = MakeButton("NewConversationButton", "新建对话", true);
        newConversationButton.Dock = DockStyle.Fill;
        sidebar.Controls.Add(newConversationButton, 0, 0);
        sidebar.Controls.Add(new Label { Text = "历史对话", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft }, 0, 1);
        conversationList = MakeList("ConversationList", "对话");
        conversationList.HeaderStyle = ColumnHeaderStyle.None;
        conversationList.Columns[0].Width = 210;
        conversationList.Resize += delegate { conversationList.Columns[0].Width = Math.Max(80, conversationList.ClientSize.Width - SystemInformation.VerticalScrollBarWidth); };
        sidebar.Controls.Add(conversationList, 0, 2);
        sidebar.Controls.Add(new Label { Text = "群成员", Font = new Font(Font.FontFamily, 10F, FontStyle.Bold), Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 3);
        registrationButton = MakeButton("RegistrationButton", "开启新成员登记", false);
        registrationButton.Dock = DockStyle.Fill;
        sidebar.Controls.Add(registrationButton, 0, 4);
        memberSummary = new Label { Text = "正在读取成员…", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft };
        sidebar.Controls.Add(memberSummary, 0, 5);
        agentList = MakeList("AgentList", "名称", "状态");
        agentList.Columns[0].Width = 150;
        agentList.Columns[1].Width = 78;
        sidebar.Controls.Add(agentList, 0, 6);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 10, 0, 0) };
        approveButton = MakeButton("ApproveButton", "批准 / 恢复", false);
        pauseButton = MakeButton("PauseButton", "暂停", false);
        revokeButton = MakeButton("RevokeButton", "撤销", false);
        actions.Controls.AddRange(new Control[] { approveButton, pauseButton, revokeButton });
        sidebar.Controls.Add(actions, 0, 7);
        sidebar.Controls.Add(new Label { Text = "先开启登记，再选择成员批准。\r\n撤销不可恢复；暂停可稍后恢复。", Dock = DockStyle.Fill, ForeColor = muted }, 0, 8);
        return sidebar;
    }

    private Control BuildChat()
    {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = Padding.Empty };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 210));
        messageHistory = Identify(new HistoryPanel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(240, 244, 248), AutoScroll = true, Margin = Padding.Empty }, "MessageHistory", "尚无消息，发送第一条消息开始协作。");
        messageHistory.Resize += delegate { LayoutMessages(false); };
        layout.Controls.Add(messageHistory, 0, 0);
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
        recipientBox = Identify(new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(246, 248, 251), ForeColor = ink, DropDownWidth = 480 }, "RecipientBox", "消息接收者");
        recipientBox.Items.Add(new Recipient(null, "广播 · 所有已批准成员", true));
        recipientBox.SelectedIndex = 0;
        targetRow.Controls.Add(recipientBox, 1, 0);
        compose.Controls.Add(targetRow, 0, 0);
        compose.Controls.Add(new Label { Text = "直接输入任务，广播或指定智能体；进度与结果在聊天中回复。", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }, 0, 1);
        var inputFrame = new InputFrame { Dock = DockStyle.Fill, Padding = new Padding(10, 7, 10, 7), Margin = new Padding(0, 0, 0, 8), BackColor = Color.FromArgb(250, 252, 254) };
        messageInput = Identify(new TextBox { Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, MaxLength = 8000, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = inputFrame.BackColor, Font = new Font(Font.FontFamily, 10.5F), Margin = Padding.Empty }, "MessageInput", "消息内容");
        inputFrame.Controls.Add(messageInput);
        compose.Controls.Add(inputFrame, 0, 2);
        var sendRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty, Padding = Padding.Empty };
        sendRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        sendRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 112));
        sendRow.Controls.Add(new Label { Text = "回车换行  /  Ctrl+回车发送", Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleLeft, Margin = Padding.Empty }, 0, 0);
        sendButton = MakeButton("SendButton", "发送", true);
        sendButton.Dock = DockStyle.Fill;
        sendButton.Margin = Padding.Empty;
        sendRow.Controls.Add(sendButton, 1, 0);
        compose.Controls.Add(sendRow, 0, 3);
        layout.Controls.Add(compose, 0, 1);
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

    private void WireEvents()
    {
        Shown += async delegate
        {
            Rectangle area = Screen.FromControl(this).WorkingArea;
            MinimumSize = new Size(Math.Min(MinimumSize.Width, area.Width), Math.Min(MinimumSize.Height, area.Height));
            Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
            poll.Start();
            await RefreshAsync();
        };
        poll.Tick += async delegate { await RefreshAsync(); };
        newConversationButton.Click += async delegate { await ChangeConversationAsync(0); };
        conversationList.SelectedIndexChanged += async delegate
        {
            if (rendering || mutating || !connected || conversationList.SelectedItems.Count == 0) return;
            long id;
            if (Int64.TryParse(conversationList.SelectedItems[0].Name, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id != activeConversationId)
                await ChangeConversationAsync(id);
        };
        agentList.SelectedIndexChanged += delegate { if (!rendering) UpdateButtons(); };
        recipientBox.SelectedIndexChanged += delegate { UpdateButtons(); };
        messageInput.TextChanged += delegate { UpdateButtons(); };
        registrationButton.Click += async delegate { await MutateAsync("api/admin/registration", new { open = !registrationOpen }, "登记状态已更新。", null); };
        approveButton.Click += async delegate { await ChangeAgentAsync("active"); };
        pauseButton.Click += async delegate { await ChangeAgentAsync("paused"); };
        revokeButton.Click += async delegate
        {
            AgentData agent = SelectedAgent();
            if (agent == null) return;
            if (MessageBox.Show(this, "撤销 “" + agent.Name + "” 后不可恢复，且将释放该成员认领的未完成任务。继续？", "撤销成员", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                await ChangeAgentAsync("revoked");
        };
        sendButton.Click += async delegate { await SendMessageAsync(); };
        messageInput.KeyDown += async delegate(object sender, KeyEventArgs e)
        {
            if (e.Control && e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                if (sendButton.Enabled) await SendMessageAsync();
            }
        };
    }

    private async Task ChangeAgentAsync(string status)
    {
        AgentData agent = SelectedAgent();
        if (agent == null) return;
        await MutateAsync("api/admin/agents/" + Uri.EscapeDataString(agent.Id), new { status = status }, "成员状态已更新。", null);
    }

    private async Task ChangeConversationAsync(long id)
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
                    conversationList.Items.Insert(0, new ListViewItem(groupTitle.Text) { Name = key, ToolTipText = groupTitle.Text });
                SelectConversationRow();
            }
            finally { rendering = false; }
        });
    }

    private void ApplyConversation(long id, string title)
    {
        if (id <= 0) throw new ChatClientException("服务返回的当前对话标识无效。");
        if (activeConversationId != id)
        {
            Recipient recipient = recipientBox.SelectedItem as Recipient;
            if (activeConversationId > 0)
                drafts[activeConversationId] = new ConversationDraft { Text = messageInput.Text, RecipientId = recipient == null ? null : recipient.Id };
            activeConversationId = id;
            cursor = 0;
            messageCount = 0;
            transcript.Clear();
            messageHistory.SuspendLayout();
            try
            {
                foreach (MessageRow row in messageRows) row.Dispose();
                messageRows.Clear();
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
    }


    private async Task SendMessageAsync()
    {
        var target = recipientBox.SelectedItem as Recipient;
        if (activeConversationId <= 0 || target == null || !target.Available || String.IsNullOrWhiteSpace(messageInput.Text)) return;
        string text = messageInput.Text;
        long conversationId = activeConversationId;
        await MutateAsync("api/messages", new { text = text, to = target.Id, conversationId = conversationId }, "消息已发送。", delegate(Dictionary<string, object> result)
        {
            if (activeConversationId == conversationId)
            {
                if (messageInput.Text == text) messageInput.Clear();
            }
            else
            {
                ConversationDraft draft;
                if (drafts.TryGetValue(conversationId, out draft) && draft.Text == text) draft.Text = "";
            }
        });
    }

    private async Task<Dictionary<string, object>> RequestAsync(string path, object body)
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

    private async Task RefreshAsync()
    {
        if (stopping || syncing || mutating) return;
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
            if (!stopping) UpdateButtons();
        }
    }

    private async Task MutateAsync(string path, object body, string success, Action<Dictionary<string, object>> committed)
    {
        if (stopping || mutating || !connected) return;
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

    private async Task LoadStateAsync()
    {
        Dictionary<string, object> state = await RequestAsync("api/admin/state", null);
        RenderState(state);
        long conversationId = activeConversationId;
        long snapshotLastId = cursor;
        foreach (Dictionary<string, object> item in Rows(state, "messages")) snapshotLastId = Math.Max(snapshotLastId, Number(item, "id"));
        // State contains only the latest 200 messages; traverse this conversation's independent cursor stream.
        do
        {
            Dictionary<string, object> page = await RequestAsync("api/messages?conversationId=" + conversationId.ToString(CultureInfo.InvariantCulture) + "&after=" + cursor.ToString(CultureInfo.InvariantCulture) + "&limit=200", null);
            if (activeConversationId != conversationId || Number(page, "conversationId") != conversationId)
                throw new ChatClientException("对话已变化，正在等待重新同步。");
            foreach (Dictionary<string, object> row in Rows(page, "messages"))
                if (Number(row, "conversationId") != conversationId) throw new ChatClientException("消息所属对话不一致，已停止载入。");
            long next = Number(page, "cursor");
            int added = AppendMessages(Rows(page, "messages"));
            if (next < cursor || (added > 0 && next <= cursor)) throw new ChatClientException("消息游标未推进，已保留现有历史。");
            cursor = next;
            if (added == 0 || cursor >= snapshotLastId) break;
            SetStatus("正在载入完整历史 · " + messageCount + " 条", false);
            await Task.Yield();
            closing.Token.ThrowIfCancellationRequested();
        } while (true);
        connected = true;
        SetStatus("已连接 · " + messageCount + " 条消息 · " + DateTime.Now.ToString("T", CultureInfo.CurrentUICulture), false);
        UpdateButtons();
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
                conversationRows.Add(new string[] { Value(row, "id"), Value(row, "title") });
                if (Number(row, "id") == selectedId) title = Value(row, "title");
            }
            if (title == null) throw new ChatClientException("当前对话不在历史列表中，请等待重新同步。");
            ReconcileList(conversationList, conversationRows);
            ApplyConversation(selectedId, title);
            SelectConversationRow();
            registrationOpen = state.ContainsKey("registrationOpen") && Convert.ToBoolean(state["registrationOpen"], CultureInfo.InvariantCulture);
            registrationButton.Text = registrationOpen ? "关闭新成员登记" : "开启新成员登记";
            registrationButton.AccessibleName = registrationButton.Text;
            agents.Clear();
            int active = 0, pending = 0;
            var agentRows = new List<string[]>();
            foreach (Dictionary<string, object> row in Rows(state, "agents"))
            {
                var agent = new AgentData { Id = Value(row, "id"), Name = Value(row, "name"), Status = Value(row, "status") };
                agents.Add(agent.Id, agent);
                if (agent.Status == "active") active++;
                if (agent.Status == "pending") pending++;
                agentRows.Add(new string[] { agent.Id, agent.Name, StatusName(agent.Status) });
            }
            ReconcileList(agentList, agentRows);
            memberSummary.Text = agents.Count == 0 ? "暂无成员 · 等待智能体申请" : "已批准 " + active + " · 待审批 " + pending + " · 共 " + agents.Count + " 人";
            groupSubtitle.Text = active + " 位已批准成员  /  " + (registrationOpen ? "登记开放" : "登记关闭") + "  /  管理员视图";
            RenderRecipients();
            var auditRows = new List<string[]>();
            foreach (Dictionary<string, object> row in Rows(state, "audit"))
                auditRows.Add(new string[] { Value(row, "id"), DateText(Value(row, "createdAt")), DisplayName(Value(row, "actor")), AuditActionText(Value(row, "action")), Value(row, "target") == "registration" ? "成员登记" : DisplayName(Value(row, "target")) });
            auditRows.Reverse();
            ReconcileList(auditList, auditRows);
            auditEmpty.Text = auditRows.Count == 0 ? "暂无操作记录。" : "最近 " + auditRows.Count + " 条审计记录（服务最多提供最近 200 条）";
        }
        finally { rendering = false; }
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
        finally { list.EndUpdate(); }
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
        finally { recipientBox.EndUpdate(); }
    }

    private int AppendMessages(IEnumerable<Dictionary<string, object>> rows)
    {
        bool follow = messageRows.Count == 0 || messageHistory.AtBottom;
        int added = 0;
        try
        {
            foreach (Dictionary<string, object> data in rows)
            {
                long id = Number(data, "id");
                if (id <= cursor) continue;
                string from = Value(data, "from"), to = Value(data, "to");
                string name = DisplayName(from), text = Value(data, "text");
                string route = String.IsNullOrEmpty(to) ? "广播" : "定向 · " + name + " → " + DisplayName(to) + "（管理员可见）";
                string time = DateText(Value(data, "createdAt"));
                var row = new MessageRow(id, name, route, time, text, from == "admin", Font);
                messageRows.Add(row);
                messageHistory.Controls.Add(row);
                transcript.Append('#').Append(id).Append(' ').Append(time).Append(" · ").Append(name).Append(" · ").Append(route).AppendLine().AppendLine(text).AppendLine();
                messageCount++;
                added++;
            }
            if (added > 0)
            {
                messageHistory.AccessibleName = transcript.ToString();
                LayoutMessages(follow);
            }
        }
        finally { messageHistory.Invalidate(); }
        return added;
    }

    private bool layingOutMessages;

    private void LayoutMessages(bool follow)
    {
        if (messageHistory == null || stopping || layingOutMessages) return;
        layingOutMessages = true;
        int oldScroll = -messageHistory.AutoScrollPosition.Y;
        int width = Math.Max(260, messageHistory.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 2);
        int y = 12;
        messageHistory.SuspendLayout();
        try
        {
            messageHistory.AutoScrollPosition = Point.Empty;
            foreach (MessageRow row in messageRows)
            {
                row.SetRowWidth(width);
                row.Location = new Point(0, y);
                y += row.Height;
            }
            messageHistory.AutoScrollMinSize = new Size(0, y + 14);
        }
        finally { messageHistory.ResumeLayout(true); layingOutMessages = false; }
        // Scroll only after WinForms has recomputed the display rectangle and scrollbar range.
        messageHistory.AutoScrollPosition = new Point(0, follow ? Int32.MaxValue : oldScroll);
    }


    private AgentData SelectedAgent()
    {
        AgentData agent;
        return agentList.SelectedItems.Count > 0 && agents.TryGetValue(agentList.SelectedItems[0].Name, out agent) ? agent : null;
    }


    private void UpdateButtons()
    {
        if (registrationButton == null || sendButton == null) return;
        bool ready = connected && !mutating && !stopping;
        AgentData agent = SelectedAgent();
        newConversationButton.Enabled = ready;
        conversationList.Enabled = ready;
        messageInput.ReadOnly = mutating || activeConversationId <= 0;
        recipientBox.Enabled = ready && activeConversationId > 0;
        registrationButton.Enabled = ready;
        approveButton.Enabled = ready && agent != null && (agent.Status == "pending" || agent.Status == "paused");
        approveButton.Text = agent != null && agent.Status == "paused" ? "恢复" : "批准";
        approveButton.AccessibleName = approveButton.Text;
        pauseButton.Enabled = ready && agent != null && agent.Status == "active";
        revokeButton.Enabled = ready && agent != null && agent.Status != "revoked";
        Recipient recipient = recipientBox.SelectedItem as Recipient;
        sendButton.Enabled = ready && activeConversationId > 0 && recipient != null && recipient.Available && !String.IsNullOrWhiteSpace(messageInput.Text);
    }

    private void SetStatus(string text, bool error)
    {
        statusLabel.Text = text;
        statusLabel.AccessibleName = text;
        statusLabel.ForeColor = error ? Color.FromArgb(177, 50, 40) : muted;
        connectionLabel.Text = error ? "●  连接异常" : connected ? "●  本机已连接" : "●  正在连接";
        connectionLabel.AccessibleName = connectionLabel.Text;
        connectionLabel.ForeColor = error ? Color.FromArgb(177, 50, 40) : connected ? green : muted;
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
            case "registration.open": return "开启成员登记";
            case "registration.close": return "关闭成员登记";
            case "agent.join": return "申请加入";
            case "agent.active": return "批准或恢复成员";
            case "agent.paused": return "暂停成员";
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
            case "Recipient is not active.": return "接收者当前未获批准或已被暂停、撤销，请查看最新成员状态。";
            case "Agent status transition is not allowed.": return "当前成员状态不允许此操作，请查看最新成员状态。";
            case "A valid bearer token is required.": return "身份凭据无效或已失效，请关闭并重新打开聊天室。";
            case "Administrator authorization is required.": return "此操作需要管理员授权。";
            case "Agent is not active; administrator approval is required.": return "智能体尚未获准访问，需要管理员批准。";
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
            case "paused": return "已暂停";
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
            poll.Dispose();
            closing.Cancel();
            client.Dispose();
            // The cancellation source and gate are retained until their in-flight continuations finish.
        }
        base.Dispose(disposing);
    }

    private sealed class AgentData { public string Id, Name, Status; }
    private sealed class ConversationDraft { public string Text, RecipientId; }
    private sealed class Recipient
    {
        public readonly string Id, Label;
        public readonly bool Available;
        public Recipient(string id, string label, bool available) { Id = id; Label = label; Available = available; }
        public override string ToString() { return Label; }
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

    // Retain native Button accessibility, keyboard handling and InvokePattern, but draw all states explicitly.
    private sealed class ModernButton : Button
    {
        private readonly bool primary;
        private bool hovered, pressed;
        public ModernButton(bool accent)
        {
            primary = accent;
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
            Color fill = primary ? Color.FromArgb(0, 139, 132) : Color.White;
            Color text = primary ? Color.White : Color.FromArgb(38, 61, 79);
            if (!Enabled) { fill = primary ? Color.FromArgb(220, 232, 234) : Color.FromArgb(242, 245, 248); text = Color.FromArgb(110, 127, 143); }
            else if (pressed) fill = primary ? Color.FromArgb(0, 111, 106) : Color.FromArgb(225, 236, 241);
            else if (hovered) fill = primary ? Color.FromArgb(0, 154, 146) : Color.FromArgb(239, 247, 249);
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), 12))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(primary ? fill : Color.FromArgb(220, 229, 236)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), text, fill);
        }
    }

    private sealed class InputFrame : Panel
    {
        public InputFrame() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Width < 3 || Height < 3) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundedPath(new Rectangle(0, 0, Width - 1, Height - 1), 12))
            using (var pen = new Pen(Color.FromArgb(218, 228, 237))) e.Graphics.DrawPath(pen, path);
        }
    }

    private sealed class HistoryPanel : Panel
    {
        public HistoryPanel() { DoubleBuffered = true; AccessibleRole = AccessibleRole.Pane; }
        public bool AtBottom { get { return !VerticalScroll.Visible || VerticalScroll.Value >= VerticalScroll.Maximum - VerticalScroll.LargeChange - 45; } }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Controls.Count == 0)
                TextRenderer.DrawText(e.Graphics, "暂无消息\r\n发送第一条消息，开始本机协作", Font, ClientRectangle, Color.FromArgb(137, 144, 150), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
        }
        protected override Point ScrollToControl(Control activeControl)
        {
            // A focused message/input must not drag the history back after an explicit append scroll.
            return AutoScrollPosition;
        }
    }

    private sealed class MessageRow : Panel
    {
        private readonly Label timestamp, sender, avatar;
        private readonly BubblePanel bubble;
        private readonly TextBox body;
        private readonly bool own;
        private readonly Font messageFont;
        private int lastWidth = -1;

        public MessageRow(long id, string name, string route, string time, string text, bool admin, Font uiFont)
        {
            DoubleBuffered = true;
            own = admin;
            Font = uiFont;
            Margin = Padding.Empty;
            Name = "Message_" + id;
            AccessibleName = name + " · " + route + " · " + text;
            timestamp = new Label { Text = time, ForeColor = Color.FromArgb(148, 153, 159), TextAlign = ContentAlignment.MiddleCenter };
            sender = new Label { Text = name + " · " + route, ForeColor = Color.FromArgb(111, 119, 126), AutoEllipsis = true, TextAlign = own ? ContentAlignment.MiddleRight : ContentAlignment.MiddleLeft };
            string initial = String.IsNullOrWhiteSpace(name) ? "?" : StringInfo.GetNextTextElement(name);
            avatar = new Label { Text = own ? "我" : initial, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White, BackColor = own ? Color.FromArgb(0, 139, 132) : AvatarColor(name), Font = new Font(uiFont.FontFamily, 12F, FontStyle.Bold) };
            Color bubbleColor = own ? Color.FromArgb(213, 241, 233) : Color.White;
            bubble = new BubblePanel(bubbleColor);
            messageFont = new Font(uiFont.FontFamily, 10.5F);
            body = new TextBox { Name = "MessageText_" + id, AccessibleName = name + " · " + route + " · " + text, Text = text.Replace("\r\n", "\n").Replace("\n", "\r\n"), ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, BackColor = bubbleColor, ForeColor = Color.FromArgb(35, 39, 42), Font = messageFont, WordWrap = true, TabStop = true, ScrollBars = ScrollBars.None };
            bubble.Controls.Add(body);
            Controls.AddRange(new Control[] { timestamp, sender, avatar, bubble });
        }

        public void SetRowWidth(int width)
        {
            if (lastWidth == width) return;
            lastWidth = width;
            Width = width;
            float scale;
            using (Graphics graphics = CreateGraphics()) scale = graphics.DpiX / 96F;
            int avatarSize = (int)(34 * scale), edge = (int)(24 * scale), gap = (int)(11 * scale), pad = (int)(10 * scale);
            int maxBody = Math.Max(110, Math.Min((int)(width * 0.72), width - 2 * edge - avatarSize - gap - 2 * pad));
            Size measured = TextRenderer.MeasureText(body.Text + " ", messageFont, new Size(maxBody, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix);
            int bodyWidth = Math.Min(maxBody, Math.Max(24, measured.Width + 4));
            // Re-measure at the actual inner width to keep long Unicode lines and CRLF text fully visible.
            measured = TextRenderer.MeasureText(body.Text + " ", messageFont, new Size(bodyWidth, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix);
            int fullHeight = Math.Max(body.Font.Height + 4, measured.Height + body.Font.Height / 2 + 4);
            int bodyHeight = Math.Min(fullHeight, (int)(480 * scale));
            body.ScrollBars = fullHeight > bodyHeight ? ScrollBars.Vertical : ScrollBars.None;
            if (fullHeight > bodyHeight) bodyWidth = Math.Min(maxBody, bodyWidth + SystemInformation.VerticalScrollBarWidth);
            int bubbleWidth = bodyWidth + pad * 2, bubbleHeight = bodyHeight + pad * 2;
            int top = (int)(23 * scale), nameHeight = (int)(22 * scale);
            int avatarX = own ? width - edge - avatarSize : edge;
            int bubbleX = own ? avatarX - gap - bubbleWidth : avatarX + avatarSize + gap;
            timestamp.SetBounds(0, 0, width, (int)(20 * scale));
            avatar.SetBounds(avatarX, top + nameHeight, avatarSize, avatarSize);
            sender.SetBounds(own ? edge : bubbleX, top, width - 2 * edge - avatarSize - gap, nameHeight);
            bubble.SetBounds(bubbleX, top + nameHeight, bubbleWidth, bubbleHeight);
            body.SetBounds(pad, pad, bodyWidth, bodyHeight);
            Height = top + nameHeight + Math.Max(avatarSize, bubbleHeight) + (int)(14 * scale);
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
            using (var brush = new SolidBrush(fill))
            {
                path.AddArc(bounds.Left, bounds.Top, radius, radius, 180, 90);
                path.AddArc(bounds.Right - radius, bounds.Top, radius, radius, 270, 90);
                path.AddArc(bounds.Right - radius, bounds.Bottom - radius, radius, radius, 0, 90);
                path.AddArc(bounds.Left, bounds.Bottom - radius, radius, radius, 90, 90);
                path.CloseFigure();
                e.Graphics.FillPath(brush, path);
            }
        }
    }
}
