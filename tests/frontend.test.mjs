import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = await readFile("app/static/index.html", "utf8");
const renderer = await readFile("app/static/vendor/markdown.js", "utf8");
const app = await readFile("app/static/app.js", "utf8");

async function workspace() {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const { window } = dom;
  const task = {
    task_id: "task-1", sequence_no: 1, status: "SUCCESS", progress: 100,
    input_text: "用户输入", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    result_json: {
      answer: "# 计算结果\n\n行内 $x_1^2$ 和 \\(y^2\\)\n\n$$\n\\frac{a}{b}=2\n$$\n\n\\[\nz=1\n\\]\n\n| 项目 | 值 |\n|---|---|\n| A | 12 |\n\n```js\nalert(1)\n```\n\n<img src=x onerror=alert(1)> [坏链接](javascript:alert(1))",
      risks: ["注意风险"],
    },
  };
  const session = {
    thread_id: "test", mode: "chat", tasks: [task],
    tool_events: [{ id: 1, task_id: "task-1", name: "calculate", arguments: '{"a":2}', output: '{"result":5}' }],
    memory: { summary: "", active_turns: 1, summarize_every_turns: 5 },
  };
  window.localStorage.setItem("agent.activeThread", "test");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (path) => ({
    ok: true,
    json: async () => JSON.parse(JSON.stringify(path === "/health" ? { status: "ok" }
      : path === "/sessions" ? [{ thread_id: "test", mode: "chat", first_message: "用户输入" }]
      : session)),
  });
  window.eval(renderer);
  window.eval(app);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { dom, window, session };
}

test("task decomposition is opt-in and sent with each request", async (t) => {
  const { dom, window } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  const toggle = doc.querySelector("#auto-split");
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  let submitted;
  const originalFetch = window.fetch;
  window.fetch = async (path, options) => {
    if (path === "/tasks") {
      submitted = JSON.parse(options.body);
      return { ok: true, json: async () => ({ thread_id: "test" }) };
    }
    return originalFetch(path, options);
  };
  doc.querySelector("#message").value = "复杂问题";
  doc.querySelector("#composer").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(submitted.auto_split, true);
  assert.equal(submitted.thread_id, "test");
});

test("renders Markdown and formulas without executing HTML or unsafe links", async (t) => {
  const { dom, window } = await workspace();
  t.after(() => dom.window.close());
  const answer = window.document.querySelector(".message-agent .markdown-body");
  assert.equal(answer.querySelector("h1").textContent, "计算结果");
  assert.equal(answer.querySelectorAll(".katex").length, 4);
  assert.equal(answer.querySelector("td").textContent, "A");
  assert.equal(answer.querySelector("pre code").textContent.trim(), "alert(1)");
  assert.equal(answer.querySelector("img, script, a[href^='javascript:']"), null);
  assert.match(answer.textContent, /<img src=x/);
});

test("message actions appear below each message and copy or collapse it", async (t) => {
  const { dom, window, session } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text) => { copied.push(text); } },
  });
  for (const card of doc.querySelectorAll(".message-group")) {
    const actions = card.querySelector(".message-actions");
    const body = card.querySelector(".message-body");
    assert.equal(body.nextElementSibling, actions);
    assert.equal(actions.querySelectorAll("button svg").length, 2);
    assert.equal(card.querySelector(".message-heading button"), null);
    const toggle = actions.querySelector("[aria-expanded]");
    assert.equal(toggle.getAttribute("aria-controls"), body.id);
    toggle.click();
    assert.equal(body.hidden, true);
    assert.match(toggle.getAttribute("aria-label"), /^展开/);
    toggle.click();
    assert.equal(body.hidden, false);
  }
  const copy = doc.querySelector(".message-agent .message-actions button");
  const label = copy.getAttribute("aria-label");
  copy.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copied, [session.tasks[0].result_json.answer]);
  assert.equal(copy.getAttribute("aria-label"), "已复制");
  assert.equal(copy.parentElement.querySelector('[role="status"]').textContent, "已复制");
  const codeCopy = doc.querySelector(".message-agent .code-copy");
  assert.ok(codeCopy.querySelector("svg"));
  codeCopy.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copied[1].trim(), "alert(1)");
  assert.equal(codeCopy.getAttribute("aria-label"), "已复制");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.equal(copy.getAttribute("aria-label"), label);
  assert.equal(codeCopy.getAttribute("aria-label"), "复制代码");
  assert.equal(copy.parentElement.querySelector('[role="status"]').textContent, "");
});

