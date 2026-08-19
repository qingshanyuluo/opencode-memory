const state = {
  stats: null,
  source: "",
  query: "",
  offset: 0,
  limit: 40,
  total: 0,
  loading: false,
  knowledge: { entries: [], links: [] },
  knowledgeLoaded: false,
  backfill: null,
  hierarchy: null,
  telemetry: null,
  recalls: [],
  observabilityLoaded: false,
};

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat("zh-CN");
const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

async function api(path, init) {
  const response = await fetch(path, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function renderStats(stats) {
  const metrics = [
    [stats.sessions, "sessions"],
    [stats.toolEvents, "tool events"],
    [stats.behavior.capsules, "behavior graphs"],
    [stats.behavior.nodes, "behavior nodes"],
    [stats.artifacts, "anchors"],
    [stats.toolErrors, "failures"],
  ];
  $("#metric-grid").classList.remove("skeleton-block");
  $("#metric-grid").innerHTML = metrics.map(([value, label]) =>
    `<div class="metric"><b>${number.format(value)}</b><span>${label}</span></div>`
  ).join("");

  $("#source-list").innerHTML = [
    `<button class="source-button ${state.source === "" ? "active" : ""}" data-source=""><span>all sources</span><b>${number.format(stats.sessions)}</b></button>`,
    ...stats.sources.map((source) =>
      `<button class="source-button ${state.source === source.id ? "active" : ""}" data-source="${escapeHtml(source.id)}"><span>${escapeHtml(source.id)}</span><b>${number.format(source.sessions)}</b></button>`
    ),
  ].join("");

  const latestScan = Math.max(...stats.sources.map(({ scannedAt }) => scannedAt));
  $("#scan-time").textContent = `SCANNED ${date.format(latestScan)}`;

  const maxTool = Math.max(...stats.topTools.map(({ count }) => count), 1);
  $("#tool-chart").innerHTML = stats.topTools.slice(0, 8).map((tool) => `
    <div class="bar-row ${tool.errors > 0 ? "has-errors" : ""}" title="${number.format(tool.errors)} errors">
      <span>${escapeHtml(tool.tool)}</span>
      <div class="bar-track"><i class="bar-fill" style="width:${Math.max(2, tool.count / maxTool * 100)}%"></i></div>
      <b>${number.format(tool.count)}</b>
    </div>`).join("");

  $("#directory-list").innerHTML = stats.topDirectories.map((entry) =>
    `<li><span title="${escapeHtml(entry.directory)}">${escapeHtml(entry.directory)}</span><b>${number.format(entry.count)}</b></li>`
  ).join("");
  $("#artifact-kinds").innerHTML = stats.artifactKinds.map((entry) =>
    `<span class="artifact-pill">${escapeHtml(entry.kind)} · ${number.format(entry.count)}</span>`
  ).join("");
}

function renderSessions(items, append) {
  const list = $("#session-list");
  if (!append) list.innerHTML = "";
  if (!items.length && !append) {
    list.append($("#empty-template").content.cloneNode(true));
    return;
  }

  list.insertAdjacentHTML("beforeend", items.map((session) => {
    const updated = new Date(session.timeUpdated);
    return `<button class="session-row" data-source="${escapeHtml(session.sourceId)}" data-session="${escapeHtml(session.sessionId)}">
      <span class="session-time"><b>${date.format(updated)}</b>${time.format(updated)}</span>
      <span class="session-copy"><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(session.intentPreview || "无用户文本；仅保留会话元数据")}</p></span>
      <span class="session-tags">
        <i class="chip source">${escapeHtml(session.sourceId)}</i>
        ${session.hasBehavior ? `<i class="chip memory">behavior</i>` : ""}
        <i class="chip">${number.format(session.toolCallCount)} tools</i>
        ${session.toolErrorCount ? `<i class="chip danger">${session.toolErrorCount} errors</i>` : ""}
      </span>
    </button>`;
  }).join(""));
}

async function loadSessions({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!append) state.offset = 0;
  $("#result-count").textContent = "检索中…";

  try {
    const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.query) params.set("q", state.query);
    if (state.source) params.set("source", state.source);
    const result = await api(`/api/sessions?${params}`);
    state.total = result.total;
    renderSessions(result.items, append);
    state.offset += result.items.length;
    $("#result-count").textContent = `${number.format(result.total)} 个会话 · 当前展示 ${number.format(state.offset)}`;
    $("#load-more").hidden = state.offset >= state.total;
  } catch (error) {
    $("#session-list").innerHTML = `<div class="empty-state"><b>索引读取失败</b><span>${escapeHtml(error.message)}</span></div>`;
    $("#result-count").textContent = "读取失败";
  } finally {
    state.loading = false;
  }
}

function groupArtifacts(artifacts) {
  return artifacts.reduce((groups, artifact) => {
    (groups[artifact.kind] ||= []).push(artifact);
    return groups;
  }, {});
}

function renderDetail(session) {
  const groups = groupArtifacts(session.artifacts);
  const artifactHtml = Object.entries(groups).map(([kind, artifacts]) => `
    <div class="artifact-group"><h4>${escapeHtml(kind)} · ${artifacts.length}</h4>
      ${artifacts.slice(0, 120).map(({ value }) => `<div class="artifact-value">${escapeHtml(value)}</div>`).join("")}
    </div>`).join("");

  const toolHtml = session.tools.slice(0, 300).map((tool) => `
    <div class="tool-event ${tool.status === "error" ? "failed" : ""}">
      <div class="tool-event-head"><b>${escapeHtml(tool.tool)} · ${escapeHtml(tool.status)}</b><span>${time.format(tool.timeCreated)}</span></div>
      ${tool.inputSummary ? `<pre>${escapeHtml(tool.inputSummary)}</pre>` : ""}
      ${tool.errorSignature ? `<pre>↳ ${escapeHtml(tool.errorSignature)}</pre>` : ""}
    </div>`).join("");

  const behaviorHtml = renderBehavior(session.behavior);

  $("#detail-content").innerHTML = `
    <header class="detail-header">
      <p class="eyebrow">${escapeHtml(session.sourceId)} / ${escapeHtml(session.sessionId)}</p>
      <h2>${escapeHtml(session.title)}</h2>
      <div class="detail-path">${escapeHtml(session.directory)}</div>
      <div class="detail-meta">
        <span class="chip">${number.format(session.messageCount)} messages</span>
        <span class="chip">${number.format(session.toolCallCount)} tools</span>
        <span class="chip ${session.toolErrorCount ? "danger" : ""}">${number.format(session.toolErrorCount)} errors</span>
        <span class="chip">opencode ${escapeHtml(session.opencodeVersion)}</span>
      </div>
    </header>
    <div class="detail-body">
      ${behaviorHtml}
      <section class="detail-section"><p class="eyebrow">User intent · sanitized</p><h3>用户请求轨迹</h3><pre class="intent-copy">${escapeHtml(session.userIntent || "无用户文本")}</pre></section>
      <section class="detail-section"><p class="eyebrow">Derived anchors</p><h3>可回源锚点</h3>${artifactHtml || "<p>无锚点</p>"}</section>
      <section class="detail-section"><p class="eyebrow">Normalized trace</p><h3>工具轨迹</h3><div class="tool-timeline">${toolHtml || "<p>无工具调用</p>"}</div></section>
      <section class="detail-section"><p class="eyebrow">Provenance</p><pre class="code-block">source=${escapeHtml(session.sourceId)}\nsession=${escapeHtml(session.sessionId)}\nproject=${escapeHtml(session.projectId)}\nhash=${escapeHtml(session.contentHash)}</pre></section>
    </div>`;
}

function renderBehavior(behavior) {
  if (!behavior) {
    return `<section class="detail-section behavior-empty"><p class="eyebrow">L1b behavior graph</p><h3>尚未结晶</h3><p>该会话只有 L1a 索引，尚未提取目标、假设、证据、修正和决策。</p></section>`;
  }
  const sequenceById = new Map(behavior.nodes.map((node) => [node.id, node.sequence + 1]));
  const outgoing = behavior.edges.reduce((map, edge) => {
    (map[edge.sourceNodeId] ||= []).push(edge);
    return map;
  }, {});
  const nodes = behavior.nodes.map((node) => {
    const links = (outgoing[node.id] || []).map((edge) =>
      `<span>${escapeHtml(edge.relation)} → #${sequenceById.get(edge.targetNodeId) ?? "?"}</span>`
    ).join("");
    return `<article class="behavior-node type-${escapeHtml(node.type)} status-${escapeHtml(node.status)}">
      <div class="behavior-index">${String(node.sequence + 1).padStart(2, "0")}</div>
      <div class="behavior-copy">
        <div class="behavior-label"><b>${escapeHtml(node.type)}</b><span>${escapeHtml(node.status)} · ${Math.round(node.confidence * 100)}%</span></div>
        <p>${escapeHtml(node.content)}</p>
        <div class="behavior-links">${links}</div>
        <details><summary>${node.sourcePartIds.length} 个证据 part</summary><code>${escapeHtml(node.sourcePartIds.join("\n"))}</code></details>
      </div>
    </article>`;
  }).join("");
  const summary = behavior.capsule.summary || "无摘要";
  const summaryPreview = summary.length > 520 ? `${summary.slice(0, 520)}…` : summary;
  const fullSummary = summary.length > 520
    ? `<details class="behavior-summary-full"><summary>查看 ${behavior.capsule.chunkCount} 个分块的完整摘要</summary><pre>${escapeHtml(summary)}</pre></details>`
    : "";
  return `<section class="detail-section behavior-section">
    <p class="eyebrow">L1b behavior graph · ${escapeHtml(behavior.capsule.model)}</p>
    <div class="behavior-title"><h3>模型行为与认知轨迹</h3><span class="outcome outcome-${escapeHtml(behavior.capsule.outcome)}">${escapeHtml(behavior.capsule.outcome)}</span></div>
    <p class="behavior-summary">${escapeHtml(summaryPreview)}</p>${fullSummary}
    <div class="behavior-legend"><span>目标</span><span>假设</span><span>证据</span><span>修正</span><span>决策</span><span>结果</span></div>
    <div class="behavior-stream">${nodes}</div>
  </section>`;
}

function filteredKnowledge() {
  const query = $("#knowledge-search").value.trim().toLowerCase();
  const activeEntries = state.knowledge.entries.filter((entry) => entry.status !== "rejected" && entry.validTo == null);
  if (!query) {
    const ids = new Set(activeEntries.map(({ id }) => id));
    return { entries: activeEntries, links: state.knowledge.links.filter((link) => ids.has(link.sourceEntryId) && ids.has(link.targetEntryId)), query: "" };
  }
  const ids = new Set(activeEntries.filter((entry) =>
    [entry.title, entry.content, entry.role, entry.kind, entry.namespace, entry.domain, ...(entry.tags || [])]
      .some((value) => String(value || "").toLowerCase().includes(query))
  ).map(({ id }) => id));
  const structural = new Set(["IMPLEMENTS", "EXTENDS", "INSTANCE_OF"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of state.knowledge.links) {
      if (structural.has(link.relation) && ids.has(link.sourceEntryId) && !ids.has(link.targetEntryId)) {
        ids.add(link.targetEntryId);
        changed = true;
      }
    }
  }
  for (const link of state.knowledge.links) {
    if (link.relation === "REFERENCES" && ids.has(link.sourceEntryId)) ids.add(link.targetEntryId);
  }
  const entries = activeEntries.filter(({ id }) => ids.has(id));
  return {
    entries,
    links: state.knowledge.links.filter((link) => ids.has(link.sourceEntryId) && ids.has(link.targetEntryId)),
    query,
  };
}

function domainOf(entry) {
  return entry.domain || "未分类";
}

function listRow(entry, relation = "", childCount = 0) {
  const confidence = `${Math.round(entry.confidence * 100)}%`;
  return `<button class="list-row role-${escapeHtml(entry.role)}" data-memory-id="${escapeHtml(entry.id)}" type="button">
    <span class="list-role">${escapeHtml(entry.role)}</span>
    <span class="list-title">${escapeHtml(entry.title)}${relation ? `<small>${escapeHtml(relation)}</small>` : ""}</span>
    <span class="list-meta">${escapeHtml(entry.kind || "")} ${confidence}${childCount ? ` · ${childCount} 子项` : ""}</span>
  </button>`;
}

function renderKnowledge() {
  const graph = filteredKnowledge();
  $("#knowledge-count").textContent = number.format(graph.entries.length);
  $("#relation-count").textContent = number.format(graph.links.length);

  const byDomain = new Map();
  for (const entry of graph.entries) {
    const domain = domainOf(entry);
    const list = byDomain.get(domain) ?? [];
    list.push(entry);
    byDomain.set(domain, list);
  }
  const domains = [...byDomain.entries()]
    .map(([domain, entries]) => ({ domain, entries }))
    .sort((left, right) => {
      if (left.domain === "未分类") return 1;
      if (right.domain === "未分类") return -1;
      return right.entries.length - left.entries.length;
    });

  $("#knowledge-tree").innerHTML = domains.length
    ? domains.map(({ domain, entries }) => `<button class="domain-index" data-domain="${escapeHtml(domain)}" type="button">
        <span>${escapeHtml(domain)}</span><b>${number.format(entries.length)}</b>
      </button>`).join("")
    : `<div class="empty-state"><b>没有命中</b><span>调整检索词。</span></div>`;

  renderKnowledgeHierarchy(graph, domains);
}

function renderKnowledgeHierarchy(graph, domains) {
  const container = $("#knowledge-hierarchy");
  $("#graph-empty").hidden = graph.entries.length > 0;
  container.style.display = graph.entries.length ? "block" : "none";
  if (!graph.entries.length) { container.innerHTML = ""; return; }

  const byId = new Map(graph.entries.map((entry) => [entry.id, entry]));
  const structural = new Set(["IMPLEMENTS", "EXTENDS", "INSTANCE_OF"]);
  const outgoing = new Map();
  for (const link of graph.links) {
    const list = outgoing.get(link.sourceEntryId) ?? [];
    list.push(link);
    outgoing.set(link.sourceEntryId, list);
  }
  const scoreParent = (link) => {
    const parent = byId.get(link.targetEntryId);
    if (!parent) return 99;
    if (link.relation === "INSTANCE_OF") return 0;
    if (parent.role === "abstract") return 0;
    if (parent.role === "interface" && parent.kind !== "能力域") return 1;
    if (parent.kind === "能力域") return 3;
    return 2;
  };
  const primaryParent = new Map();
  const primaryRelation = new Map();
  const crossParents = new Map();
  for (const entry of graph.entries) {
    const parents = (outgoing.get(entry.id) ?? []).filter((link) => structural.has(link.relation) && byId.has(link.targetEntryId)).sort((a, b) => scoreParent(a) - scoreParent(b));
    if (parents[0]) {
      primaryParent.set(entry.id, parents[0].targetEntryId);
      primaryRelation.set(entry.id, parents[0].relation);
      crossParents.set(entry.id, parents.slice(1));
    }
  }
  const children = new Map();
  for (const [childId, parentId] of primaryParent) {
    const list = children.get(parentId) ?? [];
    list.push(childId);
    children.set(parentId, list);
  }
  const references = new Map();
  for (const link of graph.links) {
    if (link.relation === "REFERENCES" && byId.get(link.targetEntryId)?.role === "resource") {
      const list = references.get(link.sourceEntryId) ?? [];
      list.push(link.targetEntryId);
      references.set(link.sourceEntryId, list);
    }
  }
  const roleOrder = { interface: 0, abstract: 1, implementation: 2, resource: 3, instance: 4 };

  function renderNode(entry, relation = "", depth = 0, path = new Set()) {
    if (path.has(entry.id)) return `<div class="cycle-note">循环引用：${escapeHtml(entry.title)}</div>`;
    const nextPath = new Set(path);
    nextPath.add(entry.id);
    const childEntries = (children.get(entry.id) ?? []).map((id) => byId.get(id)).filter(Boolean)
      .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || b.confidence - a.confidence);
    const resourceEntries = (references.get(entry.id) ?? []).map((id) => byId.get(id)).filter(Boolean);
    const crosses = (crossParents.get(entry.id) ?? []).map((link) => byId.get(link.targetEntryId)).filter(Boolean);
    const hasDetails = childEntries.length || resourceEntries.length || crosses.length;
    const row = listRow(entry, relation, childEntries.length);
    if (!hasDetails) return `<div class="tree-leaf depth-${depth}">${row}</div>`;
    const open = graph.query || depth === 0 ? "open" : "";
    return `<details class="tree-node depth-${depth}" ${open}>
      <summary>${row}</summary>
      <div class="tree-children">
        ${childEntries.map((child) => renderNode(child, primaryRelation.get(child.id), depth + 1, nextPath)).join("")}
        ${resourceEntries.length ? `<details class="tree-resources"><summary>REFERENCES · ${resourceEntries.length}</summary>${resourceEntries.map((resource) => `<div class="tree-leaf">${listRow(resource)}</div>`).join("")}</details>` : ""}
        ${crosses.length ? `<div class="cross-links">其他父级：${crosses.map((parent) => `<button data-memory-id="${escapeHtml(parent.id)}">${escapeHtml(parent.title)}</button>`).join("")}</div>` : ""}
      </div>
    </details>`;
  }

  container.innerHTML = domains.map(({ domain, entries }) => {
    const domainInterface = entries.find((entry) => entry.role === "interface" && entry.kind === "能力域");
    const roots = entries.filter((entry) => !primaryParent.has(entry.id) && entry !== domainInterface && entry.role !== "resource");
    const mainTree = domainInterface ? renderNode(domainInterface) : "";
    const unlinked = roots.map((entry) => renderNode(entry, "未挂接")).join("");
    return `<details class="domain-group" id="domain-${escapeHtml(domain)}" ${graph.query || entries.length <= 80 ? "open" : ""}>
      <summary class="domain-summary"><span class="domain-name">${escapeHtml(domain)}</span><span class="domain-count">${number.format(entries.length)}</span></summary>
      <div class="domain-tree">${mainTree}${unlinked}</div>
    </details>`;
  }).join("");
}

