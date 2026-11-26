"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  threadId: localStorage.getItem("agent.activeThread") || null,
  mode: "chat",
  sessions: [],
  session: null,
  submitting: false,
  refreshBusy: false,
  selectionVersion: 0,
  renderedSession: "",
  renderedSessions: "",
  collapsed: new Set(),
  memoryExpanded: false,
};

const statuses = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCESS: "已完成",
  FAILURE: "执行失败",
  ENQUEUE_FAILED: "投递失败",
  RETRYABLE: "执行超时",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showError(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
}

function clearError() {
  $("notice").hidden = true;
  $("notice").textContent = "";
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `请求失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(detail);
  }
  return response.json();
}

function shortTime(value) {
  if (!value) return "—";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(time);
}

function statusClass(status) {
  if (status === "SUCCESS") return "success";
  if (["FAILURE", "ENQUEUE_FAILED", "RETRYABLE"].includes(status)) return "failure";
  if (status === "RUNNING") return "running";
  return "";
}

function sessionTitle(session) {
  const text = (session.first_message || "").replace(/\s+/g, " ").trim();
  return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : (session.mode === "contract" ? "合同审查" : "新会话");
}

function renderSessions() {
  const content = JSON.stringify([state.threadId, state.sessions]);
  if (state.renderedSessions === content) return;
  state.renderedSessions = content;
  const list = $("session-list");
  list.replaceChildren();
  if (!state.sessions.length) {
    list.append(node("p", "side-empty", "暂无会话，发送第一条消息开始。"));
    return;
  }
  for (const session of state.sessions) {
    const button = node("button", `session-item${session.thread_id === state.threadId ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("aria-label", `打开会话：${sessionTitle(session)}`);
    button.append(node("strong", "", sessionTitle(session)));
    const meta = node("span", "session-meta");
    meta.append(
      node("span", "", session.mode === "contract" ? "合同审查" : "通用问答"),
      node("span", "", shortTime(session.updated_at)),
    );
    button.append(meta);
    button.addEventListener("click", () => selectSession(session.thread_id));
    list.append(button);
  }
}

const actionIcons = {
  copy: "M8 8h11v12H8z M5 16H4V4h11v1",
  check: "M5 12l5 5 9-10",
  collapse: "M6 14l6-6 6 6",
  expand: "M6 10l6 6 6-6",
};
const copyTimers = new WeakMap();

function setActionIcon(button, name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", actionIcons[name]);
  svg.append(path);
  button.replaceChildren(svg);
}

function copyText(text, button) {
  if (!navigator.clipboard?.writeText) {
    showError("复制不可用，请检查浏览器剪贴板权限。");
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    if (!button.dataset.copyLabel) button.dataset.copyLabel = button.getAttribute("aria-label");
    clearTimeout(copyTimers.get(button));
    setActionIcon(button, "check");
    const feedback = button.parentElement.querySelector(".copy-feedback");
    if (feedback) feedback.textContent = "已复制";
    button.setAttribute("aria-label", "已复制");
    button.title = "已复制";
    copyTimers.set(button, setTimeout(() => {
      setActionIcon(button, "copy");
      button.setAttribute("aria-label", button.dataset.copyLabel);
      button.title = button.dataset.copyLabel;
      if (feedback) feedback.textContent = "";
      copyTimers.delete(button);
    }, 1500));
  }).catch((error) => showError(`复制失败：${error.message}`));
}