test("tool output stays in details and search locates it or collapsed messages", async (t) => {
  const { dom, window, session } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  assert.equal(doc.querySelector("#messages .tool-event, #messages .message-tool"), null);
  assert.match(doc.querySelector("#tool-list .tool-event").textContent, /"result":5/);
  doc.querySelector(".message-agent .message-action[aria-expanded]").click();
  assert.equal(doc.querySelector(".message-agent .message-body").hidden, true);
  assert.equal(doc.querySelector(".message-agent .message-preview").textContent, "计算结果…");
  doc.querySelector("#toggle-navigation").click();
  const input = doc.querySelector("#message-search");
  window.innerWidth = 1440;
  window.dispatchEvent(new window.Event("resize"));
  doc.querySelector("#toggle-details").click();
  assert.equal(doc.querySelector(".sheet").classList.contains("details-collapsed"), true);
  input.value = '"result":5';
  input.dispatchEvent(new window.Event("input"));
  assert.match(doc.querySelector("#navigation-caption").textContent, /1 条/);
  doc.querySelector(".navigation-result").click();
  assert.equal(doc.querySelector("#navigation-panel").hidden, true);
  assert.equal(doc.querySelector(".message-agent .message-body").hidden, true);
  assert.equal(doc.querySelector(".sheet").classList.contains("details-collapsed"), false);
  assert.equal(doc.querySelector("#tool-list .tool-event").open, true);
  assert.equal(doc.querySelector("#tool-list mark.search-hit").textContent, '"result":5');
  doc.querySelector("#toggle-navigation").click();
  input.value = "计算结果";
  input.dispatchEvent(new window.Event("input"));
  doc.querySelector(".navigation-result").click();
  assert.equal(doc.querySelector(".message-agent .message-body").hidden, false);
  assert.equal(doc.querySelector("#messages mark.search-hit").textContent, "计算结果");
  assert.equal(doc.querySelector("#tool-list mark.search-hit"), null);
  doc.querySelector("#collapse-all").click();
  assert.equal(doc.querySelectorAll(".message-body[hidden]").length, 2);
  assert.equal(doc.querySelectorAll(".message-preview:not([hidden])").length, 2);
  session.tasks[0].current_step = "更新状态";
  doc.querySelector("#refresh-sessions").click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(doc.querySelectorAll(".message-body[hidden]").length, 2);
  doc.querySelector("#collapse-all").click();
  assert.equal(doc.querySelectorAll(".message-body[hidden]").length, 0);
  assert.equal(doc.querySelectorAll(".message-preview:not([hidden])").length, 0);
});

test("tool search opens details on narrow screens", async (t) => {
  const { dom, window } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  window.innerWidth = 390;
  window.dispatchEvent(new window.Event("resize"));
  doc.querySelector("#toggle-navigation").click();
  const input = doc.querySelector("#message-search");
  input.value = '"result":5';
  input.dispatchEvent(new window.Event("input"));
  doc.querySelector(".navigation-result").click();
  assert.equal(doc.querySelector("#details").classList.contains("open"), true);
  assert.equal(doc.querySelector("#tool-list .tool-event").open, true);
});

test("memory preview expands and preserves its state on refresh", async (t) => {
  const { dom, window, session } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  session.memory.summary = `记忆首行\n${"更多内容".repeat(50)}`;
  doc.querySelector("#refresh-sessions").click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(doc.querySelector("#memory-content").hidden, true);
  assert.match(doc.querySelector("#memory-preview").textContent, /^记忆首行/);
  assert.ok(doc.querySelector("#memory-preview").textContent.length < session.memory.summary.length);
  doc.querySelector("#toggle-memory").click();
  assert.equal(doc.querySelector("#memory-content").textContent, session.memory.summary);
  assert.equal(doc.querySelector("#memory-preview").hidden, true);
  session.tasks[0].current_step = "更新状态";
  doc.querySelector("#refresh-sessions").click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(doc.querySelector("#toggle-memory").getAttribute("aria-expanded"), "true");
  assert.equal(doc.querySelector("#memory-content").hidden, false);
  doc.querySelector("#toggle-memory").click();
  assert.equal(doc.querySelector("#memory-preview").hidden, false);
});

test("desktop panels collapse independently and mobile drawers remain usable", async (t) => {
  const { dom, window } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  window.innerWidth = 1440;
  window.dispatchEvent(new window.Event("resize"));
  const left = doc.querySelector("#open-sidebar");
  const right = doc.querySelector("#toggle-details");
  left.click();
  right.click();
  assert.equal(doc.querySelector(".app").classList.contains("sidebar-collapsed"), true);
  assert.equal(doc.querySelector(".sheet").classList.contains("details-collapsed"), true);
  assert.equal(doc.querySelector("#conversation-header").hidden, true);
  assert.equal(doc.querySelector("#panel-dock").hidden, false);
  assert.equal(left.parentElement.id, "panel-dock");
  assert.equal(right.parentElement.id, "panel-dock");
  assert.equal(left.getAttribute("aria-expanded"), "false");
  assert.equal(right.getAttribute("aria-expanded"), "false");
  left.click();
  right.click();
  assert.equal(doc.querySelector("#conversation-header").hidden, false);
  assert.equal(doc.querySelector("#panel-dock").hidden, true);
  assert.equal(left.parentElement.id, "conversation-header");
  assert.equal(left.getAttribute("aria-expanded"), "true");
  assert.equal(right.getAttribute("aria-expanded"), "true");
  window.innerWidth = 390;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(doc.querySelector("#conversation-header").hidden, true);
  assert.equal(left.parentElement.id, "panel-dock");
  assert.equal(left.getAttribute("aria-expanded"), "false");
  assert.equal(right.getAttribute("aria-expanded"), "false");
  left.click();
  right.click();
  assert.equal(doc.querySelector("#conversation-header").hidden, false);
  assert.equal(doc.querySelector("#sidebar").classList.contains("open"), true);
  assert.equal(doc.querySelector("#details").classList.contains("open"), true);
  doc.querySelector("#close-sidebar").click();
  doc.querySelector("#close-details").click();
  assert.equal(doc.querySelector("#conversation-header").hidden, true);
  assert.equal(right.parentElement.id, "panel-dock");
  assert.equal(left.getAttribute("aria-expanded"), "false");
  assert.equal(right.getAttribute("aria-expanded"), "false");
});

test("composer grows and shrinks with input and resets after submission", async (t) => {
  const { dom, window } = await workspace();
  t.after(() => dom.window.close());
  const doc = window.document;
  const input = doc.querySelector("#message");
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => 21 * (input.value.split("\n").length),
  });
  input.value = "第一行\n第二行\n第三行";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(input.style.height, "63px");
  input.value = "一行";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(input.style.height, "21px");
  input.value = "第一行\n第二行";
  input.dispatchEvent(new window.Event("input"));
  doc.querySelector("#composer").requestSubmit();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(input.value, "");
  assert.equal(input.style.height, "21px");
});
