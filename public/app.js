'use strict';

const $ = (id) => document.getElementById(id);
const statusLabels = { pending: '待审批', active: '已批准', paused: '已禁言', revoked: '已撤销', open: '待认领', claimed: '进行中', done: '已完成' };
const actionLabels = { claim: '认领', release: '释放', complete: '完成', reopen: '重新打开' };
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
  for (const id of ['registration-button', 'conversation-select', 'new-conversation-button', 'message-recipient', 'message-text', 'message-submit', 'task-title', 'task-description', 'task-submit']) {
    $(id).disabled = !enabled;
  }
  if ($('message-recipient').selectedOptions[0]?.disabled) $('message-submit').disabled = true;
  $('bulk-approve').disabled = !enabled || !state?.agents.some((agent) => agent.status === 'pending');
  $('bulk-revoke').disabled = !enabled || !state?.agents.some((agent) => agent.status !== 'revoked');
  $('delete-conversation-button').disabled = !enabled || !state || state.conversations.length <= 1;
  for (const button of document.querySelectorAll('[data-operation]')) button.disabled = !enabled;
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
function switchConversation(id) {
  if (activeConversationId === id) return;
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
  const signature = JSON.stringify(state.conversations);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...state.conversations.map((conversation) => {
      const option = node('option', '', conversation.title);
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
function renderAgents() {
  const members = state.agents.filter((agent) => agent.status !== 'revoked');
  pruneCards(agentCards, members.map((agent) => agent.id));
  for (const agent of members) {
    let card = agentCards.get(agent.id);
    if (!card) {
      const root = node('li', 'member-card');
      root.dataset.agentId = agent.id;
      const heading = node('div', 'card-heading');
      const name = node('strong', 'member-name');
      const badge = node('span', 'badge');
      heading.append(name, badge);
      const model = node('p', 'member-model');
      const id = node('code', 'identity', agent.id);
      const actions = node('div', 'card-actions');
      root.append(heading, model, id, actions);
      card = { root, name, badge, model, actions, status: null };
      agentCards.set(agent.id, card);
      $('agent-list').append(root);
    }
    setText(card.name, agent.name);
    setText(card.model, `模型 · ${agent.model || '未声明'}`);
    setText(card.badge, statusLabels[agent.status] ?? agent.status);
    card.badge.className = `badge ${agent.status}`;
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
  setText($('agent-count'), members.length);
  $('agents-empty').hidden = members.length > 0;
  setText($('agents-empty'), '暂无成员。开启登记后，让智能体提交自己的名字与接入请求。');
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
  for (const message of messages) {
    if (message.conversationId !== activeConversationId) continue;
    if (messageCards.has(message.id)) continue;
    const root = node('li', `message${message.from === 'admin' ? ' from-admin' : ''}`);
    root.dataset.messageId = message.id;
    const heading = node('div', 'message-heading');
    const sender = node('strong');
    const recipient = node('span', 'message-recipient');
    const time = node('time', 'meta', dateText(message.createdAt));
    heading.append(sender, recipient, time);
    root.append(heading, node('p', 'message-body', message.text));
    $('message-list').append(root);
    messageCards.set(message.id, { root, sender, recipient, message });
  }
  for (const card of messageCards.values()) {
    setText(card.sender, displayName(card.message.from));
    setText(card.recipient, card.message.to ? `定向 → ${displayName(card.message.to)}` : '广播 → 所有成员');
    card.recipient.classList.toggle('direct', Boolean(card.message.to));
  }
  $('messages-empty').hidden = messageCards.size > 0;
  setText($('messages-empty'), '还没有消息。发送一条广播，开始协作。');
  setText($('message-count'), messageCards.size);
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
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
      card = { root, title, badge, description, metadata, note, input, actions, status: null };
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
    if (card.status !== task.status) {
      card.status = task.status;
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
    }
  }
  setText($('task-count'), state.tasks.length);
  $('tasks-empty').hidden = state.tasks.length > 0;
  setText($('tasks-empty'), '还没有共享任务。创建任务后，管理员或已批准的智能体可以认领。');
}
function renderAudit() {
  const entries = [...state.audit].sort((a, b) => b.id - a.id);
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
    setText(card.text, `${displayName(entry.actor)} · ${entry.action}${entry.target == null ? '' : ` · ${displayName(entry.target)}`}`);
    const expected = previous ? previous.nextSibling : $('audit-list').firstChild;
    if (expected !== card.root) $('audit-list').insertBefore(card.root, expected);
    previous = card.root;
  }
  $('audit-empty').hidden = entries.length > 0;
  setText($('audit-empty'), '暂无操作记录。');
}
function renderState() {
  setText($('registration-status'), state.registrationOpen ? '新成员登记已开启' : '新成员登记已关闭');
  setText($('registration-button'), state.registrationOpen ? '关闭登记' : '开启登记');
  $('registration-button').setAttribute('aria-pressed', String(state.registrationOpen));
  renderConversations();
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
      const next = await api('/api/admin/state');
      if (current !== generation) return;
      state = next;
      switchConversation(next.activeConversationId);
      renderState();
      // Pin every history page to the same conversation, even if another client switches it.
      const conversationId = activeConversationId;
      for (let page = 0; page < 10; page += 1) {
        const batch = await api(`/api/messages?conversationId=${conversationId}&after=${cursor}&limit=200`);
        if (current !== generation || activeConversationId !== conversationId) return;
        if (batch.conversationId !== conversationId) throw new Error('对话历史与当前选择不一致，请等待重新同步。');
        renderMessages(batch.messages);
        cursor = batch.cursor;
        if (batch.messages.length < 200) break;
      }
      ready = true;
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
$('new-conversation-button').addEventListener('click', () => {
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
  $('conversation-select').value = String(activeConversationId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === activeConversationId) return;
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
$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('message-text').value;
  if (!text.trim()) { showError('消息内容不能为空。'); return; }
  if ($('message-recipient').selectedOptions[0]?.disabled) { showError('所选成员当前不可接收消息，请重新选择。'); return; }
  const to = $('message-recipient').value || null;
  const conversationId = activeConversationId;
  void mutate('/api/messages', { text, to, conversationId }, '消息已发送。', () => {
    if (activeConversationId === conversationId && $('message-text').value === text) $('message-text').value = '';
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