function messageBlock(role, text, task) {
  const key = `${task.task_id}:${role}`;
  const block = node("article", `message-group ${role === "你" ? "message-user" : "message-agent"}`);
  block.dataset.messageKey = key;
  block.tabIndex = -1;
  const heading = node("div", "message-heading");
  const identity = node("div", "message-identity");
  const avatar = node("span", `message-avatar${role === "你" ? " user" : ""}`, role === "你" ? "你" : "A");
  avatar.setAttribute("aria-hidden", "true");
  identity.append(
    avatar,
    node("strong", "", role),
    node("span", "message-turn", `第 ${task.sequence_no || "—"} 轮`),
  );
  const actions = node("div", "message-actions");
  const copy = node("button", "message-action");
  copy.type = "button";
  copy.setAttribute("aria-label", `复制第 ${task.sequence_no || "—"} 轮${role}的原始内容`);
  copy.title = copy.getAttribute("aria-label");
  setActionIcon(copy, "copy");
  copy.addEventListener("click", () => copyText(text, copy));
  const toggle = node("button", "message-action");
  toggle.type = "button";
  const body = node("div", "message-body");
  body.id = `message-body-${task.task_id}-${role === "你" ? "user" : "agent"}`;
  toggle.setAttribute("aria-controls", body.id);
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() || "暂无内容";
  const preview = node("div", "message-preview", `${firstLine.replace(/^#{1,6}\s+/, "")}…`);
  const updateToggle = () => {
    const collapsed = state.collapsed.has(key);
    body.hidden = collapsed;
    preview.hidden = !collapsed;
    setActionIcon(toggle, collapsed ? "expand" : "collapse");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", `${collapsed ? "展开" : "折叠"}第 ${task.sequence_no || "—"} 轮${role}的内容`);
    toggle.title = toggle.getAttribute("aria-label");
  };
  toggle.addEventListener("click", () => {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    updateToggle();
    updateCollapseLabel();
  });
  actions.append(copy, toggle);
  const copyFeedback = node("span", "visually-hidden copy-feedback");
  copyFeedback.setAttribute("role", "status");
  actions.append(copyFeedback);
  heading.append(identity, node("time", "", shortTime(role === "你" ? task.created_at : task.updated_at)));
  const content = node("div", "message-text markdown-body");
  if (typeof window.renderAgentMarkdown === "function") {
    content.innerHTML = window.renderAgentMarkdown(text);
  } else {
    content.textContent = text;
    showError("Markdown 渲染器未加载，当前显示原始文本。请检查静态资源。");
  }
  for (const pre of content.querySelectorAll("pre")) {
    const copyCode = node("button", "code-copy");
    copyCode.type = "button";
    copyCode.setAttribute("aria-label", "复制代码");
    copyCode.title = "复制代码";
    setActionIcon(copyCode, "copy");
    copyCode.addEventListener("click", () => copyText(pre.querySelector("code")?.textContent || pre.textContent, copyCode));
    const codeFeedback = node("span", "visually-hidden copy-feedback");
    codeFeedback.setAttribute("role", "status");
    pre.prepend(copyCode, codeFeedback);
  }
  body.append(content);
  block.append(heading, preview, body, actions);
  updateToggle();
  return { block, body, content };
}

function updateCollapseLabel() {
  const cards = [...$("messages").querySelectorAll("[data-message-key]")];
  const allCollapsed = cards.length > 0 && cards.every((card) => state.collapsed.has(card.dataset.messageKey));
  $("collapse-all").textContent = allCollapsed ? "展开全部" : "折叠全部";
}

function renderMessages(tasks) {
  const list = $("messages");
  const shouldScroll = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const oldScroll = list.scrollTop;
  $("reading-bar").hidden = !tasks.length;
  $("turn-count").textContent = `${tasks.length} 轮`;
  if (!tasks.length) {
    list.replaceChildren($("empty-state") || makeEmptyState());
    $("navigation-panel").hidden = true;
    $("toggle-navigation").setAttribute("aria-expanded", "false");
    return;
  }
  list.replaceChildren();
  for (const task of tasks) {
    const user = messageBlock("你", task.input_text, task);
    list.append(user.block);
    const result = task.result_json;
    let response;
    if (task.status === "SUCCESS" && result) {
      response = messageBlock("Agent", result.answer || result.report || "", task);
      if (Array.isArray(result.risks) && result.risks.length) {
        const risks = node("div", "risk-section");
        risks.append(node("strong", "", "风险提示"));
        const items = node("ul", "");
        for (const risk of result.risks) items.append(node("li", "", risk));
        risks.append(items);
        response.body.append(risks);
      }
    } else {
      response = messageBlock("Agent", task.error || task.current_step || "等待执行", task);
    }
    const feedback = node("div", `message-feedback ${statusClass(task.status)}`);
    feedback.append(node("span", `status-dot ${statusClass(task.status)}`), node("span", "", statuses[task.status] || task.status));
    if (Number.isFinite(task.progress)) feedback.append(node("span", "", `${task.progress}%`));
    response.body.prepend(feedback);
    list.append(response.block);
  }
  updateCollapseLabel();
  renderNavigation();
  list.scrollTop = shouldScroll ? list.scrollHeight : oldScroll;
}