async function loadKnowledge() {
  state.knowledge = await api(`/api/memory/graph`);
  state.knowledgeLoaded = true;
  renderKnowledge();
}

async function loadBackfill() {
  try {
    const data = await api("/api/backfill");
    state.backfill = data;
    const done = data.completed + data.skipped;
    const percent = data.total ? Math.round(done / data.total * 100) : 0;
    $("#backfill-bar").style.width = `${percent}%`;
    const active = (data.families || []).map((family) => {
      const chunk = family.total ? `${family.done}/${family.total}` : "准备中";
      return `${family.title.slice(0, 18)} · ${chunk}`;
    }).join("\n");
    $("#backfill-summary").textContent = `${done}/${data.total} · ${percent}%\npending ${data.pending} · running ${data.running} · failed ${data.failed}${active ? `\n${active}` : ""}`;
    $("#backfill-toggle").textContent = data.active ? "暂停" : "继续";
  } catch {
    $("#backfill-summary").textContent = "队列不可用";
  }
}

async function loadHierarchy() {
  try {
    const data = await api("/api/hierarchy");
    state.hierarchy = data.run;
    if (!data.run) return;
    const total = data.run.progressTotal || 0;
    const done = data.run.progressDone || 0;
    const percent = total ? Math.round(done / total * 100) : 0;
    $("#hierarchy-bar").style.width = `${percent}%`;
    $("#hierarchy-summary").textContent = `level ${data.run.level} · ${data.run.stage} ${done}/${total} · ${data.run.status}`;
  } catch {
    $("#hierarchy-summary").textContent = "层级构建状态不可用";
  }
}

