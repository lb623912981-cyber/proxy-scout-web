"use strict";

(() => {
  const DEFAULT_REPO = "lb623912981-cyber/proxy-scout-cloud";
  const WORKFLOW = "cloud-check.yml";
  const STORAGE = "scout.connection.v1";
  const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
  const $ = id => document.getElementById(id);
  let connection = null;
  let result = null;
  let runs = [];
  let jobs = [];
  let pending = null;
  let starting = false;
  let syncing = false;
  let pollTimer;
  let toastTimer;
  let filter = "available";
  let selectedNode = null;
  let installPrompt = null;
  let lastResultFetch = 0;

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }
  function validRepo(repo) { return /^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(repo); }
  function endpoint(ctx) { return "/repos/" + ctx.repo; }
  async function api(ctx, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);
    try {
      const response = await fetch("https://api.github.com" + path, {
        method: options.method || "GET",
        headers: {
          "Authorization": "Bearer " + ctx.token,
          "Accept": options.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal
      });
      if (!response.ok) {
        const messages = {
          401: "访问令牌已失效，请在连接设置中更换。",
          403: response.headers.get("X-RateLimit-Remaining") === "0"
            ? "GitHub 请求额度暂时用完，请稍后刷新。"
            : "访问被拒绝。请确认令牌有此仓库的 Contents 读取和 Actions 读写权限。",
          404: "未找到测速空间或数据，请检查仓库名称及令牌的仓库授权。",
          409: "云端暂时无法处理，请稍后刷新。",
          422: "无法启动工作流，请确认云端程序已部署完成。"
        };
        throw new ApiError(messages[response.status] || "GitHub 暂时不可用（" + response.status + "），请稍后刷新。", response.status);
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === "AbortError" ? "连接 GitHub 超时，请检查网络后刷新。" : "无法连接 GitHub，请检查手机网络后重试。");
    } finally { clearTimeout(timer); }
  }
  function notice(message = "", isError = false) {
    $("notice").textContent = message;
    $("notice").hidden = !message;
    $("notice").classList.toggle("error", isError);
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
  }
  function dateTime(seconds) {
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
  }
  function elapsed(iso) {
    const start = new Date(iso).getTime();
    if (!Number.isFinite(start)) return "等待云端响应";
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return Math.floor(seconds / 60) + " 分 " + String(seconds % 60).padStart(2, "0") + " 秒";
  }
  function speed(value) { return Number.isFinite(value) ? value.toFixed(value >= 100 ? 0 : 1) : "—"; }
  function latency(value) { return Number.isFinite(value) ? Math.round(value).toString() : "—"; }
  function activeRun() { return runs.find(run => ACTIVE.has(run.status)); }
  function bestNode() { return result?.report.nodes.find(node => node.online); }
  function sourceKey(node) { return node.source_id != null ? "id:" + node.source_id : "name:" + (node.source || "未分类来源"); }
  function sourceGroups() {
    const groups = new Map((result?.report.source_groups || []).map(group => ["id:" + group.id, { ...group, key: "id:" + group.id, nodes: [] }]));
    for (const node of result?.report.nodes || []) {
      const key = sourceKey(node);
      if (!groups.has(key)) groups.set(key, { key, name: node.source || "未分类来源", nodes: [] });
      groups.get(key).nodes.push(node);
    }
    return [...groups.values()];
  }
  function sortedNodes(nodes) {
    const download = $("node-sort").value === "speed";
    const delay = node => Number.isFinite(node.latency) ? node.latency : Infinity;
    return [...nodes].sort((a, b) => {
      if (Boolean(a.online) !== Boolean(b.online)) return a.online ? -1 : 1;
      if (download) {
        const aSpeed = Number.isFinite(a.mbps) ? a.mbps : -1;
        const bSpeed = Number.isFinite(b.mbps) ? b.mbps : -1;
        if (aSpeed !== bSpeed) return bSpeed - aSpeed;
      }
      return delay(a) - delay(b) || String(a.name).localeCompare(String(b.name), "zh-CN");
    });
  }
  function latencyClass(node) {
    if (!node.online || !Number.isFinite(node.latency)) return "latency-offline";
    return node.latency <= 150 ? "latency-fast" : node.latency <= 300 ? "latency-medium" : "latency-high";
  }
  function updateSourceFilter() {
    const previous = $("source-filter").value;
    const options = [new Option("全部订阅", ""), ...sourceGroups().map(group => new Option(group.name, group.key))];
    $("source-filter").replaceChildren(...options);
    if (options.some(option => option.value === previous)) $("source-filter").value = previous;
  }
  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function updateGuide() {
    const repo = $("repository").value.trim();
    const owner = validRepo(repo) ? repo.split("/")[0] : DEFAULT_REPO.split("/")[0];
    $("repo-hint").textContent = validRepo(repo) ? repo.split("/")[1] : "proxy-scout-cloud";
    const query = new URLSearchParams({ name: "Proxy Scout Mobile", target_name: owner, expires_in: "30", contents: "read", actions: "write" });
    $("token-create").href = "https://github.com/settings/personal-access-tokens/new?" + query;
  }
  function openConnect() {
    $("token").value = "";
    $("repository").value = connection?.repo || DEFAULT_REPO;
    $("remember").checked = Boolean(connection?.remember);
    $("connect-error").hidden = true;
    $("disconnect").hidden = !connection;
    updateGuide();
    if (!$("connect-dialog").open) $("connect-dialog").showModal();
  }
  function clearStorage() {
    for (const name of ["sessionStorage", "localStorage"]) {
      try { window[name].removeItem(STORAGE); } catch { /* Storage may be disabled. */ }
    }
  }
  function saveConnection(ctx) {
    clearStorage();
    try {
      window[ctx.remember ? "localStorage" : "sessionStorage"].setItem(STORAGE, JSON.stringify(ctx));
    } catch { toast("浏览器禁止保存连接，本次页面关闭后需要重新连接。"); }
  }
  function readConnection() {
    for (const name of ["sessionStorage", "localStorage"]) {
      try {
        const value = JSON.parse(window[name].getItem(STORAGE));
        if (value && validRepo(value.repo) && typeof value.token === "string" && value.token && !/\s/.test(value.token)) {
          return { repo: value.repo, token: value.token, remember: name === "localStorage" };
        }
      } catch { /* Ignore unavailable or malformed storage. */ }
    }
    return null;
  }
  function renderConnection() {
    $("connection").classList.toggle("ready", Boolean(connection));
    $("connection-text").textContent = connection ? "已连接云端" : "尚未连接";
    $("disconnect").hidden = !connection;
  }
  async function readResult(ctx) {
    try {
      const data = await api(ctx, endpoint(ctx) + "/contents/LATEST.json", { raw: true });
      if (ctx !== connection) return;
      if (data.version !== 1 || !data.report || !Array.isArray(data.report.nodes) || !Number.isFinite(data.report.generated_at)) {
        throw new ApiError("云端结果格式不匹配，请更新测速程序后重新测速。");
      }
      result = data;
      lastResultFetch = Date.now();
      renderResult();
    } catch (error) {
      if (error.status !== 404) throw error;
      if (ctx !== connection) return;
      lastResultFetch = Date.now();
      if (!result) renderResult();
    }
  }
  function renderResult() {
    const report = result?.report;
    const best = bestNode();
    $("best-title").textContent = best ? best.name : report ? "这一轮还没有可用线路。" : connection ? "已就绪，开始发现好线路。" : "下一条好线路，等你发现。";
    $("best-description").textContent = best
      ? [best.source, String(best.type).toUpperCase(), report.ranking === "download" ? "按本轮下载抽样排序" : "按连接延迟排序"].join(" · ")
      : report ? "可以稍后重新测速，或检查订阅是否仍然有效。" : "连接你的测速空间，即可查看结果，或开始一次新的测速。";
    $("best-label").textContent = report?.ranking === "latency" ? "本轮低延迟推荐" : "我的推荐线路";
    $("best-speed").textContent = speed(best?.mbps);
    $("best-latency").textContent = latency(best?.latency);
    $("best-export").disabled = !best;
    $("export-all").disabled = !result?.clash_config;
    $("stat-total").textContent = report?.total ?? "—";
    $("stat-online").textContent = report?.available ?? "—";
    $("stat-measured").textContent = report ? report.nodes.filter(node => Number.isFinite(node.mbps)).length : "—";
    $("stat-traffic").textContent = report ? (Number(report.download_bytes || 0) / 1048576).toFixed(1) : "—";
    $("data-time").textContent = report ? (report.download_requested ? "完整测速" : "仅测延迟") + " · 完成于 " + dateTime(report.generated_at) : "这里会显示真实的测速记录。";
    $("hero-note").textContent = report?.warnings?.length
      ? "本轮说明：" + report.warnings.join("；")
      : report && !report.download_requested ? "本轮只检查连接和延迟，未进行下载测速。需要 Mbps 数据可点击“完整测速”。" : "只测延迟更快；完整测速包含下载抽样，通常需要几分钟。";
    updateAge();
    updateSourceFilter();
    renderNodes();
  }
  function updateAge() {
    if (!result) { $("report-age").textContent = connection ? "等待首次测速" : "等待连接"; return; }
    const report = result.report;
    const minutes = Math.max(0, Math.floor((Date.now() / 1000 - report.generated_at) / 60));
    const age = minutes < 1 ? "刚刚更新" : minutes < 60 ? minutes + " 分钟前" : Math.floor(minutes / 60) + " 小时前";
    $("report-age").textContent = age + (Date.now() / 1000 > report.valid_until ? " · 建议重测" : " · 最近结果");
  }
  function renderNodes() {
    const query = $("search").value.trim().toLowerCase();
    const selected = $("source-filter").value;
    const collapsed = new Set([...$("node-list").children].filter(group => !group.open).map(group => group.dataset.key));
    const fragment = document.createDocumentFragment();
    let count = 0;
    let groupCount = 0;
    for (const group of sourceGroups()) {
      if (selected && group.key !== selected) continue;
      const sorted = sortedNodes(group.nodes);
      const online = sorted.filter(node => node.online);
      const visible = sorted.filter(node => (filter === "all" || (filter === "available" ? node.online : !node.online))
        && [node.name, group.name, node.type].join(" ").toLowerCase().includes(query));
      if (query && !visible.length && !group.name.toLowerCase().includes(query)) continue;
      count += visible.length;
      groupCount++;
      const section = create("details", "source-group");
      section.dataset.key = group.key;
      section.open = query ? true : !collapsed.has(group.key);
      const summary = create("summary", "source-heading");
      const heading = create("div", "source-title");
      heading.append(create("h3", "", group.name));
      heading.append(create("p", "", "可用 " + online.length + " / 已检查 " + group.nodes.length
        + (group.total != null ? " · 读取 " + group.total : "")
        + (group.unchecked ? " · 未检查 " + group.unchecked : "") + " · 当前显示 " + visible.length));
      const delays = online.map(node => node.latency).filter(Number.isFinite);
      summary.append(heading, create("span", "group-lowest", delays.length ? "最低 " + latency(Math.min(...delays)) + " ms" : "暂无可用延迟"));
      section.append(summary);
      const content = create("div", "source-body");
      const actions = create("div", "source-actions");
      if (online.length) {
        const best = online[0];
        const measuredSpeed = $("node-sort").value === "speed" && Number.isFinite(best.mbps);
        const recommendation = create("button", "group-recommendation", (measuredSpeed ? "下载优选：" : "低延迟优选：") + best.name + " ↗");
        recommendation.addEventListener("click", () => openNode(best));
        actions.append(recommendation);
      }
      const config = result?.source_configs?.[group.id];
      if (config) {
        const exportButton = create("button", "text-button", "导出本组 ↓");
        exportButton.addEventListener("click", () => download(config, "scout-source-" + String(group.id).replace(/[^a-zA-Z0-9-]/g, "") + ".yaml"));
        actions.append(exportButton);
      }
      content.append(actions);
      const grid = create("div", "node-list");
      const ranks = new Map(online.map((node, i) => [node.id, i + 1]));
      for (const node of visible) {
        const row = create("article", "node" + (node.online ? "" : " offline"));
        const rank = ranks.get(node.id);
        row.append(create("span", "node-rank" + (rank === 1 ? " first" : ""), rank ? String(rank).padStart(2, "0") : "—"));
        const main = create("div", "node-main");
        const title = create("div", "node-title", node.name);
        title.title = node.name;
        main.append(title);
        const meta = create("div", "node-meta");
        meta.append(create("span", "state", node.online ? "可用" : "未连通"), create("span", "", String(node.type).toUpperCase()));
        main.append(meta);
        const value = create("div", "node-result");
        const delay = create("strong", latencyClass(node), node.online ? latency(node.latency) : "未连通");
        value.append(delay);
        if (node.online) value.append(create("small", "", "ms"));
        value.append(create("span", "", Number.isFinite(node.mbps) ? speed(node.mbps) + " Mbps" : result?.report.download_requested ? "未测得下载" : "未测下载"));
        row.append(main, value);
        const use = create("button", "node-use", "↗");
        use.type = "button";
        use.setAttribute("aria-label", "查看 " + node.name);
        use.addEventListener("click", () => openNode(node));
        row.append(use);
        grid.append(row);
      }
      content.append(grid);
      if (!visible.length) content.append(create("p", "group-empty", group.status === "error" ? "此订阅读取失败，请检查链接或稍后重测。" : group.status === "empty" ? "此订阅没有解析到节点。" : "此分组没有符合当前筛选条件的已测节点。"));
      section.append(content);
      fragment.append(section);
    }
    $("node-count").textContent = count;
    $("node-list").replaceChildren(fragment);
    $("empty").hidden = groupCount > 0;
    $("connect-empty").hidden = Boolean(connection);
    $("empty-title").textContent = !connection ? "先连接，再出发。" : !result ? "准备好，测一轮吧。" : "没有匹配的线路。";
    $("empty-description").textContent = !connection ? "首次绑定你的云端空间，之后测速和查看结果都在这里完成。" : !result ? "点击“只测延迟”或“完整测速”，完成后在这里查看分组结果。" : "换一个关键词或筛选条件，也可以重新测速。";
  }
  function configFor(node) {
    return result?.node_configs?.[node.id] || (node.id === bestNode()?.id ? result?.clash_recommended : "") || "";
  }
  function shareFor(node) { return result?.shares?.find(item => item.id === node.id)?.uri || ""; }
  function openNode(node) {
    selectedNode = node;
    $("detail-type").textContent = String(node.type).toUpperCase() + " · " + (node.online ? "本轮可用" : "本轮未连通");
    $("detail-name").textContent = node.name;
    $("detail-source").textContent = node.source;
    $("detail-speed").textContent = speed(node.mbps) + " Mbps";
    $("detail-latency").textContent = node.online ? latency(node.latency) + " ms · 云端延迟" : "未连通";
    $("detail-latency").className = latencyClass(node);
    $("copy-node").hidden = !shareFor(node);
    $("download-node").disabled = !configFor(node);
    $("copy-fallback").hidden = true;
    $("copy-fallback").value = "";
    $("detail-note").textContent = !node.online ? "本轮没有连通，暂不提供导入配置。" : shareFor(node)
      ? "复制链接到客户端导入，或下载适用于 Mihomo / Clash 的配置。"
      : configFor(node) ? "这个节点没有可复制的分享链接，请下载配置后导入支持该协议的 Mihomo / Clash 客户端。"
      : "这份旧记录没有单独节点配置，请导出全部配置，或重新测速后再试。";
    if (node.download_error) $("detail-note").textContent += " 下载抽样：" + node.download_error;
    if (node.latency_error) $("detail-note").textContent += " 延迟检测：" + node.latency_error;
    if (node.checked_at) $("detail-note").textContent += " 延迟检查时间：" + dateTime(node.checked_at) + "。";
    if (!$("node-dialog").open) $("node-dialog").showModal();
  }
  function download(content, filename) {
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: "application/yaml;charset=utf-8" }));
    const link = create("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("配置已交给浏览器下载，请在代理客户端中导入。");
  }
  function renderHistory() {
    $("history-section").hidden = !runs.length;
    const fragment = document.createDocumentFragment();
    const labels = { success: "测速完成", failure: "运行异常", cancelled: "已取消", timed_out: "运行超时", skipped: "已跳过", action_required: "需要处理" };
    for (const run of runs.slice(0, 4)) {
      const item = create("div", "history-item " + (run.conclusion === "success" ? "success" : run.conclusion ? "failure" : ""));
      item.append(create("strong", "", "#" + run.run_number + " · " + (labels[run.conclusion] || (ACTIVE.has(run.status) ? "正在运行" : "已结束"))));
      const time = create("time", "", new Date(run.created_at).toLocaleString("zh-CN", { hour12: false }));
      time.dateTime = run.created_at;
      item.append(time);
      fragment.append(item);
    }
    $("history-list").replaceChildren(fragment);
  }
  function setStages(position, complete = false) {
    [...$("stages").children].forEach((stage, i) => {
      const done = complete || i < position;
      stage.classList.toggle("done", done);
      stage.classList.toggle("active", !complete && i === position);
      stage.querySelector(".stage-status").textContent = done ? "完成" : i === position ? "进行中" : "";
    });
  }
  function renderRun() {
    const active = activeRun();
    const latest = runs[0];
    const busy = Boolean(active || pending || starting);
    $("start").disabled = busy;
    $("start-latency").disabled = busy;
    $("start-label").textContent = busy ? "云端检测中" : "完整测速";
    $("start-symbol").classList.toggle("spinning", busy);
    $("start-symbol").textContent = busy ? "◌" : "↗";
    $("activity-bar").hidden = !busy;
    if (active || pending || starting) {
      const steps = jobs.flatMap(job => job.steps || []);
      const measuring = steps.find(step => step.name === "检查节点并生成手机报告");
      const publishing = steps.find(step => step.name === "更新手机查看入口");
      const phase = measuring?.status === "completed" || publishing?.status === "in_progress" ? 2 : measuring?.status === "in_progress" ? 1 : 0;
      setStages(phase);
      $("run-badge").textContent = !active || active.status !== "in_progress" ? "等待云端" : "进行中";
      $("run-title").textContent = ["正在准备这次测速。", "正在实测线路表现。", "正在整理新推荐。 "][phase];
      $("run-description").textContent = pending?.uncertain ? "提交结果尚未确认，正在查询云端。请先不要重复发起。" : phase === 0 ? "任务可能需要排队，接下来会读取订阅。" : phase === 1 ? "按所选模式检查延迟或下载，完成后按订阅分别显示。" : "写入本轮测速结果，分组报告即将更新。";
      $("run-elapsed").textContent = active ? "已等待 " + elapsed(active.created_at) : pending ? "已等待 " + elapsed(pending.at) : "正在提交";
    } else if (latest) {
      const success = latest.conclusion === "success";
      const matched = result?.report.run_url?.endsWith("/" + latest.id);
      setStages(-1, success);
      $("run-badge").textContent = success ? "已完成" : "请查看状态";
      $("run-title").textContent = success ? matched ? "这一轮，好线路已就位。" : "测速完成，正在读取结果。" : "这一轮没有正常完成。";
      $("run-description").textContent = success ? matched ? "新推荐已更新。需要使用时，也可以再测一次。" : "若结果尚未出现，请稍后点“刷新状态”。" : "可能是订阅、检测或结果发布异常。下面会保留最近可读取的记录，可以重新测速。";
      $("run-elapsed").textContent = "最近运行 #" + latest.run_number;
    } else {
      setStages(-1);
      $("run-badge").textContent = "随时出发";
      $("run-title").textContent = "按一下，剩下交给云端。";
      $("run-description").textContent = "只测延迟检查连接响应；完整测速还会抽样下载。完成后按订阅分别显示。";
      $("run-elapsed").textContent = "准备好时，就开始吧";
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!connection || document.hidden) return;
    const waitingResult = runs[0]?.conclusion === "success" && !result?.report.run_url?.endsWith("/" + runs[0].id);
    pollTimer = setTimeout(() => sync(), activeRun() || pending || waitingResult ? 10000 : 60000);
  }
  async function sync(force = false) {
    const ctx = connection;
    if (!ctx || syncing) return;
    syncing = true;
    $("refresh").classList.add("refreshing");
    try {
      const data = await api(ctx, endpoint(ctx) + "/actions/workflows/" + WORKFLOW + "/runs?per_page=5");
      if (ctx !== connection) return;
      runs = data.workflow_runs || [];
      if (pending) {
        const discovered = runs.find(run => run.id > pending.previous && new Date(run.created_at).getTime() >= new Date(pending.at).getTime() - 10000);
        if (discovered) pending = null;
        else if (Date.now() - new Date(pending.at).getTime() > 120000) {
          pending = null;
          notice("暂未找到刚提交的任务。请刷新状态确认后再决定是否重新发起。", true);
        }
      }
      const active = activeRun();
      jobs = [];
      if (active) {
        const data = await api(ctx, endpoint(ctx) + "/actions/runs/" + active.id + "/jobs");
        if (ctx !== connection) return;
        jobs = data.jobs || [];
      }
      renderRun();
      renderHistory();
      if (force || !result || Date.now() - lastResultFetch > 55000 || (!active && runs[0] && !result?.report.run_url?.endsWith("/" + runs[0].id))) {
        await readResult(ctx);
      }
      if (ctx !== connection) return;
      renderRun();
    } catch (error) { if (ctx === connection) notice(error.message, true); }
    finally {
      syncing = false;
      $("refresh").classList.remove("refreshing");
      schedulePoll();
    }
  }
  async function startRun(downloadRequested = true) {
    if (!connection) { openConnect(); return; }
    if (starting || pending || activeRun()) return;
    const ctx = connection;
    starting = true;
    notice();
    renderRun();
    let dispatched = false;
    try {
      const data = await api(ctx, endpoint(ctx) + "/actions/workflows/" + WORKFLOW + "/runs?per_page=5");
      if (ctx !== connection) return;
      runs = data.workflow_runs || [];
      if (activeRun()) { toast("已有一轮测速正在进行，已为你显示进度。"); return; }
      pending = { previous: Math.max(0, ...runs.map(run => run.id)), at: new Date().toISOString(), uncertain: false };
      dispatched = true;
      await api(ctx, endpoint(ctx) + "/actions/workflows/" + WORKFLOW + "/dispatches", { method: "POST", body: { ref: ctx.branch || "main", inputs: { download: String(downloadRequested) } } });
      if (ctx !== connection) return;
      toast((downloadRequested ? "完整测速" : "仅测延迟") + "已提交到云端，完成后按订阅显示结果。");
    } catch (error) {
      if (ctx !== connection) return;
      if (dispatched && (!error.status || error.status >= 500)) {
        pending.uncertain = true;
        notice("提交响应中断，任务可能已启动。页面会先查询运行状态，避免重复测速。", true);
      } else { pending = null; notice(error.message, true); }
    } finally {
      starting = false;
      if (ctx === connection) { renderRun(); renderHistory(); await sync(); }
    }
  }
  $("connect-form").addEventListener("submit", async event => {
    event.preventDefault();
    const ctx = { repo: $("repository").value.trim(), token: $("token").value.trim(), remember: $("remember").checked };
    const errorBox = $("connect-error");
    errorBox.hidden = true;
    if (!validRepo(ctx.repo) || !ctx.token || /\s/.test(ctx.token)) {
      errorBox.textContent = "请填写完整令牌，仓库格式应为 用户名/仓库名。";
      errorBox.hidden = false;
      return;
    }
    $("connect-submit").disabled = true;
    $("connect-submit").textContent = "正在连接…";
    try {
      const metadata = await api(ctx, endpoint(ctx));
      if (!metadata.private) throw new ApiError("请选择私有测速仓库，以便保护订阅和节点配置。");
      ctx.branch = metadata.default_branch;
      await api(ctx, endpoint(ctx) + "/actions/workflows/" + WORKFLOW);
      connection = ctx;
      result = null; runs = []; jobs = []; pending = null; lastResultFetch = 0;
      saveConnection(ctx);
      $("token").value = "";
      $("connect-dialog").close();
      notice();
      renderConnection(); renderResult(); renderRun(); renderHistory();
      await sync(true);
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { $("connect-submit").disabled = false; $("connect-submit").textContent = "连接云端 ↗"; }
  });
  $("disconnect").addEventListener("click", () => {
    connection = null; result = null; runs = []; jobs = []; pending = null; selectedNode = null;
    clearStorage(); clearTimeout(pollTimer);
    $("token").value = ""; $("copy-fallback").value = "";
    $("detail-name").textContent = ""; $("detail-source").textContent = "";
    $("connect-dialog").close(); $("node-dialog").close();
    notice(); renderConnection(); renderResult(); renderRun(); renderHistory();
    toast("已清除这台设备的连接；云端已启动的任务会继续完成。");
  });
  $("settings").addEventListener("click", openConnect);
  $("connect-empty").addEventListener("click", openConnect);
  $("repository").addEventListener("input", updateGuide);
  $("start").addEventListener("click", () => startRun(true));
  $("start-latency").addEventListener("click", () => startRun(false));
  $("refresh").addEventListener("click", () => { if (!connection) openConnect(); else { notice(); sync(true); } });
  $("search").addEventListener("input", renderNodes);
  $("source-filter").addEventListener("change", renderNodes);
  $("node-sort").addEventListener("change", renderNodes);
  document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(item => { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
    renderNodes();
  }));
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("connect-dialog").addEventListener("close", () => { $("token").value = ""; });
  $("node-dialog").addEventListener("close", () => { $("copy-fallback").value = ""; $("copy-fallback").hidden = true; });
  $("best-export").addEventListener("click", () => { if (bestNode()) openNode(bestNode()); });
  $("export-all").addEventListener("click", () => download(result?.clash_config, "scout-available.yaml"));
  $("download-node").addEventListener("click", () => { if (selectedNode) download(configFor(selectedNode), "scout-" + selectedNode.id.replace(/[^a-zA-Z0-9-]/g, "") + ".yaml"); });
  $("copy-node").addEventListener("click", async () => {
    if (!selectedNode) return;
    const uri = shareFor(selectedNode);
    if (!uri) return;
    try { await navigator.clipboard.writeText(uri); toast("已复制，可在手机客户端中导入。"); }
    catch { $("copy-fallback").value = uri; $("copy-fallback").hidden = false; $("copy-fallback").focus(); $("copy-fallback").select(); toast("浏览器未允许复制，请长按文本手动复制。"); }
  });
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; });
  $("install-tip").addEventListener("click", async () => {
    if (installPrompt) { await installPrompt.prompt(); installPrompt = null; }
    else toast("iPhone：Safari 分享 → 添加到主屏幕；安卓：浏览器菜单 → 添加到主屏幕。");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(pollTimer); else { updateAge(); sync(true); } });
  window.addEventListener("online", () => sync(true));
  setInterval(() => { if (!document.hidden) { updateAge(); if (activeRun() || pending) renderRun(); } }, 1000);
  updateGuide();
  connection = readConnection();
  renderConnection(); renderResult(); renderRun();
  if (connection) sync(true);
})();