function renderNavigation() {
  const query = $("message-search").value.trim().toLocaleLowerCase();
  const results = $("navigation-results");
  results.replaceChildren();
  let count = 0;
  for (const card of $("messages").querySelectorAll("[data-message-key]")) {
    const body = card.querySelector(".message-body");
    const text = body.textContent.replace(/\s+/g, " ").trim();
    const index = query ? text.toLocaleLowerCase().indexOf(query) : -1;
    if (query && index < 0) continue;
    const button = node("button", "navigation-result");
    button.type = "button";
    const identity = card.querySelector(".message-identity");
    const label = `${identity.querySelector("strong").textContent} · ${identity.querySelector(".message-turn").textContent}`;
    button.append(node("strong", "", label));
    button.append(node("span", "", query ? text.slice(Math.max(0, index - 25), index + query.length + 45) : text.slice(0, 70)));
    button.addEventListener("click", () => jumpToCard(card, query));
    results.append(button);
    count++;
    if (!query) {
      for (const heading of card.querySelectorAll(".markdown-body h1, .markdown-body h2, .markdown-body h3")) {
        const sub = node("button", "navigation-heading", heading.textContent);
        sub.type = "button";
        sub.addEventListener("click", () => jumpToCard(card, "", heading));
        results.append(sub);
      }
    }
  }
  if (query) {
    for (const event of state.session?.tool_events || []) {
      const text = `${event.name} 输入：${event.arguments} 输出：${event.output}`;
      const index = text.toLocaleLowerCase().indexOf(query);
      if (index < 0) continue;
      const task = state.session.tasks.find((item) => item.task_id === event.task_id);
      const button = node("button", "navigation-result");
      button.type = "button";
      button.append(
        node("strong", "", `工具调用 · 第 ${task?.sequence_no || "—"} 轮`),
        node("span", "", text.slice(Math.max(0, index - 25), index + query.length + 45)),
      );
      button.addEventListener("click", () => jumpToTool(event.id, query));
      results.append(button);
      count++;
    }
  }
  $("navigation-caption").textContent = query ? `找到 ${count} 条结果` : "按轮次与标题跳转";
  if (!count) results.append(node("p", "detail-empty", "没有匹配的结果"));
}

function highlightMatch(root, query) {
  for (const mark of document.querySelectorAll("mark.search-hit")) {
    mark.replaceWith(document.createTextNode(mark.textContent));
  }
  if (query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) => text.parentElement.closest(".katex-mathml") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text;
    while ((text = walker.nextNode())) {
      const index = text.nodeValue.toLocaleLowerCase().indexOf(query);
      if (index < 0) continue;
      const match = text.splitText(index);
      match.splitText(query.length);
      const mark = node("mark", "search-hit", match.nodeValue);
      match.replaceWith(mark);
      return mark;
    }
  }
  return null;
}

function jumpToCard(card, query, target = card) {
  const key = card.dataset.messageKey;
  if (state.collapsed.has(key)) {
    card.querySelector(".message-action[aria-expanded]").click();
  }
  target = highlightMatch(card.querySelector(".message-body"), query) || target;
  $("navigation-panel").hidden = true;
  $("toggle-navigation").setAttribute("aria-expanded", "false");
  card.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "smooth" });
}

function jumpToTool(id, query) {
  const detail = [...$("tool-list").querySelectorAll(".tool-event")]
    .find((item) => item.dataset.id === String(id));
  if (!detail) {
    showError("工具调用记录已不可用，请刷新会话。");
    return;
  }
  if (window.innerWidth > 1100) document.querySelector(".sheet").classList.remove("details-collapsed");
  else $("details").classList.add("open");
  updatePanelControls();
  detail.open = true;
  const target = highlightMatch(detail, query) || detail;
  $("navigation-panel").hidden = true;
  $("toggle-navigation").setAttribute("aria-expanded", "false");
  detail.querySelector("summary").focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "smooth" });
}