function percentage(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function renderTelemetry(summary, recalls) {
  const metrics = [
    [number.format(summary.recalls), "recall calls", `${number.format(summary.uniqueSessions)} sessions`],
    [percentage(summary.hitRate), "hit rate", `${summary.hits} hit / ${summary.misses} miss`],
    [`${summary.avgLatencyMs}ms`, "avg latency", `p95 ${summary.p95LatencyMs}ms`],
    [number.format(summary.injections), "index injections", `${summary.projects} projects`],
    [summary.avgEntries, "avg loaded objects", `${summary.avgFollowupTools} follow-up tools`],
    [percentage(summary.feedback.usefulness), "human usefulness", `${summary.feedback.judged} judged / ${summary.feedback.missed ?? 0} missed`],
  ];
  $("#telemetry-metrics").innerHTML = metrics.map(([value, label, note]) =>
    `<div class="telemetry-metric"><b>${value}</b><span>${label}</span><em>${note}</em></div>`
  ).join("");
  renderTrend(summary.trend);
  renderTelemetryBars("#domain-metrics", summary.byDomain.map((item) => ({ label: item.domain, value: item.total, note: percentage(item.total ? item.hits / item.total : null) })));
  renderTelemetryBars("#project-metrics", summary.byProject.map((item) => ({ label: item.directory.split("/").filter(Boolean).at(-1) || item.directory, value: item.total, note: percentage(item.total ? item.hits / item.total : null) })));
  renderTelemetryBars("#role-metrics", summary.roles.map((item) => ({ label: item.role, value: item.count || 0, note: "objects" })));
  $("#recall-total").textContent = `${number.format(recalls.total)} total`;
  $("#recall-log").innerHTML = recalls.items.map((item) => {
    const occurred = new Date(item.recalledAt);
    return `<article class="recall-row ${item.hitCount > 0 ? "hit" : "miss"}">
      <div class="recall-time"><b>${date.format(occurred)}</b><br />${time.format(occurred)}<br />${escapeHtml(item.agent || "unknown")}</div>
      <div class="recall-copy"><strong>${escapeHtml(item.query || "(empty query)")}</strong><span>${escapeHtml(item.directory)} · domain=${escapeHtml(item.domain || "未指定")} · mode=${escapeHtml(item.mode)}</span></div>
      <div class="recall-stats">${item.hitCount} objects<br />${item.latencyMs}ms<br />follow-up ${item.followupToolCount}/${item.followupEditCount}</div>
      <div class="recall-feedback" data-recall-id="${escapeHtml(item.id)}">
        <button class="${item.verdict === "useful" ? "active" : ""}" data-verdict="useful" title="有用">✓</button>
        <button class="${item.verdict === "not_useful" ? "active" : ""}" data-verdict="not_useful" title="无用">×</button>
        <button class="${item.verdict === "missed" ? "active" : ""}" data-verdict="missed" title="漏召回">!</button>
      </div>
    </article>`;
  }).join("") || `<div class="empty-state"><b>还没有召回样本</b><span>使用一段时间后，这里会显示真实调用。</span></div>`;
}

function renderTelemetryBars(selector, items) {
  const max = Math.max(...items.map(({ value }) => value), 1);
  $(selector).innerHTML = items.slice(0, 12).map((item) => `<div class="telemetry-bar">
    <span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
    <div class="bar-track"><i class="bar-fill" style="width:${Math.max(2, item.value / max * 100)}%"></i></div>
    <b>${number.format(item.value)} ${escapeHtml(item.note)}</b>
  </div>`).join("");
}

function renderTrend(trend) {
  const svg = $("#recall-trend");
  if (!trend.length) { svg.innerHTML = `<text x="360" y="110" text-anchor="middle" class="trend-label">等待更多调用形成趋势</text>`; return; }
  const width = 680;
  const height = 170;
  const max = Math.max(...trend.map(({ total }) => total), 1);
  const step = trend.length > 1 ? width / (trend.length - 1) : width;
  const points = trend.map((item, index) => ({ x: 20 + index * step, y: 190 - item.hits / max * height, ...item }));
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
  svg.innerHTML = `<line class="trend-axis" x1="20" y1="190" x2="700" y2="190" /><path class="trend-line" d="${path}" />${points.map((point) => `<circle class="trend-hit" cx="${point.x}" cy="${point.y}" r="4"><title>${point.day}: ${point.hits}/${point.total} hit</title></circle><text class="trend-label" x="${point.x}" y="210" text-anchor="middle">${escapeHtml(point.day.slice(5))}</text>`).join("")}`;
}

async function loadObservability() {
  try {
    const [summary, recalls] = await Promise.all([
      api("/api/observability/summary"),
      api("/api/observability/recalls?limit=100"),
    ]);
    state.telemetry = summary;
    state.recalls = recalls.items;
    state.observabilityLoaded = true;
    renderTelemetry(summary, recalls);
  } catch (error) {
    $("#telemetry-metrics").innerHTML = `<div class="empty-state"><b>观测数据读取失败</b><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function openMemory(id) {
  const entry = state.knowledge.entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  $("#memory-id").value = entry.id;
  $("#memory-title").value = entry.title;
  $("#memory-content").value = entry.content;
  $("#memory-role").value = entry.role;
  $("#memory-contract").value = JSON.stringify(entry.contract, null, 2);
  $("#memory-delta").value = JSON.stringify(entry.delta, null, 2);
  $("#memory-provenance").textContent = `namespace=${entry.namespace || "uncategorized"}\nrole=${entry.role}\nkind=${entry.kind || "knowledge"}\nconfidence=${Math.round(entry.confidence * 100)}%\ntags=${(entry.tags || []).join(", ")}\nsource=${JSON.stringify(entry.sourceRefs, null, 2)}`;
  $("#memory-dialog").showModal();
}

async function openDetail(sourceId, sessionId) {
  const dialog = $("#detail-dialog");
  $("#detail-content").innerHTML = `<div class="empty-state"><b>读取档案</b><span>${escapeHtml(sessionId)}</span></div>`;
  dialog.showModal();
  const deepLink = new URL(location.href);
  deepLink.searchParams.set("source", sourceId);
  deepLink.searchParams.set("session", sessionId);
  history.replaceState(null, "", deepLink);
  try {
    renderDetail(await api(`/api/sessions/${encodeURIComponent(sourceId)}/${encodeURIComponent(sessionId)}`));
  } catch (error) {
    $("#detail-content").innerHTML = `<div class="empty-state"><b>档案读取失败</b><span>${escapeHtml(error.message)}</span></div>`;
  }
}

let searchTimer;
$("#search-input").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    loadSessions();
  }, 220);
});
$("#clear-search").addEventListener("click", () => {
  state.query = "";
  $("#search-input").value = "";
  loadSessions();
});
$("#load-more").addEventListener("click", () => loadSessions({ append: true }));
$("#source-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-source]");
  if (!button) return;
  state.source = button.dataset.source;
  renderStats(state.stats);
  loadSessions();
});
$("#session-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-session]");
  if (row) openDetail(row.dataset.source, row.dataset.session);
});
function closeDetail() {
  $("#detail-dialog").close();
  history.replaceState(null, "", location.pathname);
}
$("#close-detail").addEventListener("click", closeDetail);
$("#detail-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeDetail();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#search-input").focus();
  }
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
  document.querySelectorAll("[data-view]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${button.dataset.view}-view`));
  if (button.dataset.view === "knowledge" && !state.knowledgeLoaded) await loadKnowledge();
  if (button.dataset.view === "observability") await loadObservability();
}));
$("#knowledge-search").addEventListener("input", renderKnowledge);
$("#knowledge-tree").addEventListener("click", (event) => {
  const domainButton = event.target.closest(".domain-index");
  if (domainButton) {
    const target = document.getElementById(`domain-${domainButton.dataset.domain}`);
    if (target) {
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  const entry = event.target.closest("[data-memory-id]");
  if (entry) openMemory(entry.dataset.memoryId);
});
$("#knowledge-hierarchy").addEventListener("click", (event) => {
  const entry = event.target.closest("[data-memory-id]");
  if (entry) {
    event.preventDefault();
    event.stopPropagation();
    openMemory(entry.dataset.memoryId);
  }
});
$("#recall-log").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-verdict]");
  const group = event.target.closest("[data-recall-id]");
  if (!button || !group) return;
  await api("/api/observability/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recallId: group.dataset.recallId, verdict: button.dataset.verdict }),
  });
  await loadObservability();
});
$("#cancel-memory").addEventListener("click", () => $("#memory-dialog").close());
$("#backfill-toggle").addEventListener("click", async () => {
  await api(state.backfill?.active ? "/api/backfill/stop" : "/api/backfill/start", { method: "POST" });
  await loadBackfill();
});
$("#backfill-retry").addEventListener("click", async () => {
  await api("/api/backfill/retry", { method: "POST" });
  await loadBackfill();
});
$("#delete-memory").addEventListener("click", async () => {
  const id = $("#memory-id").value;
  const entry = state.knowledge.entries.find((candidate) => candidate.id === id);
  if (!entry || !window.confirm(`永久删除知识对象「${entry.title}」及其关系？此操作不可撤销。`)) return;
  try {
    await api(`/api/memory/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("#memory-dialog").close();
    await loadKnowledge();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
});
$("#memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = $("#memory-id").value;
    await api(`/api/memory/entries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: $("#memory-title").value,
        content: $("#memory-content").value,
        role: $("#memory-role").value,
        contract: JSON.parse($("#memory-contract").value || "{}"),
        delta: JSON.parse($("#memory-delta").value || "{}"),
      }),
    });
    $("#memory-dialog").close();
    await loadKnowledge();
  } catch (error) {
    window.alert(`保存失败：${error.message}`);
  }
});

try {
  state.stats = await api("/api/stats");
  renderStats(state.stats);
  await loadBackfill();
  await loadHierarchy();
  setInterval(loadBackfill, 5_000);
  setInterval(loadHierarchy, 5_000);
  await loadSessions();
  const deepLink = new URLSearchParams(location.search);
  if (deepLink.get("view") === "knowledge") {
    const knowledgeTab = document.querySelector('[data-view="knowledge"]');
    document.querySelectorAll("[data-view]").forEach((candidate) => candidate.classList.toggle("active", candidate === knowledgeTab));
    document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "knowledge-view"));
    await loadKnowledge();
  }
  if (deepLink.get("view") === "observability") {
    const tab = document.querySelector('[data-view="observability"]');
    document.querySelectorAll("[data-view]").forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
    document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "observability-view"));
    await loadObservability();
  }
  const source = deepLink.get("source");
  const session = deepLink.get("session");
  if (source && session) await openDetail(source, session);
} catch (error) {
  document.body.innerHTML = `<div class="empty-state"><b>管理台启动失败</b><span>${escapeHtml(error.message)}</span></div>`;
}
