'use strict';

const $ = (id) => document.getElementById(id);
const statusLabels = { pending: '待审批', active: '已批准', paused: '已禁言', revoked: '已撤销', open: '待认领', claimed: '进行中', done: '已完成' };
const actionLabels = { claim: '认领', release: '释放', complete: '完成', reopen: '重新打开' };
const auditActionLabels = {
  'conversation.create': '新建对话', 'conversation.activate': '切换对话', 'conversation.delete': '删除对话', 'conversation.rename': '重命名对话',
  'registration.open': '开启成员登记', 'registration.close': '关闭成员登记',
  'agent.join': '申请加入', 'agent.active': '批准或解禁', 'agent.paused': '禁言成员', 'agent.revoked': '撤销成员', 'agent.avatar': '更新头像',
  'message.delete': '删除消息', 'message.edit': '编辑消息', 'message.pin': '置顶消息', 'message.unpin': '取消置顶',
  'task.create': '创建任务', 'task.claim': '认领任务', 'task.release': '释放任务', 'task.complete': '完成任务', 'task.reopen': '重新打开任务', 'task.assign': '指派任务', 'task.delete': '删除任务'
};
function auditLabel(action) { return auditActionLabels[action] ?? action; }
function filteredAuditEntries() {
  const query = ($('audit-filter')?.value ?? '').trim().toLowerCase();
  return [...(state?.audit ?? [])]
    .map((entry) => ({ ...entry, actionLabel: auditLabel(entry.action), targetName: entry.target == null ? '' : displayName(entry.target) }))
    .filter((entry) => !query || `${displayName(entry.actor)} ${entry.actionLabel} ${entry.action} ${entry.targetName} ${dateText(entry.createdAt)}`.toLowerCase().includes(query))
    .sort((left, right) => right.id - left.id);
}
function csvCell(value) {
  let text = String(value ?? '').replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text}"`;
}
function exportAuditCsv() {
  if (!ready) return;
  const entries = filteredAuditEntries();
  if (!entries.length) return;
  const lines = ['编号,时间,操作者,操作,对象'];
  for (const entry of entries) lines.push([entry.id, dateText(entry.createdAt), displayName(entry.actor), entry.actionLabel, entry.targetName].map(csvCell).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = node('a');
  link.href = url;
  link.download = `审计-${dateStamp()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText($('action-status'), `已导出 ${entries.length} 条审计记录。`);
}
const agentCards = new Map();
const taskCards = new Map();
const messageCards = new Map();
const auditCards = new Map();
const conversationDrafts = new Map();
let activeConversationId = null;
let token = '';
let controller = null;
let generation = 0;
let timer = null;
let syncing = null;
let busy = false;
let ready = false;
let state = null;
const conversationSeen = new Map();
const conversationUnread = new Set();
let conversationBaselineDone = false;
let historyMode = false;
let messageRevision = -1;
const baseTitle = document.title;
let attentionCount = 0;
let suppressAttention = false;

function updateAttentionTitle() {
  const title = attentionCount > 0 ? `(${attentionCount}) ${baseTitle}` : baseTitle;
  if (document.title !== title) document.title = title;
}

function updateConversationUnread(next) {
  const active = next.activeConversationId;
  const retained = new Set(next.conversations.map((conversation) => conversation.id));
  for (const conversation of next.conversations) {
    const latest = Number(conversation.latestMessageId ?? 0);
    if (!conversationBaselineDone) {
      conversationSeen.set(conversation.id, latest);
    } else if (conversation.id === active) {
      conversationSeen.set(conversation.id, latest);
      conversationUnread.delete(conversation.id);
    } else {
      const seen = conversationSeen.get(conversation.id) ?? 0;
      if (latest > seen) conversationUnread.add(conversation.id);
      else conversationUnread.delete(conversation.id);
    }
  }
  conversationBaselineDone = true;
  for (const id of [...conversationSeen.keys()]) {
    if (!retained.has(id)) { conversationSeen.delete(id); conversationUnread.delete(id); }
  }
}
let cursor = 0;
let operationError = '';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent !== value) element.textContent = value;
}
function displayName(id) {
  if (id === 'admin') return '管理员';
  return state?.agents.find((agent) => agent.id === id)?.name ?? id ?? '未认领';
}
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
function showError(message) {
  $('error-banner').textContent = message;
  $('error-banner').hidden = !message;
}
function connectionStatus(text, mode) {
  setText($('connection-status'), text);
  $('connection-dot').className = `dot ${mode}`;
}
function updateControls() {
  const enabled = ready && !busy;
  $('admin-token').disabled = Boolean(token);
  $('connect-button').disabled = Boolean(token);
  $('disconnect-button').disabled = !token;
  for (const id of ['registration-button', 'conversation-select', 'new-conversation-button', 'rename-conversation-button', 'export-conversation-button', 'rename-input', 'rename-save', 'rename-cancel', 'member-filter', 'search-sender', 'audit-filter', 'audit-export', 'health-button', 'message-recipient', 'message-text', 'message-submit', 'message-search', 'search-button', 'task-title', 'task-description', 'task-submit']) {
    $(id).disabled = !enabled;
  }
  if ($('message-recipient').selectedOptions[0]?.disabled) $('message-submit').disabled = true;
  $('bulk-approve').disabled = !enabled || !state?.agents.some((agent) => agent.status === 'pending');
  $('bulk-revoke').disabled = !enabled || !state?.agents.some((agent) => agent.status !== 'revoked');
  $('delete-conversation-button').disabled = !enabled || !state || state.conversations.length <= 1;
  for (const button of document.querySelectorAll('[data-operation]')) button.disabled = !enabled;
  for (const select of document.querySelectorAll('.task-assignee')) select.disabled = !enabled;
  for (const note of document.querySelectorAll('.task-note')) note.disabled = !enabled;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: controller.signal,
    cache: 'no-store',
    credentials: 'omit',
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`服务返回了无法读取的响应（HTTP ${response.status}）。`); }
  if (!response.ok) {
    const error = new Error(result.error || `请求失败（HTTP ${response.status}）。`);
    error.status = response.status;
    throw error;
  }
  return result;
}
function pruneCards(map, ids) {
  const keep = new Set(ids);
  for (const [id, card] of map) {
    if (!keep.has(id)) { card.root.remove(); map.delete(id); }
  }
}
function actionButton(label, operation, handler, destructive = false) {
  const button = node('button', `secondary compact${destructive ? ' danger' : ''}`, label);
  button.type = 'button';
  button.dataset.operation = operation;
  button.addEventListener('click', handler);
  return button;
}
function setChatLoading(loading, title) {
  const overlay = $('chat-loading');
  if (!overlay) return;
  overlay.hidden = !loading;
  overlay.textContent = loading ? `正在加载对话…${title ? `\n${title}` : ''}` : '';
  $('message-scroll').setAttribute('aria-busy', String(Boolean(loading)));
}
function switchConversation(id) {
  if (activeConversationId === id) return;
  hideRenameRow();
  hideMentionMenu();
  historyMode = false;
  $('history-bar').hidden = true;
  clearSearchResults();
  setChatLoading(true, state?.conversations.find((conversation) => conversation.id === id)?.title ?? '正在连接');
  if (activeConversationId !== null) {
    conversationDrafts.set(activeConversationId, {
      text: $('message-text').value,
      to: $('message-recipient').value,
      title: $('task-title').value,
      description: $('task-description').value,
      notes: new Map([...taskCards].map(([taskId, card]) => [taskId, card.input.value])),
    });
  }
  activeConversationId = id;
  updateReplyBar();
  const selectedConversation = state?.conversations.find((conversation) => conversation.id === id);
  if (selectedConversation) conversationSeen.set(id, Number(selectedConversation.latestMessageId ?? 0));
  conversationUnread.delete(id);
  renderConversations();
  cursor = 0;
  for (const [map, list] of [[messageCards, 'message-list'], [taskCards, 'task-list']]) {
    map.clear();
    $(list).replaceChildren();
  }
  $('message-scroll').scrollTop = 0;
  for (const count of ['message-count', 'task-count']) setText($(count), '0');
  for (const empty of ['messages-empty', 'tasks-empty']) {
    $(empty).hidden = false;
    setText($(empty), '正在加载当前对话…');
  }
  const draft = conversationDrafts.get(id);
  $('message-text').value = draft?.text ?? '';
  $('task-title').value = draft?.title ?? '';
  $('task-description').value = draft?.description ?? '';
  renderRecipients(draft?.to ?? '');
}
function renderConversations() {
  const select = $('conversation-select');
  const signature = JSON.stringify({ rows: state.conversations.map((conversation) => [conversation.id, conversation.title]), unread: [...conversationUnread].sort() });
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...state.conversations.map((conversation) => {
      const option = node('option', '', (conversationUnread.has(conversation.id) ? '● ' : '') + conversation.title);
      option.value = conversation.id;
      return option;
    }));
  }
  select.value = String(activeConversationId);
  setText($('conversation-title'), state.conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? '当前对话');
}
function acceptConversation(result) {
  if (!state.conversations.some((conversation) => conversation.id === result.conversation.id)) {
    state.conversations.unshift(result.conversation);
  }
  state.activeConversationId = result.activeConversationId;
  switchConversation(result.activeConversationId);
  renderConversations();
}
const avatarCache = new Map();
const replyTargets = new Map();
function setReplyTarget(message) {
  if (!ready || activeConversationId === null) return;
  replyTargets.set(activeConversationId, { id: message.id, name: displayName(message.from), text: String(message.text ?? '').replace(/\s+/g, ' ').slice(0, 60) });
  updateReplyBar();
  $('message-text').focus();
}
function updateReplyBar() {
  const target = activeConversationId === null ? null : replyTargets.get(activeConversationId);
  $('reply-bar').hidden = !target;
  if (target) setText($('reply-summary'), `回复 ${target.name} · #${target.id}：${target.text}`);
}
function clearReplyTarget() {
  if (activeConversationId !== null) replyTargets.delete(activeConversationId);
  updateReplyBar();
}

async function applyAvatar(image, agent) {
  if (!agent || !agent.avatarHash) { image.hidden = true; return; }
  let entry = avatarCache.get(agent.id);
  if (!entry || entry.hash !== agent.avatarHash) {
    const current = generation;
    try {
      const response = await fetch(`/api/avatars/${encodeURIComponent(agent.id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
      if (!response.ok) { image.hidden = true; return; }
      const blob = await response.blob();
      if (current !== generation) return;
      const url = URL.createObjectURL(blob);
      if (entry) URL.revokeObjectURL(entry.url);
      entry = { hash: agent.avatarHash, url };
      avatarCache.set(agent.id, entry);
    } catch {
      image.hidden = true;
      return;
    }
  }
  if (image.getAttribute('src') !== entry.url) image.src = entry.url;
  image.hidden = false;
}

function memberPresence(agent) {
  if (agent.status !== 'active' && agent.status !== 'paused') return { text: '', kind: '' };
  const state = agent.activity?.state;
  if (state === 'thinking') return { text: '思考中', kind: 'thinking' };
  if (state === 'generating') return { text: '生成中', kind: 'generating' };
  if (state === 'idle') return { text: '空闲', kind: 'idle' };
  return agent.online ? { text: '空闲', kind: 'idle' } : { text: '离线', kind: 'offline' };
}
let mention = null;
function hideMentionMenu() {
  mention = null;
  const menu = $('mention-menu');
  if (menu) { menu.hidden = true; menu.replaceChildren(); }
}
function renderMentionMenu() {
  const menu = $('mention-menu');
  menu.replaceChildren(...mention.names.map((name, index) => {
    const item = node('li', '', name);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === mention.index));
    item.addEventListener('mousedown', (event) => { event.preventDefault(); mention.index = index; insertMention(); });
    return item;
  }));
}
function updateMentionMenu() {
  const input = $('message-text');
  if (!input || document.activeElement !== input || !state) return hideMentionMenu();
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = /@([^\s@]{0,24})$/.exec(before);
  if (!match || (match.index > 0 && !/\s/.test(before[match.index - 1]))) return hideMentionMenu();
  const fragment = match[1].toLowerCase();
  const names = state.agents
    .filter((agent) => agent.status === 'active' && agent.name && (!fragment || agent.name.toLowerCase().includes(fragment)))
    .map((agent) => agent.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .slice(0, 6);
  if (!names.length) return hideMentionMenu();
  mention = { start: match.index, names, index: 0 };
  renderMentionMenu();
  $('mention-menu').hidden = false;
}
function insertMention() {
  if (!mention) return;
  const input = $('message-text');
  const name = mention.names[mention.index];
  const caret = input.selectionStart;
  const text = input.value;
  const insert = '@' + name + ' ';
  input.value = text.slice(0, mention.start) + insert + text.slice(caret);
  const position = mention.start + insert.length;
  input.setSelectionRange(position, position);
  hideMentionMenu();
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function insertMentionName(name) {
  const input = $('message-text');
  if (!ready || !input || !name) return;
  const caret = input.selectionStart;
  const text = input.value;
  const prefix = caret > 0 && !/\s/.test(text[caret - 1]) ? ' ' : '';
  const insert = `${prefix}@${name} `;
  input.value = text.slice(0, caret) + insert + text.slice(caret);
  const position = caret + insert.length;
  input.setSelectionRange(position, position);
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = value;
  for (const unit of units) {
    current /= 1024;
    if (current < 1024 || unit === 'TB') return `${current.toFixed(1)} ${unit}`;
  }
  return `${value} B`;
}
function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}
async function showHealth() {
  if (!ready) return;
  try {
    const health = await api('/api/admin/health');
    const counts = health.counts ?? {};
    const memory = health.memory ?? {};
    const lines = [
      `版本：${health.version}　Node：${health.node}`,
      `端口：${health.port}　运行：${formatDuration(health.uptimeSeconds)}`,
      `数据库：${formatBytes(health.databaseBytes)}　WAL：${formatBytes(health.walBytes)}`,
      `消息 revision：${health.messageRevision}`,
      `成员：${counts.agents}　消息：${counts.messages}　任务：${counts.tasks}　对话：${counts.conversations}　附件：${counts.attachments}`,
      `内存 RSS：${formatBytes(memory.rss)}　Heap：${formatBytes(memory.heapUsed)}`,
    ];
    const output = $('health-output');
    output.textContent = lines.join('\n');
    output.hidden = false;
    setText($('action-status'), '服务状态已刷新。');
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message);
  }
}

function renderSearchSenders() {
  const select = $('search-sender');
  const previous = select.value;
  const entries = [{ id: '', name: '全部成员' }, { id: 'admin', name: '管理员' }];
  for (const agent of state?.agents ?? []) if (agent.status !== 'revoked') entries.push({ id: agent.id, name: agent.name });
  entries.sort((left, right) => left.id === '' ? -1 : right.id === '' ? 1 : left.name.localeCompare(right.name, 'zh-CN'));
  select.replaceChildren(...entries.map((entry) => {
    const option = node('option', '', entry.name);
    option.value = entry.id;
    return option;
  }));
  if (entries.some((entry) => entry.id === previous)) select.value = previous;
}

function renderAgents() {
  const allMembers = state.agents.filter((agent) => agent.status !== 'revoked');
  const filter = ($('member-filter')?.value ?? '').trim().toLowerCase();
  const members = filter
    ? allMembers.filter((agent) => `${agent.name} ${agent.model} ${statusLabels[agent.status] ?? agent.status}`.toLowerCase().includes(filter))
    : allMembers;
  pruneCards(agentCards, members.map((agent) => agent.id));
  for (const agent of members) {
    let card = agentCards.get(agent.id);
    if (!card) {
      const root = node('li', 'member-card');
      root.dataset.agentId = agent.id;
      const heading = node('div', 'card-heading');
      const avatar = node('img', 'member-avatar');
      avatar.alt = '';
      const name = node('strong', 'member-name');
      const mention = node('button', 'member-mention', '@');
      mention.type = 'button';
      mention.title = '插入 @提及';
      const timeline = node('button', 'member-mention member-timeline', '发言');
      timeline.type = 'button';
      timeline.title = '查看该成员在当前对话的发言';
      const badge = node('span', 'badge');
      const activity = node('span', 'member-activity');
      heading.append(avatar, name, mention, timeline, badge, activity);
      const model = node('p', 'member-model');
      const id = node('code', 'identity', agent.id);
      const actions = node('div', 'card-actions');
      root.append(heading, model, id, actions);
      card = { root, avatar, name, mention, timeline, badge, activity, model, actions, status: null };
      agentCards.set(agent.id, card);
      $('agent-list').append(root);
    }
    setText(card.name, agent.name);
    card.mention.setAttribute('aria-label', `插入 @${agent.name} 提及`);
    card.mention.onclick = () => insertMentionName(agent.name);
    card.timeline.setAttribute('aria-label', `查看 ${agent.name} 的发言`);
    card.timeline.onclick = () => {
      if (!ready) return;
      $('message-search').value = '';
      $('search-sender').value = agent.id;
      $('message-search').scrollIntoView({ block: 'center' });
      void searchMessages();
    };
    void applyAvatar(card.avatar, agent);
    setText(card.model, `模型 · ${agent.model || '未声明'}`);
    setText(card.badge, statusLabels[agent.status] ?? agent.status);
    card.badge.className = `badge ${agent.status}`;
    const presence = memberPresence(agent);
    setText(card.activity, presence.text);
    card.activity.className = `member-activity ${presence.kind}`;
    card.activity.title = agent.activity?.detail || '';
    if (card.status !== agent.status) {
      card.status = agent.status;
      card.actions.replaceChildren();
      const transitions = { pending: [['active', '批准'], ['revoked', '撤销']], active: [['paused', '禁言'], ['revoked', '撤销']], paused: [['active', '解禁'], ['revoked', '撤销']], revoked: [] };
      for (const [status, label] of transitions[agent.status] ?? []) {
        const button = actionButton(label, status, () => mutate(`/api/admin/agents/${encodeURIComponent(agent.id)}`, { status }, `已${label} ${agent.name}。`), status === 'revoked');
        button.setAttribute('aria-label', `${label} ${agent.name}`);
        card.actions.append(button);
      }
    }
  }
  setText($('agent-count'), filter ? `${members.length}/${allMembers.length}` : String(allMembers.length));
  $('agents-empty').hidden = members.length > 0;
  setText($('agents-empty'), filter ? '没有匹配的成员。' : '暂无成员。开启登记后，让智能体提交自己的名字与接入请求。');
}
function renderRecipients(selected = $('message-recipient').value) {
  const select = $('message-recipient');
  const active = state.agents.filter((agent) => agent.status === 'active');
  const desired = [{ id: '', name: '所有成员 · 广播', disabled: false }, ...active.map((agent) => ({ id: agent.id, name: `${agent.name} · ${agent.id}`, disabled: false }))];
  if (selected && !active.some((agent) => agent.id === selected)) desired.push({ id: selected, name: `${displayName(selected)} · 当前不可接收`, disabled: true });
  const signature = JSON.stringify(desired);
  if (select.dataset.signature === signature) { select.value = selected; return; }
  select.dataset.signature = signature;
  select.replaceChildren(...desired.map((entry) => {
    const option = node('option', '', entry.name);
    option.value = entry.id;
    option.disabled = entry.disabled;
    return option;
  }));
  select.value = selected;
}
function renderMessages(messages) {
  const scroll = $('message-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
  const before = messageCards.size;
  for (const message of messages) {
    if (message.conversationId !== activeConversationId) continue;
    if (messageCards.has(message.id)) continue;
    const root = node('li', `message${message.from === 'admin' ? ' from-admin' : ''}`);
    root.dataset.messageId = message.id;
    const heading = node('div', 'message-heading');
    const avatar = node('img', 'message-avatar');
    avatar.alt = '';
    const sender = node('strong');
    const recipient = node('span', 'message-recipient');
    const replyRef = node('span', 'reply-ref');
    const replyAction = node('button', 'reply-action', '回复');
    replyAction.type = 'button';
    replyAction.addEventListener('click', () => setReplyTarget(message));
    const editAction = node('button', 'reply-action', '编辑');
    editAction.type = 'button';
    editAction.addEventListener('click', () => beginEditMessage(message, root));
    const pinAction = node('button', 'reply-action', '置顶');
    pinAction.type = 'button';
    pinAction.addEventListener('click', () => pinMessage(message.id, true));
    const deleteAction = node('button', 'reply-action delete-action', '删除');
    deleteAction.type = 'button';
    deleteAction.addEventListener('click', () => {
      if (!confirm(`删除消息 #${message.id}？附件会一并删除，且不可恢复。`)) return;
      void mutate(`/api/admin/messages/${message.id}/delete`, {}, '消息已删除。');
    });
    const editedMark = node('span', 'edited-mark', '已编辑');
    const time = node('time', 'meta', dateText(message.createdAt));
    heading.append(avatar, sender, recipient, replyRef, editAction, pinAction, deleteAction, editedMark, time);
    root.append(heading, node('p', 'message-body', message.text));
    for (const attachment of message.attachments ?? []) {
      const download = node('button', '', `下载 ${attachment.name} (${attachment.size} B)`);
      download.type = 'button';
      download.dataset.operation = 'attachment-download';
      download.addEventListener('click', async () => {
        const session = generation;
        download.disabled = true;
        try {
          const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
          });
          if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）。`);
          const blob = await response.blob();
          if (session !== generation || !ready) return;
          const objectUrl = URL.createObjectURL(blob);
          const link = node('a');
          link.href = objectUrl;
          link.download = attachment.name;
          document.body.append(link);
          try { link.click(); }
          finally { link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
        } catch (error) {
          if (session === generation && error.name !== 'AbortError') showError(error.message);
        } finally {
          if (session === generation) download.disabled = !ready || busy;
        }
      });
      root.append(download);
    }
    $('message-list').append(root);
    void applyAvatar(avatar, state?.agents.find((agent) => agent.id === message.from));
    messageCards.set(message.id, { root, sender, recipient, replyRef, editedMark, replyAction, editAction, pinAction, message });
  }
  for (const card of messageCards.values()) {
    setText(card.sender, displayName(card.message.from));
    setText(card.recipient, card.message.to ? `定向 → ${displayName(card.message.to)}` : '广播 → 所有成员');
    card.recipient.classList.toggle('direct', Boolean(card.message.to));
    setText(card.replyRef, card.message.replyTo ? `回复 #${card.message.replyTo}` : '');
    card.replyRef.hidden = !card.message.replyTo;
    card.editedMark.hidden = !card.message.editedAt;
  }
  $('messages-empty').hidden = messageCards.size > 0;
  setText($('messages-empty'), '还没有消息。发送一条广播，开始协作。');
  setText($('message-count'), messageCards.size);
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  const added = messageCards.size - before;
  if (added > 0 && document.hidden && ready && !historyMode && !suppressAttention) {
    attentionCount += added;
    updateAttentionTitle();
  }
}
function safeFileName(value) {
  return String(value || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}
function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
async function exportConversation() {
  if (!ready || activeConversationId === null) return;
  const conversationId = activeConversationId;
  const title = state?.conversations.find((conversation) => conversation.id === conversationId)?.title ?? `对话 ${conversationId}`;
  try {
    const lines = [`# ${title}`, '', `- 对话 ID：${conversationId}`, `- 导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, ''];
    let after = 0, total = 0, truncated = false;
    while (true) {
      const page = await api(`/api/messages?conversationId=${conversationId}&after=${after}&limit=200`);
      if (page.conversationId !== conversationId) throw new Error('导出期间对话已变化。');
      if (!page.messages.length) break;
      for (const message of page.messages) {
        const target = message.to ? `${displayName(message.to)}（定向，管理员可见）` : '广播';
        lines.push(`### #${message.id} · ${dateText(message.createdAt)} · ${displayName(message.from)} · ${target}`);
        if (message.replyTo) lines.push(`回复 #${message.replyTo}`);
        if (message.text && message.text.trim()) lines.push('', message.text.trimEnd());
        for (const attachment of message.attachments ?? []) lines.push('', `- 附件：${attachment.name}（${attachment.size} B）`);
        lines.push('');
        total += 1;
        if (total >= 20000) { truncated = true; break; }
      }
      if (truncated || page.messages.length < 200) break;
      after = page.cursor;
    }
    if (truncated) lines.push('> 导出达到 20000 条上限，后续消息未包含。');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = `${safeFileName(title)}-${dateStamp()}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setText($('action-status'), `已导出 ${total} 条消息。`);
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message);
  }
}

function showRenameRow() {
  if (!ready || activeConversationId === null) return;
  const title = state?.conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? '';
  $('rename-input').value = title;
  $('rename-row').hidden = false;
  $('rename-input').focus();
  $('rename-input').select();
}
function hideRenameRow() {
  const row = $('rename-row');
  if (row) row.hidden = true;
}
function saveRename() {
  if (!ready || activeConversationId === null) return;
  const title = $('rename-input').value.trim();
  if (!title) { showError('对话标题不能为空。'); return; }
  void mutate(`/api/admin/conversations/${activeConversationId}/rename`, { title }, '对话已重命名。', hideRenameRow);
}

function pinMessage(messageId, pinned) {
  if (!ready) return;
  void mutate(`/api/admin/messages/${messageId}/pin`, { pinned }, pinned ? '消息已置顶。' : '已取消置顶。');
}
function renderPinnedBar() {
  const bar = $('pinned-bar');
  const pin = state?.pinnedMessage;
  bar.hidden = !pin;
  if (!pin) return;
  const summary = `置顶 · ${displayName(pin.from)}：${String(pin.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`;
  setText($('pinned-jump'), summary);
  $('pinned-jump').onclick = () => { void jumpToMessage(pin.id); };
  $('pinned-unpin').onclick = () => pinMessage(pin.id, false);
}

function beginEditMessage(message, root) {
  if (!ready) return;
  const body = root.querySelector(".message-body");
  if (!body || root.querySelector(".message-edit")) return;
  const editor = node("textarea", "message-edit");
  editor.value = message.text ?? "";
  editor.maxLength = 8000;
  editor.rows = 3;
  const actions = node("div", "message-edit-actions");
  const save = node("button", "secondary compact", "保存");
  save.type = "button";
  save.addEventListener("click", () => {
    const text = editor.value;
    if (!text.trim()) { showError("消息内容不能为空。"); return; }
    void mutate(`/api/admin/messages/${message.id}/edit`, { text }, "消息已编辑。");
  });
  const cancel = node("button", "secondary compact", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => { editor.replaceWith(body); actions.remove(); });
  actions.append(save, cancel);
  body.replaceWith(editor);
  editor.after(actions);
  editor.focus();
}

function clearSearchResults() {
  const list = $('search-results');
  if (list) { list.replaceChildren(); list.hidden = true; }
}
function renderSearchResults(messages) {
  const list = $('search-results');
  clearSearchResults();
  if (!messages.length) { setText($('action-status'), '没有匹配的消息。'); return; }
  list.replaceChildren(...messages.map((message) => {
    const item = node('li');
    const button = node('button');
    button.type = 'button';
    const meta = node('span', 'search-meta', `${dateText(message.createdAt)} · ${displayName(message.from)}`);
    const body = node('span', '', String(message.text ?? '').replace(/\s+/g, ' ').slice(0, 120));
    const id = node('span', 'search-id', `#${message.id}`);
    button.append(meta, body, id);
    button.addEventListener('click', () => { void jumpToMessage(message.id); });
    item.append(button);
    return item;
  }));
  list.hidden = false;
}
async function searchMessages() {
  const input = $('message-search');
  const query = input.value.trim();
  const sender = $('search-sender').value;
  if (!ready || activeConversationId === null || (!query && !sender)) return;
  try {
    const fromQuery = sender ? `&from=${encodeURIComponent(sender)}` : '';
    const queryPart = query ? `q=${encodeURIComponent(query)}` : '';
    const result = await api(`/api/messages/search?conversationId=${activeConversationId}${queryPart ? `&${queryPart}` : ''}${fromQuery}&limit=100`);
    if (result.conversationId !== activeConversationId) return;
    renderSearchResults(result.messages);
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message);
  }
}
async function jumpToMessage(messageId) {
  if (!ready || activeConversationId === null) return;
  const conversationId = activeConversationId;
  try {
    const page = await api(`/api/messages?conversationId=${conversationId}&before=${messageId + 1}&limit=20`);
    if (activeConversationId !== conversationId || page.conversationId !== conversationId) return;
    messageCards.clear();
    $('message-list').replaceChildren();
    suppressAttention = true;
    renderMessages(page.messages);
    suppressAttention = false;
    historyMode = true;
    $('history-bar').hidden = false;
    $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
    setText($('action-status'), `已定位到消息 #${messageId}。`);
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message);
  }
}
function returnToLatest() {
  historyMode = false;
  $('history-bar').hidden = true;
  clearSearchResults();
  messageCards.clear();
  $('message-list').replaceChildren();
  cursor = 0;
  setText($('action-status'), '正在返回最新消息…');
  suppressAttention = true;
  Promise.resolve(sync()).finally(() => { suppressAttention = false; });
}

function renderTasks() {
  pruneCards(taskCards, state.tasks.map((task) => task.id));
  for (const task of state.tasks) {
    let card = taskCards.get(task.id);
    if (!card) {
      const root = node('li', 'task-card');
      root.dataset.taskId = task.id;
      const heading = node('div', 'card-heading');
      const title = node('h3');
      const badge = node('span', 'badge');
      heading.append(title, badge);
      const description = node('p', 'task-description');
      const metadata = node('p', 'meta');
      const note = node('p', 'recorded-note');
      const label = node('label', 'hint', '本次操作备注（可选）');
      const input = node('textarea', 'task-note');
      input.id = `task-note-${task.id}`;
      input.maxLength = 8000;
      input.rows = 2;
      input.value = conversationDrafts.get(activeConversationId)?.notes.get(task.id) ?? '';
      label.htmlFor = input.id;
      const actions = node('div', 'card-actions');
      root.append(heading, description, metadata, note, label, input, actions);
      card = { root, title, badge, description, metadata, note, input, actions, status: null, owner: null };
      taskCards.set(task.id, card);
      $('task-list').append(root);
    }
    setText(card.title, task.title);
    setText(card.badge, statusLabels[task.status] ?? task.status);
    card.badge.className = `badge ${task.status}`;
    setText(card.description, task.description);
    card.description.hidden = !task.description;
    setText(card.metadata, `#${task.id} · 创建：${displayName(task.createdBy)} · 负责人：${displayName(task.owner)} · 更新：${dateText(task.updatedAt)}`);
    setText(card.note, task.note ? `最新备注：${task.note}` : '');
    card.note.hidden = !task.note;
    if (card.status !== task.status || card.owner !== (task.owner ?? '')) {
      card.status = task.status;
      card.owner = task.owner ?? '';
      card.actions.replaceChildren();
      const actions = { open: ['claim'], claimed: ['release', 'complete'], done: ['reopen'] };
      for (const action of actions[task.status] ?? []) {
        const button = actionButton(actionLabels[action], action, () => {
          const note = card.input.value;
          mutate(`/api/tasks/${encodeURIComponent(task.id)}`, { action, note, conversationId: task.conversationId }, `任务已${actionLabels[action]}。`, () => {
            if (card.input.value === note) card.input.value = '';
          });
        });
        button.setAttribute('aria-label', `${actionLabels[action]}任务：${task.title}`);
        card.actions.append(button);
      }
      if (task.status === 'open' || task.status === 'claimed') {
        const select = node('select', 'task-assignee');
        const candidates = state.agents.filter((agent) => agent.status === 'active');
        const placeholder = node('option', '', candidates.length ? '选择成员' : '暂无已批准成员');
        placeholder.value = '';
        select.append(placeholder);
        for (const agent of candidates) {
          const option = node('option', '', agent.name);
          option.value = agent.id;
          select.append(option);
        }
        if (task.owner) select.value = task.owner;
        const assign = actionButton('指派', 'assign', () => {
          const owner = select.value;
          if (!owner) { showError('请选择要指派的成员。'); return; }
          mutate(`/api/admin/tasks/${encodeURIComponent(task.id)}/assign`, { owner }, '任务已指派。');
        });
        assign.setAttribute('aria-label', `指派任务：${task.title}`);
        card.actions.append(select, assign);
      }
      const remove = actionButton('删除', 'delete', () => {
        if (!confirm(`删除任务 #${task.id}「${task.title}」？删除后不可恢复。`)) return;
        mutate(`/api/admin/tasks/${encodeURIComponent(task.id)}/delete`, {}, '任务已删除。');
      }, true);
      remove.setAttribute('aria-label', `删除任务：${task.title}`);
      card.actions.append(remove);
    }
  }
  setText($('task-count'), state.tasks.length);
  $('tasks-empty').hidden = state.tasks.length > 0;
  setText($('tasks-empty'), '还没有共享任务。创建任务后，管理员或已批准的智能体可以认领。');
}
function renderAudit() {
  const entries = filteredAuditEntries();
  pruneCards(auditCards, entries.map((entry) => entry.id));
  let previous = null;
  for (const entry of entries) {
    let card = auditCards.get(entry.id);
    if (!card) {
      const root = node('li', 'audit-entry');
      const text = node('span');
      root.append(text, node('time', 'meta', dateText(entry.createdAt)));
      card = { root, text };
      auditCards.set(entry.id, card);
    }
    setText(card.text, `${displayName(entry.actor)} · ${entry.actionLabel}${entry.targetName ? ` · ${entry.targetName}` : ''}`);
    const expected = previous ? previous.nextSibling : $('audit-list').firstChild;
    if (expected !== card.root) $('audit-list').insertBefore(card.root, expected);
    previous = card.root;
  }
  const filtering = ($('audit-filter')?.value ?? '').trim().length > 0;
  $('audit-empty').hidden = entries.length > 0;
  setText($('audit-empty'), filtering ? '没有匹配的审计记录。' : '暂无操作记录。');
}
function renderState() {
  setText($('registration-status'), state.registrationOpen ? '新成员登记已开启' : '新成员登记已关闭');
  setText($('registration-button'), state.registrationOpen ? '关闭登记' : '开启登记');
  $('registration-button').setAttribute('aria-pressed', String(state.registrationOpen));
  renderConversations();
  renderPinnedBar();
  renderSearchSenders();
  renderAgents();
  renderRecipients();
  renderTasks();
  renderAudit();
}
function scheduleSync() {
  clearTimeout(timer);
  if (token) timer = setTimeout(() => { void sync(); }, 2000);
}
function handleFailure(error) {
  setChatLoading(false);
  if (error.name === 'AbortError') return;
  if (error.status === 401 || error.status === 403) {
    disconnect();
    showError(`认证失败，已断开连接。请重新粘贴当前服务的管理员令牌。${error.message}`);
    return;
  }
  ready = false;
  connectionStatus('连接异常 · 自动重试中', 'error');
  showError(error.message || '无法连接服务，请确认本地服务正在运行。');
  updateControls();
}
async function sync() {
  if (!token || syncing || busy) { scheduleSync(); return; }
  const current = generation;
  const work = (async () => {
    try {
      const next = await api('/api/admin/state?includeMessages=0');
      if (current !== generation) return;
      state = next;
      const revision = Number(next.messageRevision ?? 0);
      const revisionReload = messageRevision >= 0 && revision !== messageRevision;
      if (revisionReload) {
        messageCards.clear();
        $('message-list').replaceChildren();
        cursor = Math.max(0, Number(next.latestMessageId ?? 0) - 200);
        historyMode = false;
        $('history-bar').hidden = true;
        clearSearchResults();
      }
      messageRevision = revision;
      updateConversationUnread(next);
      switchConversation(next.activeConversationId);
      renderState();
      // Pin every history page to the same conversation, even if another client switches it.
      const conversationId = activeConversationId;
      const latest = Number(next.latestMessageId ?? 0);
      if (!historyMode && cursor === 0 && latest > 200) cursor = latest - 200;
      if (revisionReload) suppressAttention = true;
      try {
        if (!historyMode && latest > cursor) {
          for (let page = 0; page < 10; page += 1) {
            const batch = await api(`/api/messages?conversationId=${conversationId}&after=${cursor}&limit=200`);
            if (current !== generation || activeConversationId !== conversationId) return;
            if (batch.conversationId !== conversationId) throw new Error('对话历史与当前选择不一致，请等待重新同步。');
            renderMessages(batch.messages);
            cursor = batch.cursor;
            if (batch.messages.length < 200) break;
          }
        }
        if (!historyMode && messageCards.size === 0) renderMessages([]);
      } finally {
        if (revisionReload) suppressAttention = false;
      }
      ready = true;
      setChatLoading(false);
      connectionStatus('已连接 · 每 2 秒同步', 'online');
      setText($('last-sync'), `最近同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
      showError(operationError);
      updateControls();
    } catch (error) {
      if (current === generation) handleFailure(error);
    }
  })();
  syncing = work;
  await work;
  if (current === generation) { syncing = null; scheduleSync(); }
}
async function mutate(path, body, success, onSuccess) {
  if (!ready || busy) return;
  busy = true;
  updateControls();
  setText($('action-status'), '正在提交…');
  operationError = '';
  const current = generation;
  try {
    if (syncing) await syncing;
    if (current !== generation) return;
    if (body.conversationId !== undefined && body.conversationId !== activeConversationId) {
      const error = new Error('当前对话已切换，内容未提交。请返回原对话后重试。');
      error.status = 409;
      throw error;
    }
    const result = await api(path, body);
    if (current !== generation) return;
    onSuccess?.(result);
    setText($('action-status'), success);
    showError('');
  } catch (error) {
    if (current !== generation) return;
    setText($('action-status'), '操作未确认成功；请根据最新状态检查，勿重复提交。');
    operationError = error.message || '无法确认服务是否收到此操作。请检查最新状态后再操作。';
    if (error.status && error.status !== 401 && error.status !== 403) showError(operationError);
    else handleFailure(error);
  } finally {
    if (current === generation) {
      ready = false;
      busy = false;
      updateControls();
      // Refresh authoritative state while retaining the failed operation's explanation.
      if (token) { await sync(); }
    }
  }
}
function disconnect() {
  generation += 1;
  setChatLoading(false);
  clearTimeout(timer);
  controller?.abort();
  controller = null;
  token = '';
  ready = false;
  busy = false;
  syncing = null;
  state = null;
  cursor = 0;
  activeConversationId = null;
  conversationDrafts.clear();
  $('health-output').hidden = true;
  $('health-output').textContent = '';
  attentionCount = 0;
  updateAttentionTitle();
  $('member-filter').value = '';
  hideRenameRow();
  historyMode = false;
  clearSearchResults();
  $('history-bar').hidden = true;
  replyTargets.clear();
  updateReplyBar();
  for (const entry of avatarCache.values()) URL.revokeObjectURL(entry.url);
  avatarCache.clear();
  $('message-text').value = '';
  $('task-title').value = '';
  $('task-description').value = '';
  $('message-recipient').replaceChildren(node('option', '', '所有成员 · 广播'));
  $('message-recipient').firstChild.value = '';
  delete $('message-recipient').dataset.signature;
  $('conversation-select').replaceChildren(node('option', '', '连接后加载对话'));
  $('conversation-select').firstChild.value = '';
  delete $('conversation-select').dataset.signature;
  setText($('conversation-title'), '尚未连接');
  $('admin-token').value = '';
  for (const [map, list] of [[agentCards, 'agent-list'], [taskCards, 'task-list'], [messageCards, 'message-list'], [auditCards, 'audit-list']]) { map.clear(); $(list).replaceChildren(); }
  for (const id of ['agent-count', 'message-count', 'task-count']) setText($(id), '0');
  for (const id of ['agents-empty', 'messages-empty', 'tasks-empty', 'audit-empty']) { $(id).hidden = false; setText($(id), '尚未连接。连接后加载数据。'); }
  setText($('registration-status'), '登记状态未知');
  setText($('registration-button'), '开启登记');
  $('registration-button').removeAttribute('aria-pressed');
  setText($('last-sync'), '尚未同步');
  setText($('action-status'), '已断开，管理员令牌已从页面内存清除。');
  connectionStatus('未连接', '');
  operationError = '';
  showError('');
  updateControls();
}
$('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (token) return;
  const value = $('admin-token').value.trim();
  if (!value) { showError('请输入管理员令牌。'); return; }
  token = value;
  $('admin-token').value = '';
  controller = new AbortController();
  generation += 1;
  connectionStatus('正在连接…', 'loading');
  setText($('action-status'), '');
  showError('');
  for (const id of ['agents-empty', 'messages-empty', 'tasks-empty', 'audit-empty']) setText($(id), '正在加载…');
  updateControls();
  void sync();
});
$('disconnect-button').addEventListener('click', disconnect);
$('reply-cancel').addEventListener('click', clearReplyTarget);
$('search-button').addEventListener('click', () => { void searchMessages(); });
$('message-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void searchMessages(); } });
$('return-latest').addEventListener('click', returnToLatest);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { attentionCount = 0; updateAttentionTitle(); }
});
$('member-filter').addEventListener('input', () => { if (state) renderAgents(); });
$('audit-filter').addEventListener('input', () => { if (state) renderAudit(); });
$('audit-export').addEventListener('click', exportAuditCsv);
$('health-button').addEventListener('click', () => { void showHealth(); });
$('rename-conversation-button').addEventListener('click', showRenameRow);
$('export-conversation-button').addEventListener('click', () => { void exportConversation(); });
$('rename-save').addEventListener('click', saveRename);
$('rename-cancel').addEventListener('click', hideRenameRow);
$('rename-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); saveRename(); }
  else if (event.key === 'Escape') { event.preventDefault(); hideRenameRow(); }
});
$('new-conversation-button').addEventListener('click', () => {
  setChatLoading(true, '新建对话');
  void mutate('/api/admin/conversations', {}, '已新建对话，历史内容已保留。', acceptConversation);
});
$('delete-conversation-button').addEventListener('click', () => {
  const id = activeConversationId;
  const conversation = state?.conversations.find((row) => row.id === id);
  if (!conversation) return;
  if (!window.confirm(`删除当前对话「${conversation.title}」及其全部消息和任务？此操作不可恢复。`)) return;
  void mutate(`/api/admin/conversations/${id}/delete`, {}, '对话已删除。', () => {
    conversationDrafts.delete(id);
    activeConversationId = null;
  });
});
$('conversation-select').addEventListener('change', () => {
  const id = Number($('conversation-select').value);
  const title = $('conversation-select').selectedOptions[0]?.textContent;
  $('conversation-select').value = String(activeConversationId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === activeConversationId) return;
  setChatLoading(true, title);
  void mutate(`/api/admin/conversations/${id}/activate`, {}, '已切换对话。', acceptConversation);
});
$('registration-button').addEventListener('click', () => {
  if (!state) return;
  const open = !state.registrationOpen;
  void mutate('/api/admin/registration', { open }, open ? '已开启新成员登记。' : '已关闭新成员登记。');
});
$('bulk-approve').addEventListener('click', () => {
  void mutate('/api/admin/agents/bulk', { action: 'approve' }, '全部待审批成员已批准。');
});
$('bulk-revoke').addEventListener('click', () => {
  if (!state) return;
  const count = state.agents.filter((agent) => agent.status !== 'revoked').length;
  if (!count) return;
  if (!window.confirm(`将撤销全部 ${count} 名成员，并释放其未完成任务。此操作不可恢复，继续？`)) return;
  void mutate('/api/admin/agents/bulk', { action: 'revoke' }, '全部成员已撤销。');
});
$('message-recipient').addEventListener('change', updateControls);
$('message-text').addEventListener('input', updateMentionMenu);
$('message-text').addEventListener('keydown', (event) => {
  if (!mention) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    mention.index = (mention.index + delta + mention.names.length) % mention.names.length;
    renderMentionMenu();
    event.preventDefault();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    insertMention();
    event.preventDefault();
  } else if (event.key === 'Escape') {
    hideMentionMenu();
    event.preventDefault();
  }
});
$('message-text').addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== $('mention-menu')) hideMentionMenu(); }, 120); });
$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('message-text').value;
  if (!text.trim()) { showError('消息内容不能为空。'); return; }
  if ($('message-recipient').selectedOptions[0]?.disabled) { showError('所选成员当前不可接收消息，请重新选择。'); return; }
  const to = $('message-recipient').value || null;
  const conversationId = activeConversationId;
  const reply = replyTargets.get(conversationId) ?? null;
  void mutate('/api/messages', { text, to, conversationId, replyTo: reply ? reply.id : null }, '消息已发送。', () => {
    if (activeConversationId === conversationId && $('message-text').value === text) $('message-text').value = '';
    if (reply && replyTargets.get(conversationId)?.id === reply.id) replyTargets.delete(conversationId);
    updateReplyBar();
    if (historyMode) returnToLatest();
  });
});
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('task-title').value;
  const description = $('task-description').value;
  if (!title.trim()) { showError('任务标题不能为空。'); return; }
  const conversationId = activeConversationId;
  void mutate('/api/tasks', { title, description, conversationId }, '任务已创建。', () => {
    if (activeConversationId !== conversationId) return;
    if ($('task-title').value === title) $('task-title').value = '';
    if ($('task-description').value === description) $('task-description').value = '';
  });
});
window.addEventListener('pagehide', disconnect);