function makeEmptyState() {
  const empty = node("div", "empty-state");
  empty.id = "empty-state";
  const mark = node("div", "empty-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.append(node("i"), node("i"), node("i"));
  const examples = node("div", "examples");
  populateExamples(examples);
  empty.append(mark, node("h2", "", "让想法开始流动"), node("p", "", "输入问题或合同内容。你可以继续追问，Agent 会记住同一会话中的上下文。"), examples);
  return empty;
}

function populateExamples(examples) {
  examples.replaceChildren();
  const options = state.mode === "contract" ? [
    ["审查付款条款", "请审查：甲方应在验收合格后30日内付款。"],
    ["分析违约风险", "请分析：任何一方违约时，应承担相应责任。"],
  ] : [
    ["记住我的偏好", "请记住，我喜欢简洁的回答。"],
    ["试试四则计算", "帮我计算 128 乘以 37。"],
  ];
  for (const [label, value] of options) {
    const button = node("button", "", label);
    button.type = "button";
    const arrow = node("span", "", "↗");
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow);
    button.addEventListener("click", () => { $("message").value = value; resizeComposer(); $("message").focus(); });
    examples.append(button);
  }
}

function renderDetails(session) {
  const tasks = session?.tasks || [];
  const events = session?.tool_events || [];
  const memory = session?.memory;
  $("task-count").textContent = String(tasks.length);
  $("tool-count").textContent = String(events.length);
  $("memory-count").textContent = memory ? `${memory.active_turns} / ${memory.summarize_every_turns} 轮` : "—";
  $("memory-description").textContent = memory
    ? `每 ${memory.summarize_every_turns} 个成功轮次生成一次摘要。`
    : "选择会话后查看记忆。";
  updateMemory(memory?.summary || "");

  const taskList = $("task-list");
  taskList.replaceChildren();
  if (!tasks.length) taskList.append(node("p", "detail-empty", "还没有任务"));
  for (const task of [...tasks].reverse()) {
    const row = node("div", "task-row");
    const head = node("div", "task-row-head");
    head.append(node("span", `status-dot ${statusClass(task.status)}`), node("span", "", statuses[task.status] || task.status));
    head.append(node("time", "", shortTime(task.updated_at)));
    const progress = Number.isFinite(task.progress) ? `${task.progress}% · ` : "";
    row.append(head, node("p", "", progress + (task.error || task.current_step || "—")));
    taskList.append(row);
  }

  const toolList = $("tool-list");
  const openEvents = new Set(
    Array.from(toolList.querySelectorAll("details[open]"), (item) => item.dataset.id),
  );
  toolList.replaceChildren();
  if (!events.length) toolList.append(node("p", "detail-empty", "工具调用会在执行时显示"));
  for (const event of [...events].reverse()) {
    const detail = node("details", "tool-event");
    detail.dataset.id = String(event.id);
    detail.open = openEvents.has(String(event.id));
    const label = event.name === "calculate" ? "四则计算" : event.name === "current_time" ? "当前日期时间" : event.name;
    const task = tasks.find((item) => item.task_id === event.task_id);
    const turn = task?.sequence_no ? `第 ${task.sequence_no} 轮 · ` : "";
    detail.append(node("summary", "", `${turn}${label} · ${shortTime(event.created_at)}`));
    detail.append(node("pre", "", `输入：${event.arguments}\n输出：${event.output}`));
    toolList.append(detail);
  }
}

function updateMemory(summary) {
  const hasSummary = Boolean(summary);
  const chars = Array.from(summary);
  $("memory-content").textContent = summary || "暂无摘要";
  $("memory-content").hidden = hasSummary && !state.memoryExpanded;
  $("memory-preview").textContent = `${chars.slice(0, 100).join("")}${chars.length > 100 ? "…" : ""}`;
  $("memory-preview").hidden = !hasSummary || state.memoryExpanded;
  $("toggle-memory").hidden = !hasSummary;
  $("toggle-memory").textContent = state.memoryExpanded ? "收起记忆" : "展开记忆";
  $("toggle-memory").setAttribute("aria-expanded", String(state.memoryExpanded));
}

function updatePanelControls() {
  const desktopSidebar = window.innerWidth > 900;
  const sidebarOpen = desktopSidebar
    ? !document.querySelector(".app").classList.contains("sidebar-collapsed")
    : $("sidebar").classList.contains("open");
  const desktopDetails = window.innerWidth > 1100;
  const detailsOpen = desktopDetails
    ? !document.querySelector(".sheet").classList.contains("details-collapsed")
    : $("details").classList.contains("open");
  const sidebarButton = $("open-sidebar");
  const detailsButton = $("toggle-details");
  const header = $("conversation-header");
  const dock = $("panel-dock");
  const focused = document.activeElement;
  const moving = sidebarButton.parentElement !== (sidebarOpen ? header : dock);
  if (moving) {
    if (sidebarOpen) {
      header.insertBefore(sidebarButton, header.firstChild);
      header.append(detailsButton);
    } else {
      dock.append(sidebarButton, detailsButton);
    }
  }
  header.hidden = !sidebarOpen;
  dock.hidden = sidebarOpen;
  sidebarButton.setAttribute("aria-expanded", String(sidebarOpen));
  sidebarButton.setAttribute("aria-label", sidebarOpen ? "收起会话列表" : "打开会话列表");
  sidebarButton.title = sidebarButton.getAttribute("aria-label");
  $("sidebar-toggle-label").textContent = sidebarOpen ? "收起会话" : "打开会话";
  detailsButton.setAttribute("aria-expanded", String(detailsOpen));
  detailsButton.setAttribute("aria-label", detailsOpen ? "收起执行详情" : "打开执行详情");
  detailsButton.title = detailsButton.getAttribute("aria-label");
  $("details-toggle-label").textContent = desktopDetails ? (detailsOpen ? "收起详情" : "展开详情") : "执行详情";
  if (moving && (focused === sidebarButton || focused === detailsButton)) focused.focus();
  resizeComposer();
}

function resizeComposer() {
  const message = $("message");
  message.style.height = "auto";
  message.style.height = `${message.scrollHeight}px`;
}

function setMode(mode) {
  const changed = state.mode !== mode;
  state.mode = mode;
  $("current-mode-label").textContent = mode === "contract" ? "合同审查" : "通用问答";
  for (const button of document.querySelectorAll(".mode-option")) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  const examples = $("empty-state")?.querySelector(".examples");
  if (changed && examples) populateExamples(examples);
}

function renderSession() {
  const session = state.session;
  $("mode-picker").hidden = Boolean(state.threadId);
  if (session) setMode(session.mode);
  const selected = state.sessions.find((item) => item.thread_id === state.threadId);
  $("conversation-title").textContent = selected ? sessionTitle(selected) : state.threadId ? "会话" : "新会话";
  $("conversation-subtitle").textContent = session
    ? `会话 ${session.thread_id} · 每轮独立排队并共享记忆`
    : state.threadId ? "正在加载会话…" : "开始对话，Agent 会保留上下文并在需要时调用工具。";
  $("conversation-subtitle").classList.toggle("session-subtitle", Boolean(state.threadId));
  $("conversation-subtitle").title = $("conversation-subtitle").textContent;
  updateComposer();
  const sessionContent = JSON.stringify(session);
  if (state.renderedSession !== sessionContent) {
    state.renderedSession = sessionContent;
    renderMessages(session?.tasks || []);
    renderDetails(session);
  }
  renderSessions();
}

function updateComposer() {
  const loadingSession = Boolean(state.threadId && !state.session);
  $("send").disabled = state.submitting || loadingSession;
  $("message").disabled = loadingSession;
}

async function selectSession(id) {
  const version = ++state.selectionVersion;
  state.threadId = id;
  state.session = null;
  state.collapsed.clear();
  state.memoryExpanded = false;
  $("message-search").value = "";
  localStorage.setItem("agent.activeThread", id);
  $("sidebar").classList.remove("open");
  $("details").classList.remove("open");
  updatePanelControls();
  clearError();
  renderSession();
  try {
    const session = await request(`/sessions/${encodeURIComponent(id)}`);
    if (version !== state.selectionVersion) return;
    state.session = session;
    renderSession();
  } catch (error) {
    if (version === state.selectionVersion) showError(`无法加载会话：${error.message}`);
  }
}

async function refresh() {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  const version = state.selectionVersion;
  const threadId = state.threadId;
  try {
    const [health, sessions, session] = await Promise.all([
      request("/health"),
      request("/sessions"),
      threadId ? request(`/sessions/${encodeURIComponent(threadId)}`) : Promise.resolve(null),
    ]);
    $("connection-dot").className = "connection-dot online";
    $("connection-status").textContent = health.status === "ok" ? "API 已连接" : "API 状态未知";
    state.sessions = sessions;
    if (version === state.selectionVersion) state.session = session;
    renderSession();
  } catch (error) {
    $("connection-dot").className = "connection-dot offline";
    $("connection-status").textContent = "刷新失败";
    showError(`无法刷新数据：${error.message}`);
  } finally {
    state.refreshBusy = false;
  }
}

function newSession() {
  state.selectionVersion += 1;
  state.threadId = null;
  state.session = null;
  state.collapsed.clear();
  state.memoryExpanded = false;
  $("message-search").value = "";
  localStorage.removeItem("agent.activeThread");
  $("sidebar").classList.remove("open");
  $("details").classList.remove("open");
  updatePanelControls();
  clearError();
  setMode("chat");
  renderSession();
  $("message").focus();
}

async function submitMessage(event) {
  event.preventDefault();
  const message = $("message").value.trim();
  if (!message || state.submitting || (state.threadId && !state.session)) return;
  state.submitting = true;
  updateComposer();
  const threadId = state.threadId;
  const version = state.selectionVersion;
  const payload = { mode: state.mode, message, auto_split: $("auto-split").checked };
  if (threadId) payload.thread_id = threadId;
  clearError();
  try {
    const created = await request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (version === state.selectionVersion) {
      $("message").value = "";
      resizeComposer();
      state.threadId = created.thread_id;
      state.selectionVersion += 1;
      localStorage.setItem("agent.activeThread", created.thread_id);
    }
    await refresh();
  } catch (error) {
    showError(`提交失败：${error.message}。若网络中断，请先检查会话列表，避免重复提交。`);
    await refresh();
  } finally {
    state.submitting = false;
    updateComposer();
  }
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
$("new-session").addEventListener("click", newSession);
$("refresh-sessions").addEventListener("click", refresh);
$("open-sidebar").addEventListener("click", () => {
  if (window.innerWidth > 900) document.querySelector(".app").classList.toggle("sidebar-collapsed");
  else $("sidebar").classList.toggle("open");
  updatePanelControls();
});
$("close-sidebar").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
  updatePanelControls();
  $("open-sidebar").focus();
});
$("toggle-details").addEventListener("click", () => {
  if (window.innerWidth > 1100) document.querySelector(".sheet").classList.toggle("details-collapsed");
  else $("details").classList.toggle("open");
  updatePanelControls();
});
$("close-details").addEventListener("click", () => {
  $("details").classList.remove("open");
  updatePanelControls();
  $("toggle-details").focus();
});
$("toggle-memory").addEventListener("click", () => {
  state.memoryExpanded = !state.memoryExpanded;
  updateMemory(state.session?.memory?.summary || "");
});
window.addEventListener("resize", updatePanelControls);
$("toggle-navigation").addEventListener("click", () => {
  const panel = $("navigation-panel");
  panel.hidden = !panel.hidden;
  $("toggle-navigation").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) {
    renderNavigation();
    $("message-search").focus();
  }
});
$("message-search").addEventListener("input", renderNavigation);
$("collapse-all").addEventListener("click", () => {
  const cards = [...$("messages").querySelectorAll("[data-message-key]")];
  const expand = cards.every((card) => state.collapsed.has(card.dataset.messageKey));
  for (const card of cards) {
    if (state.collapsed.has(card.dataset.messageKey) === expand) {
      card.querySelector(".message-action[aria-expanded]").click();
    }
  }
});
$("latest-message").addEventListener("click", () => {
  $("messages").lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
});
$("composer").addEventListener("submit", submitMessage);
$("message").addEventListener("input", resizeComposer);
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
setMode("chat");
updatePanelControls();
renderSession();
refresh();
setInterval(refresh, 2500);
