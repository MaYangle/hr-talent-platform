import {
  esc,
  fmt,
  dateOnly,
  tag,
  button,
  title,
  table,
  input,
  saveDownload,
  saveCsv,
} from "./lib/ui.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const F = {
  name: "姓名",
  phone: "电话",
  email: "邮箱",
  city: "当前城市",
  targetCity: "目标城市",
  company: "当前公司",
  role: "当前岗位",
  targetRole: "目标岗位",
  years: "工作年限",
  education: "教育经历",
  english: "英语能力",
  skills: "技能（逗号分隔）",
  industry: "行业",
  monthly: "月薪期望（千元）",
  annual: "年薪期望（万元）",
  source: "来源",
  text: "履历原文",
};
const statuses = [
    "新入库",
    "待联系",
    "可推荐",
    "面试中",
    "人才储备",
    "暂不考虑",
  ],
  stages = [
    "待联系",
    "电话初筛",
    "业务面试",
    "综合面试",
    "待决策",
    "已录用",
    "已结束",
  ];
const KIND = {
  skill: "技能",
  years: "最低年限",
  city: "目标城市",
  education: "教育资格",
  industry: "行业",
  english: "英语",
  role: "岗位职责",
};
const TASK = {
  queued: "已保存 · 等待解析",
  running: "正在解析",
  review: "解析完成 · 待核对",
  duplicate: "疑似重复 · 待审查",
  failed: "处理失败",
  done: "已人工处理",
  skipped: "已跳过",
  partial: "部分失败",
};
const RUNSTATE = {
  queued: "排队中",
  running: "匹配中",
  done: "已完成",
  partial: "部分失败",
  failed: "失败",
};
let S = null,
  csrf = "",
  route = "candidates",
  routeId = "",
  profileTab = "resume",
  list = {
    q: "",
    city: "",
    source: "",
    skills: "",
    status: [],
    role: "",
    education: "",
    years: "",
    updatedFrom: "",
    updatedTo: "",
    resumeFrom: "",
    resumeTo: "",
    incomplete: false,
    unverified: false,
    ids: null,
    sort: "updated-desc",
    size: 20,
    page: 1,
  },
  queue = { ownerId: "", stage: "", overdue: false },
  metricsFilter = {},
  currentRun = null,
  activeMatch = 0,
  pollBusy = false;
const can = (p) => S?.permissions.includes(p);
const find = (kind, id) => S[kind].find((x) => x.id === id);
const uname = (id) => S.users.find((u) => u.id === id)?.name || "未指定";
const cname = (id) => find("candidates", id)?.name || "不可访问的人才";
const jname = (id) => find("jobs", id)?.title || "历史岗位";
const overdue = (due, status) =>
  due &&
  new Date(due) < new Date(S?.serverTime || Date.now()) &&
  !["已完成", "已取消", "已录用", "已结束"].includes(status);
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
async function api(path, data) {
  const response = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers:
      data === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && S) {
      S = null;
      await showLogin();
    }
    throw Error(value.error || "请求失败");
  }
  return value;
}
async function sync(renderPage = true) {
  S = await api("boot");
  csrf = S.csrf;
  $("#user").innerHTML =
    `${esc(S.user.name)} · ${esc(S.user.role)}<br>团队共享工作区`;
  $("#storageStatus").textContent = "共享数据已同步 · " + fmt(S.serverTime);
  if (renderPage) render();
}
function nav(path) {
  if (location.hash.slice(1) === path) render();
  else location.hash = path;
}
function openModal(name, html, large = false) {
  $("#modalTitle").textContent = name;
  $("#modalBody").innerHTML = html;
  $("#dialog").classList.toggle("large-dialog", large);
  if (!$("#dialog").open) $("#dialog").showModal();
}
function closeModal() {
  $("#dialog").close();
}
function toLocal(v) {
  if (!v) return "";
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function iso(v) {
  return v ? new Date(v).toISOString() : "";
}
function formError(e) {
  const t = $("#formError");
  if (t) t.textContent = e.message;
  notify(e.message);
}
function formHandler(selector, fn) {
  $(selector).onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.dataset.submitting === "true") return;
    e.target.dataset.submitting = "true";
    const b = e.target.querySelector("button[type=submit],button.primary");
    if (b) b.disabled = true;
    try {
      await fn(Object.fromEntries(new FormData(e.target)), e.target);
    } catch (e) {
      formError(e);
    } finally {
      e.target.dataset.submitting = "false";
      if (b) b.disabled = false;
    }
  };
}
function usersOptions() {
  return S.users
    .filter((u) => u.active)
    .map((u) => ({ value: u.id, label: `${u.name} · ${u.role}` }));
}
const endForm = (label = "保存") =>
  `<div class="inline-error" id="formError"></div><div class="actions"><button type="submit" class="btn primary">${label}</button></div>`;

const requiredProfile = [
  "name",
  "phone",
  "email",
  "city",
  "targetCity",
  "targetRole",
  "years",
  "education",
  "english",
];
function profileFields(values, includeText = false) {
  const groups = [
    [
      "联系与求职意向",
      ["name", "phone", "email", "city", "targetCity", "targetRole"],
    ],
    [
      "任职与能力",
      ["company", "role", "years", "education", "english", "skills"],
    ],
    [
      "补充信息（选填）",
      [
        "industry",
        "monthly",
        "annual",
        "source",
        ...(includeText ? ["text"] : []),
      ],
    ],
  ];
  return groups
    .map(
      ([label, keys], index) =>
        `<details class="profile-section wide" ${index < 2 ? "open" : ""}><summary>${label}</summary><div class="form-grid">${keys.map((key) => input(key, F[key] + (requiredProfile.includes(key) ? " *" : ""), values[key] ?? "", key === "text" ? "textarea" : key === "years" ? "number" : "text", key === "source" ? [...new Set(["本地上传", "招聘平台", "员工推荐", "其他", values.source].filter(Boolean))] : null, key === "text")).join("")}</div></details>`,
    )
    .join("");
}
function bindProfileQuality(selector) {
  const form = $(selector);
  const summary = document.createElement("p");
  summary.className = "profile-quality wide";
  summary.setAttribute("role", "status");
  form.prepend(summary);
  const update = () => {
    const values = Object.fromEntries(new FormData(form));
    const keys = [
      ...requiredProfile,
      ...(values.employment === "未任职" ? [] : ["company", "role"]),
    ];
    const missing = keys.filter((key) => {
      const value = String(values[key] || "").trim();
      return (
        !value ||
        /^(未知|待补全|待确认|未填写|未提供|不详|暂无|n\/a|unknown|-|null|none)$/i.test(
          value,
        ) ||
        (key === "phone" &&
          !/^\+?\d{7,15}$/.test(value.replace(/[^\d+]/g, ""))) ||
        (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ||
        (key === "years" &&
          (!Number.isFinite(Number(value)) ||
            Number(value) < 0 ||
            Number(value) > 60))
      );
    });
    summary.textContent = missing.length
      ? `核实前需补全或修正 ${missing.length} 项：${missing.map((key) => F[key]).join("、")}。仍可保存为待补全档案。`
      : "必需字段已填写，请对照原文确认后勾选核实。";
    keys.forEach((key) => {
      const field = form.elements.namedItem(key);
      field?.setAttribute("aria-invalid", String(missing.includes(key)));
    });
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  form.addEventListener("click", (event) => {
    const field = event.target.closest("[name]");
    if (!field) return;
    const evidence = $(`[data-evidence-field="${field.name}"]`);
    if (evidence) {
      $$(".evidence-item.highlight").forEach((element) =>
        element.classList.remove("highlight"),
      );
      evidence.classList.add("highlight");
      evidence.scrollIntoView({ block: "nearest" });
    }
  });
  update();
}

async function showLogin() {
  const status = await api("status");
  const setup = status.setupRequired;
  $("#navigation").innerHTML = "";
  $("#sectionNavigation").innerHTML = "";
  $("#user").textContent = "请登录团队工作区";
  $("#logout").hidden = true;
  $("#refresh").hidden = true;
  $("#workspace").innerHTML =
    `<section class="login-panel"><div class="eyebrow">TALENT HUB · TEAM WORKSPACE</div><h2>${setup ? "建立团队工作区" : "欢迎回来"}</h2><p>${setup ? "首次启动请在本机创建管理员。密码仅保存加盐哈希，不提供默认共享密码。" : "使用独立团队账号登录，访问权限由服务端校验。"}</p><form id="loginForm" class="team-form">${input("username", "登录账号")}${setup ? input("name", "显示姓名") : ""}${input("password", "密码（至少 10 个字符）", "", "password")}<div id="formError" class="inline-error"></div><button class="btn primary" type="submit">${setup ? "创建管理员并进入" : "登录工作区"}</button></form></section>`;
  formHandler("#loginForm", async (v) => {
    const result = await api(setup ? "setup" : "login", v);
    csrf = result.csrf;
    location.hash = "candidates";
    await sync();
  });
}
function render() {
  if (!S) return;
  $("#logout").hidden = false;
  $("#refresh").hidden = false;
  [route, routeId = ""] = location.hash.slice(1).split("/");
  route = route || "candidates";
  if (["jobs", "matching", "pipeline", "interviews"].includes(route)) {
    location.replace("#recruitment/" + route + (routeId ? "/" + routeId : ""));
    return;
  }
  const recruiting = [
    ...(can("write")
      ? [
          ["jobs", "岗位"],
          ["matching", "匹配"],
        ]
      : []),
    ...(can("pipeline") ? [["pipeline", "跟进"]] : []),
    ["interviews", "面试"],
    ...(S.user.role !== "面试官" ? [["analytics", "统计"]] : []),
  ];
  const recruitingActive = route === "recruitment" || route === "analytics";
  const recruitmentTab = recruiting.some(
    ([path]) => path !== "analytics" && path === routeId,
  )
    ? routeId
    : recruiting[0][0];
  const routes = [
    ["candidates", "▤　人才库"],
    ...(can("write") ? [["imports", "⇧　简历导入"]] : []),
    ["recruitment", "▣　招聘"],
    ["settings", "⚙　系统设置"],
  ];
  $("#navigation").innerHTML = routes
    .map(
      ([r, l]) =>
        `<button class="nav ${route === r || (r === "candidates" && route === "profile") || (r === "recruitment" && recruitingActive) ? "sel" : ""}" data-nav="${r}">${l}</button>`,
    )
    .join("");
  $("#sectionNavigation").innerHTML = recruitingActive
    ? recruiting
        .map(
          ([path, label]) =>
            `<button class="${(route === "analytics" ? path === route : path === recruitmentTab) ? "sel" : ""}" data-nav="${path === "analytics" ? path : "recruitment/" + path}" ${(route === "analytics" ? path === route : path === recruitmentTab) ? 'aria-current="page"' : ""}>${label}</button>`,
        )
        .join("")
    : "";
  if (route === "recruitment") routeId = location.hash.split("/")[2] || "";
  const handler = {
    candidates: candidates,
    profile: profile,
    imports: importsPage,
    recruitment: () =>
      ({
        jobs: jobsPage,
        pipeline: pipelinePage,
        matching: matchingPage,
        interviews: interviewsPage,
      })[recruitmentTab](),
    analytics: analytics,
    settings: settings,
  };
  if (!handler[route]) {
    nav("candidates");
    return;
  }
  Promise.resolve(handler[route]()).catch((e) => {
    notify(e.message);
    $("#workspace").innerHTML = title(
      "暂时无法打开",
      e.message,
      button("返回人才库", "candidates"),
    );
  });
}
function applications() {
  return S.applications.filter(
    (a) =>
      (!queue.ownerId || a.ownerId === queue.ownerId) &&
      (!queue.stage || a.stage === queue.stage) &&
      (!queue.overdue || overdue(a.due, a.stage)),
  );
}
function appRows(rows) {
  return rows.map((a) => [
    button(esc(cname(a.candidateId)), "profile", a.candidateId),
    esc(jname(a.jobId)),
    tag(a.stage),
    esc(uname(a.ownerId)),
    esc(a.nextAction || a.result || "已结案"),
    `<span class="${overdue(a.due, a.stage) ? "overdue" : ""}">${fmt(a.due)}${overdue(a.due, a.stage) ? " · 已逾期" : ""}</span>`,
    `<div class="team-actions">${button("跟进 / 推进", "editApplication", a.id)}${can("interview") && !["已录用", "已结束"].includes(a.stage) ? button("安排面试", "scheduleApplication", a.id) : ""}</div>`,
  ]);
}
function filteredCandidates() {
  let cs = S.candidates.filter((c) => !list.ids || list.ids.includes(c.id));
  const q = list.q.trim().toLowerCase();
  cs = cs.filter(
    (c) =>
      (!q ||
        Object.entries(c)
          .filter(
            ([k, v]) =>
              typeof v === "string" && !["monthly", "annual"].includes(k),
          )
          .map(([, v]) => v)
          .join(" ")
          .toLowerCase()
          .includes(q)) &&
      (!list.city || c.city === list.city) &&
      (!list.source || c.source === list.source) &&
      (!list.status.length || list.status.includes(c.status)) &&
      (!list.skills ||
        String(c.skills).toLowerCase().includes(list.skills.toLowerCase())) &&
      (!list.role || String(c.targetRole).includes(list.role)) &&
      (!list.education || String(c.education).includes(list.education)) &&
      (!list.years || Number(c.years) >= Number(list.years)) &&
      (!list.updatedFrom || dateOnly(c.updated) >= list.updatedFrom) &&
      (!list.updatedTo || dateOnly(c.updated) <= list.updatedTo) &&
      (!list.incomplete || c.missing?.length) &&
      (!list.unverified || !c.verified) &&
      (!list.resumeFrom || dateOnly(latestResumeDate(c)) >= list.resumeFrom) &&
      (!list.resumeTo || dateOnly(latestResumeDate(c)) <= list.resumeTo),
  );
  const [key, dir] = list.sort.split("-");
  return cs.sort((a, b) => {
    let x, y;
    if (key === "years") {
      x = Number(a.years) || 0;
      y = Number(b.years) || 0;
    } else {
      x = key === "resume" ? latestResumeDate(a) : a[key] || "";
      y = key === "resume" ? latestResumeDate(b) : b[key] || "";
    }
    return (
      (typeof x === "number"
        ? x - y
        : String(x).localeCompare(String(y), "zh-CN")) *
      (dir === "asc" ? 1 : -1)
    );
  });
}
function latestResumeDate(c) {
  return (
    c.latestResumeAt ||
    S.resumes
      .filter((r) => r.candidateId === c.id)
      .map((r) => r.created)
      .sort()
      .at(-1) ||
    c.created
  );
}
function candidateFilter(label, action, id, selected, tone = "") {
  return `<button type="button" class="btn candidate-filter ${tone}" data-action="${action}" data-id="${esc(id)}" aria-pressed="${selected}"><span class="filter-check" aria-hidden="true"></span>${label}</button>`;
}
function candidates() {
  const focusedFilter = document.activeElement?.closest(".candidate-filter");
  const cs = filteredCandidates();
  const pages = Math.max(1, Math.ceil(cs.length / list.size));
  list.page = Math.min(list.page, pages);
  const displayed = cs.slice(
    (list.page - 1) * list.size,
    list.page * list.size,
  );
  $("#workspace").innerHTML =
    title(
      list.resultContext ? `人才库 · ${list.resultContext.title}` : "人才库",
      `${S.candidates.length} 位可访问人才 · 资料完整与人工核实分别管理`,
      (can("export") ? button("导出当前结果", "exportCandidates") : "") +
        (can("write")
          ? button("＋ 新建档案", "editCandidate", "", true) +
            button("上传简历", "imports")
          : ""),
    ) +
    `${list.resultContext ? `<section class="candidate-result-context" aria-label="人才查询来源"><div><h4>${esc(list.resultContext.title)}</h4><p>${esc(list.resultContext.reason)}</p><p>${esc(list.resultContext.scope)}</p><small>来自招聘统计 · ${list.ids.length} 位关联人才（去重） · 统计时点：${esc(fmt(list.resultContext.asOf))}</small></div><div class="team-actions">${button("返回招聘统计", "backToMetrics")}${button("查看全部人才", "allCandidates")}</div></section>` : ""}<div class="pill-row" role="group" aria-label="人才状态筛选">${candidateFilter("全部", "allCandidates", "", !list.status.length && !list.incomplete && !list.unverified)}${statuses.map((s, index) => candidateFilter(`${esc(s)} ${S.candidates.filter((c) => c.status === s).length}`, "statusFilter", s, list.status.includes(s), `status-tone-${index}`)).join("")}${candidateFilter("待补全 " + S.candidates.filter((c) => c.missing?.length).length, "incompleteFilter", "", list.incomplete)}${candidateFilter("待核实 " + S.candidates.filter((c) => !c.verified).length, "unverifiedFilter", "", list.unverified)}</div><div class="filterbar"><input id="search" class="search" aria-label="检索人才" value="${esc(list.q)}" placeholder="姓名、公司、岗位或简历关键词…">${button("组合筛选", "filterCandidates")}<select id="candidateSort" aria-label="人才排序">${[
      ["updated-desc", "最近更新"],
      ["updated-asc", "最早更新"],
      ["resume-desc", "最新简历"],
      ["years-desc", "经验从高到低"],
      ["years-asc", "经验从低到高"],
      ["status-asc", "人才状态"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${list.sort === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select><select id="candidateSize" aria-label="每页数量">${[10, 20, 50, 100].map((n) => `<option ${list.size === n ? "selected" : ""}>${n}</option>`).join("")}</select></div><div class="hint">${Object.entries(
      list,
    )
      .filter(
        ([k, v]) =>
          !["page", "size", "sort", "q", "ids", "resultContext"].includes(k) &&
          (Array.isArray(v) ? v.length : v),
      )
      .map(([k, v]) =>
        esc(
          ({
            incomplete: "仅待补全",
            unverified: "仅待核实",
            updatedFrom: "更新日期起",
            updatedTo: "更新日期止",
            resumeFrom: "简历日期起",
            resumeTo: "简历日期止",
            years: "最低年限",
            status: "人才状态",
            ...F,
          }[k] || k) +
            (typeof v === "boolean"
              ? ""
              : "：" + (Array.isArray(v) ? v.join("、") : v)),
        ),
      )
      .join(" · ")}</div>` +
    table(
      [
        "候选人",
        "当前岗位 / 公司",
        "城市",
        "工作经验",
        "人才状态",
        "档案质量",
        "最新简历",
      ],
      displayed.map((c) => [
        `<div class="person"><span class="avatar">${esc(c.name[0])}</span><div>${button(esc(c.name), "profile", c.id)}<small>${esc(c.source || "来源不明")}</small></div></div>`,
        `${esc(c.employment === "未任职" ? "当前未任职" : c.role || "待补全")}<small style="display:block">${esc(c.employment === "未任职" ? "" : c.company || "待补全")}</small>`,
        esc(c.city || "未知"),
        esc(c.years !== "" ? c.years + " 年" : "待补全"),
        tag(
          c.status,
          `candidate-status status-tone-${statuses.indexOf(c.status)}${list.status.includes(c.status) ? " is-selected" : ""}`,
        ),
        c.missing?.length
          ? tag("待补全 " + c.missing.length, "amber")
          : tag(c.verified ? "已核实" : "待核对", c.verified ? "" : "amber"),
        fmt(latestResumeDate(c)),
      ]),
    ) +
    `<div class="tablefoot"><span>共 ${cs.length} 位人才 · 每页 ${list.size} 条</span><span>${button("‹ 上一页", "prevPage")}　${list.page} / ${pages}　${button("下一页 ›", "nextPage")}</span></div>`;
  $("#search").oninput = (e) => {
    list.q = e.target.value;
    list.page = 1;
    clearTimeout(candidates.timer);
    candidates.timer = setTimeout(() => {
      const pos = e.target.selectionStart;
      candidates();
      $("#search").focus();
      $("#search").setSelectionRange(pos, pos);
    }, 180);
  };
  $("#candidateSort").onchange = (e) => {
    list.sort = e.target.value;
    list.page = 1;
    candidates();
  };
  $("#candidateSize").onchange = (e) => {
    list.size = Number(e.target.value);
    list.page = 1;
    candidates();
  };
  if (focusedFilter)
    [...$("#workspace").querySelectorAll(".candidate-filter")]
      .find(
        (filter) =>
          filter.dataset.action === focusedFilter.dataset.action &&
          filter.dataset.id === focusedFilter.dataset.id,
      )
      ?.focus({ preventScroll: true });
}
function filterCandidates() {
  openModal(
    "组合筛选与日期区间",
    `<form id="filterForm"><div class="form-grid">${input("city", "城市", list.city, "text", ["", ...new Set(S.candidates.map((c) => c.city).filter(Boolean))])}${input("source", "来源", list.source, "text", ["", ...new Set(S.candidates.map((c) => c.source).filter(Boolean))])}<fieldset class="field wide"><legend>人才状态</legend><div class="candidate-status-options">${statuses.map((s) => `<label class="checkbox-label"><input type="checkbox" data-candidate-status value="${esc(s)}" ${list.status.includes(s) ? "checked" : ""}>${esc(s)}</label>`).join("")}</div></fieldset>${input("role", "目标岗位包含", list.role)}${input("skills", "技能包含", list.skills)}${input("years", "最低工作年限", list.years, "number")}${input("education", "学历包含", list.education)}${input("updatedFrom", "档案更新日期起", list.updatedFrom, "date")}${input("updatedTo", "档案更新日期止", list.updatedTo, "date")}${input("resumeFrom", "最新简历日期起", list.resumeFrom, "date")}${input("resumeTo", "最新简历日期止", list.resumeTo, "date")}<label class="checkbox-label"><input type="checkbox" name="incomplete" ${list.incomplete ? "checked" : ""}>仅待补全</label><label class="checkbox-label"><input type="checkbox" name="unverified" ${list.unverified ? "checked" : ""}>仅待核实</label></div>${endForm("应用筛选")}</form>`,
  );
  formHandler("#filterForm", async (v) => {
    if (
      (v.updatedFrom && v.updatedTo && v.updatedFrom > v.updatedTo) ||
      (v.resumeFrom && v.resumeTo && v.resumeFrom > v.resumeTo)
    )
      throw Error("起始日期不能晚于结束日期");
    Object.assign(list, v, {
      status: [
        ...document.querySelectorAll(
          "#filterForm [data-candidate-status]:checked",
        ),
      ].map((option) => option.value),
      incomplete: v.incomplete === "on",
      unverified: v.unverified === "on",
      page: 1,
    });
    closeModal();
    candidates();
  });
}
async function editCandidate(id) {
  const c = id ? await api("detail/candidate/" + id) : {};
  openModal(
    id ? "编辑并核实档案" : "新建人才档案",
    `<form id="candidateForm"><p class="modal-note">* 为必需信息；在职时还需填写当前公司和岗位。</p><div class="form-grid">${profileFields(c, true)}${input("employment", "当前任职状态", c.employment || "在职", "text", ["在职", "未任职"])}${input("status", "人才库状态", c.status || "新入库", "text", statuses)}<label class="checkbox-label wide"><input type="checkbox" name="verified" ${c.verified ? "checked" : ""}>我已核对这些字段；全部必需信息有效时标记“已核实”</label></div>${endForm("保存档案")}</form>`,
  );
  bindProfileQuality("#candidateForm");
  formHandler("#candidateForm", async (v) => {
    await api("candidate", {
      ...v,
      id: c.id,
      rev: c.rev,
      verified: v.verified === "on",
    });
    closeModal();
    await sync();
    notify("档案已保存；缺项可在详情查看");
  });
}
function profileDetails(candidate) {
  return [
    ["联系与求职意向", ["phone", "email", "city", "targetCity", "targetRole"]],
    [
      "任职与能力",
      ["company", "role", "years", "education", "english", "skills"],
    ],
    ["补充信息", ["industry", "monthly", "annual", "source"]],
  ]
    .map(
      ([label, keys]) =>
        `<section class="profile-detail-group"><h4>${label}</h4><dl class="compact-meta">${keys
          .filter(
            (key) =>
              can("salary") ||
              !["monthly", "annual", "phone", "email"].includes(key),
          )
          .map(
            (key) =>
              `<dt>${esc(F[key])}</dt><dd>${esc(candidate[key] ?? "") || (candidate.employment === "未任职" && ["company", "role"].includes(key) ? "当前未任职" : requiredProfile.includes(key) || (["company", "role"].includes(key) && candidate.employment !== "未任职") ? "待补全" : "未填写（选填）")}</dd>`,
          )
          .join("")}</dl></section>`,
    )
    .join("");
}
function resumeReader(resume) {
  const file = `/api/file/resume/${encodeURIComponent(resume.id)}`;
  return `<div class="resume-reader"><div class="resume-reader-toolbar"><strong>${esc(resume.name)}</strong><div class="team-actions"><button class="btn" data-action="expandResume">全屏阅读</button><a class="btn" href="${file}" target="_blank" rel="noopener">打开原件</a><a class="btn" href="${file}" download>下载原件</a></div></div>${resume.name.toLowerCase().endsWith(".docx") ? '<p class="hint">DOCX 阅读预览保留正文和基本格式，精确排版请打开原件。</p>' : ""}<iframe class="resume-document" title="简历原文：${esc(resume.name)}" src="/api/preview/resume/${encodeURIComponent(resume.id)}" sandbox="allow-same-origin"></iframe></div>`;
}
async function profile() {
  const c = await api("detail/candidate/" + routeId);
  const resume = S.resumes.filter((r) => r.candidateId === c.id);
  const apps = S.applications.filter((a) => a.candidateId === c.id);
  const ints = S.interviews.filter((i) => i.candidateId === c.id);
  $("#workspace").innerHTML =
    title(
      "候选人档案",
      "人才库 / " + c.name,
      button("返回列表", "candidates") +
        (can("write") ? button("编辑档案", "editCandidate", c.id, true) : ""),
    ) +
    `<div class="profile-grid"><div class="panel"><div class="profile-head"><span class="avatar">${esc(c.name[0])}</span><div><b>${esc(c.name)}</b><p>${esc(c.employment === "未任职" ? "当前未任职" : c.role || "待补全")} · ${esc(c.years ?? "待补全")} 年经验</p></div></div><div class="pill-row">${tag(c.status)}${tag(c.missing?.length ? "待补全" : c.verified ? "已核实" : "待核对", c.verified ? "" : "amber")}</div>${profileDetails(c)}<p class="hint">薪资独立选填，人民币税前；年薪为年度总包。${can("salary") ? "" : "当前角色隐藏联系方式、薪资和原件。"}</p>${c.missing?.length ? `<p class="hint overdue">缺失或无效：${c.missing.map((k) => esc(F[k] || k)).join("、")}</p>` : ""}</div><div class="panel"><div class="section-tabs">${[
      ["resume", "简历原文"],
      ["pipeline", "岗位流程 · " + apps.length],
      ["interviews", "面试记录 · " + ints.length],
      ["versions", "简历版本 · " + resume.length],
    ]
      .map(
        ([k, l]) =>
          `<button class="${profileTab === k ? "sel" : ""}" data-profile-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="profileContent"></div></div></div>`;
  const target = $("#profileContent");
  if (profileTab === "resume") {
    const selected =
      resume.find((entry) => entry.id === c.currentResumeId) ||
      [...resume].sort((first, second) =>
        second.created.localeCompare(first.created),
      )[0];
    target.innerHTML =
      can("files") && selected
        ? `<label class="resume-version-select">简历版本<select id="profileResumeSelect">${resume.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === selected.id ? "selected" : ""}>${esc(entry.name)}${entry.id === c.currentResumeId ? " · 当前选定" : ""}</option>`).join("")}</select></label><div id="resumeReaderHost">${resumeReader(selected)}</div>`
        : `<div class="resume-text-document">${esc(c.text || (can("files") ? "尚未上传简历原件，可上传简历或编辑档案录入正文。" : "当前角色无权查看简历原件。"))}</div>`;
    if ($("#profileResumeSelect"))
      $("#profileResumeSelect").onchange = (event) => {
        $("#resumeReaderHost").innerHTML = resumeReader(
          resume.find((entry) => entry.id === event.target.value),
        );
      };
  }
  if (profileTab === "pipeline")
    target.innerHTML =
      (can("pipeline")
        ? button("＋ 加入岗位流程", "editApplicationForCandidate", c.id, true)
        : "") +
      table(
        ["岗位", "阶段", "负责人", "下一步 / 截止", "操作"],
        apps.map((a) => [
          esc(jname(a.jobId)),
          tag(a.stage),
          esc(uname(a.ownerId)),
          esc(a.nextAction) + "<br>" + fmt(a.due),
          can("pipeline") ? button("跟进", "editApplication", a.id) : "只读",
        ]),
      );
  if (profileTab === "interviews")
    target.innerHTML =
      interviewTable(ints) +
      (c.legacyInterviews?.length
        ? `<h3>旧版迁移面试（原始记录，只读）</h3><p class="hint">尚未建立团队岗位与面试官关联，不计入新流程指标。</p>${table(
            ["原岗位 / 类型", "时间", "原面试官 / 评分", "原反馈"],
            c.legacyInterviews.map((i) => [
              esc(i.job) + " · " + esc(i.type),
              esc(i.time),
              esc(i.interviewer) + " / " + esc(i.score || "未评分"),
              esc(i.feedback),
            ]),
          )}`
        : "");
  if (profileTab === "versions")
    target.innerHTML =
      (resume
        .map(
          (r) =>
            `<div class="version-row"><div><b>${esc(r.name)}</b> ${c.currentResumeId === r.id ? tag("当前选定") : ""}<p class="hint">${fmt(r.created)} · ${esc(r.source)} · ${esc(r.actor)}${r.ocr ? " · OCR 文字" : ""}</p></div><div class="team-actions">${button("查看原文", "viewResume", r.id)}${can("write") ? button("采用本版解析值", "adoptResume", r.id) : ""}</div></div>`,
        )
        .join("") || '<p class="empty">当前权限下无简历版本。</p>') +
      `<h3 class="section-gap">人才状态历史</h3>${(c.statusHistory || []).map((h) => `<div class="history-item">${esc(h.from)} → ${esc(h.to)} · ${esc(h.actor)} · ${fmt(h.time)}</div>`).join("") || '<p class="hint">暂无人才库状态变更；岗位阶段历史在对应岗位流程中查看。</p>'}`;
  $$("[data-profile-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        profileTab = b.dataset.profileTab;
        profile();
      }),
  );
}
async function viewResume(id) {
  const r = await api("detail/resume/" + id);
  openModal("简历原文 · " + r.name, resumeReader(r), true);
}
function rawPages(pages) {
  return (pages || [])
    .map(
      (p) =>
        `<b>第 ${p.page} 页 / 段落组</b>\n` +
        p.text
          .split("\n")
          .map(
            (line, n) =>
              `<div class="raw-line" id="line-${p.page}-${n + 1}"><small>${n + 1}</small>${esc(line)}</div>`,
          )
          .join(""),
    )
    .join("<hr>");
}
function bindLocate() {
  $$("[data-locate]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = $("#line-" + b.dataset.locate);
        if (t) {
          $$(".raw-line").forEach((e) => e.classList.remove("highlight"));
          t.classList.add("highlight");
          t.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }),
  );
}
function importsPage() {
  if (!can("write")) throw Error("当前角色不能管理导入");
  $("#workspace").innerHTML =
    title(
      "简历导入",
      "文件保存、文字解析、人工核实分别记录；离开页面不会丢失任务",
      button("＋ 上传简历", "upload", "", true),
    ) +
    table(
      [
        "文件 / 来源",
        "文件保存",
        "解析",
        "审查状态",
        "错误 / 重复原因",
        "操作",
      ],
      [...S.imports]
        .reverse()
        .map((t) => [
          `${esc(t.name)}<small style="display:block">${esc(t.source)} · 尝试 ${t.attempts} 次</small>`,
          tag(t.saved ? "已保存" : "未保存"),
          tag(
            t.parsed ? "已解析" : t.state === "failed" ? "失败" : "等待中",
            t.state === "failed" ? "amber" : "gray",
          ) +
            (t.parsed
              ? `<small style="display:block">${t.parserMode === "model" ? "本地模型填表" : "规则提取"}</small>`
              : ""),
          tag(TASK[t.state] || t.state, t.state === "duplicate" ? "amber" : ""),
          `<span class="${t.error || t.modelWarning ? "overdue" : ""}">${esc(t.error || t.modelWarning || t.duplicates?.map((d) => d.reasons.join(" / ")).join("；") || "—")}</span>`,
          ["review", "duplicate", "failed"].includes(t.state)
            ? button(
                t.state === "failed" ? "恢复处理" : "核对 / 比较",
                "reviewImport",
                t.id,
              )
            : t.candidateId
              ? button("打开档案", "profile", t.candidateId)
              : "任务已持久保存",
        ]),
    ) +
    `<div class="hint">失败原件不会删除，可重试或手工建档。相同文件依据 SHA-256 识别；电话 / 邮箱先标准化。同名本身不会触发自动关联。</div>`;
}
function upload() {
  const maxFiles = S.limits?.maxBatchFiles || 50;
  const maxMiB = (S.limits?.maxUploadBytes || 20 * 1024 * 1024) / 1024 / 1024;
  openModal(
    "批量上传简历",
    `<form id="uploadForm"><div class="form-grid">${input("source", "本批次来源", "本地上传", "text", ["本地上传", "招聘平台", "员工推荐", "其他"])}<label class="field">选择文件（每批最多 ${maxFiles} 份）<input type="file" id="uploadFiles" multiple accept=".txt,.pdf,.docx" required></label></div><p class="modal-note">每份最多 ${maxMiB} MiB；原件保存后由后台解析。单份失败会继续处理其他文件，已保存的任务可离开页面后继续查看。</p><div id="uploadProgress" class="hint" role="status"></div>${endForm("上传并保存任务")}<div class="actions">${button("完成并查看任务", "imports")}</div></form>`,
  );
  formHandler("#uploadForm", async (v) => {
    const files = [...$("#uploadFiles").files];
    if (!files.length || files.length > maxFiles)
      throw Error(`请选择 1–${maxFiles} 份简历`);
    let failures = 0,
      saved = 0;
    const progress = $("#uploadProgress");
    progress.textContent = "";
    for (const f of files) {
      const line = document.createElement("div");
      line.textContent = f.name + " · 正在保存…";
      progress.append(line);
      try {
        const requestId = crypto.randomUUID();
        await api("upload", {
          requestId,
          source: v.source,
          files: [await encodeFile(f)],
        });
        line.textContent = f.name + " · 已保存，等待后台解析";
        saved++;
      } catch (error) {
        line.textContent = f.name + " · 未保存：" + error.message;
        line.className = "overdue";
        failures++;
        if (!S) return;
      }
    }
    await sync(false);
    if (failures) {
      notify(
        `已保存 ${saved} 份，${failures} 份未保存，请核对逐项原因后重新选择`,
      );
    } else {
      closeModal();
      nav("imports");
      notify(`已保存 ${saved} 份原件，可在任务列表继续查看`);
    }
  });
}
async function encodeFile(f) {
  const maximum = S?.limits?.maxUploadBytes || 20 * 1024 * 1024;
  if (f.size > maximum) throw Error(f.name + " 超过单份上传上限");
  const raw = new Uint8Array(await f.arrayBuffer());
  let text = "";
  for (let i = 0; i < raw.length; i += 32768)
    text += String.fromCharCode(...raw.subarray(i, i + 32768));
  return { name: f.name, base64: btoa(text) };
}

async function reviewImport(id) {
  const t = await api("detail/import/" + id);
  const failure = t.state === "failed";
  openModal(
    failure ? "恢复失败导入" : "核对提取字段与疑似重复",
    `<p class="modal-note">${esc(t.name)} · ${TASK[t.state]} · ${t.parserMode === "model" ? "本地模型填表" : "规则提取"}${t.ocr ? " · 本地 OCR 来源" : ""}</p>${t.modelWarning ? `<p class="inline-error" role="status">${esc(t.modelWarning)}</p>` : ""}${failure ? `<p class="inline-error">${esc(t.error)}</p><div class="team-actions">${button("重试解析", "retryImport", id)}<a class="btn" href="/api/file/import/${id}" target="_blank" rel="noopener">查看已保存原件</a></div>` : `<div class="team-actions">${button("重新提取", "reparseImport", id)}</div>`}<form id="reviewForm"><div class="evidence-grid"><div><h3>解析值 / 人工修正</h3><div class="team-form">${profileFields(t.fields || {})}${input("employment", "当前任职状态", "在职", "text", ["在职", "未任职"])}<label class="checkbox-label"><input type="checkbox" name="verified">已逐项核实（缺项仍为待补全）</label></div></div><div><h3>原文与字段位置</h3><div class="evidence-list">${
      Object.entries(t.evidence || {})
        .map(
          ([k, e]) =>
            `<div class="evidence-item" data-evidence-field="${esc(k)}"><b>${esc(F[k] || k)}</b> ${tag(e.method === "model" ? "模型提取" : "规则提取", "gray")}<br>${esc(e.quote)}<br><button type="button" class="detail-link" data-locate="${e.page}-${e.line}">第 ${e.page} 页 / 段落组，第 ${e.line} 行</button></div>`,
        )
        .join("") || "未获得字段证据，可对照原始附件手工录入。"
    }</div><div class="raw-lines">${rawPages(t.pages)}</div></div></div>${
      t.duplicates?.length
        ? `<div class="section-gap"><h3>重复对照（不会自动覆盖主档）</h3>${t.duplicates
            .map(
              (d) =>
                `<div class="snapshot"><b>${esc(d.name)}</b> · ${esc(d.reasons.join(" / "))}<div class="compare"><div><b>本次解析</b>${Object.entries(
                  d.fields,
                )
                  .map(
                    ([k]) =>
                      `<div>${esc(F[k])}：${esc(t.fields?.[k] || "未知")}</div>`,
                  )
                  .join("")}</div><div><b>既有档案</b>${Object.entries(d.fields)
                  .map(
                    ([k, v]) => `<div>${esc(F[k])}：${esc(v || "未知")}</div>`,
                  )
                  .join("")}</div></div></div>`,
            )
            .join("")}${input(
            "candidateId",
            "关联到以下既有人才（仅追加简历版本）",
            t.duplicates[0].id,
            "text",
            t.duplicates.map((d) => ({ value: d.id, label: d.name })),
          )}</div>`
        : ""
    }<div class="form-grid section-gap">${input("decision", "本次处理决定", failure ? "manual" : t.duplicates?.length ? "link" : "create", "text", [...(t.duplicates?.length ? [{ value: "link", label: "关联既有人才，追加版本" }] : []), { value: failure ? "manual" : "create", label: "确认独立建档（允许共用联系方式）" }, { value: "skip", label: "跳过本次导入" }])}</div>${endForm("确认审查决定")}</form>`,
    true,
  );
  bindLocate();
  bindProfileQuality("#reviewForm");
  formHandler("#reviewForm", async (v) => {
    const action = v.decision;
    delete v.decision;
    const candidateId = v.candidateId;
    delete v.candidateId;
    v.verified = v.verified === "on";
    await api("import/" + id, { rev: t.rev, action, candidateId, fields: v });
    closeModal();
    await sync();
    notify("审查决定已保存，操作者与时间已记录");
  });
}
function jobsPage() {
  if (!can("write")) throw Error("当前角色不能管理岗位");
  $("#workspace").innerHTML =
    title(
      "岗位与 JD",
      "每次发布生成不可变版本，匹配结果始终指向当时的条件",
      button("＋ 新建岗位", "editJob", "", true),
    ) +
    table(
      ["岗位", "负责人", "JD 版本", "最近匹配", "操作"],
      S.jobs.map((j) => {
        const runs = S.runs.filter((r) => r.versionSnapshot.jobId === j.id);
        return [
          esc(j.title),
          esc(uname(j.ownerId)),
          tag("v" + j.versionIds.length),
          runs.length ? fmt(runs.at(-1).created) : "尚未匹配",
          `<div class="team-actions">${button("发布新版本", "editJob", j.id)}${button("版本历史", "jobHistory", j.id)}${button("安排候选人", "editApplicationForJob", j.id)}${button("运行匹配", "matchJob", j.id)}</div>`,
        ];
      }),
    );
}
function criterionRow(
  c = { kind: "skill", value: "", weight: 20, hard: false },
) {
  return `<div class="criteria-row"><select class="c-kind">${Object.entries(
    KIND,
  )
    .map(
      ([k, l]) =>
        `<option value="${k}" ${k === c.kind ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select><input class="c-value" placeholder="要求值" value="${esc(c.value)}" required><input class="c-weight" type="number" min="1" max="100" value="${esc(c.weight)}" required aria-label="要求权重"><label><input type="checkbox" class="c-hard" ${c.hard ? "checked" : ""}>硬性条件</label><button type="button" class="btn" data-remove-row aria-label="删除条件">×</button></div>`;
}
function editJob(id) {
  const j = id ? find("jobs", id) : {};
  const v = j.currentVersionId
    ? find("jobVersions", j.currentVersionId)
    : { criteria: [{ kind: "skill", value: "", weight: 100, hard: false }] };
  openModal(
    id ? "发布 JD 新版本" : "新建岗位与 JD",
    `<form id="jobForm"><div class="form-grid">${input("title", "岗位名称", j.title || "")}${input("ownerId", "岗位负责人", j.ownerId || S.user.id, "text", usersOptions())}<label class="field wide">导入 JD（PDF / DOCX / TXT）<input type="file" id="jdFile" accept=".pdf,.docx,.txt"></label>${input("text", "JD 原文", v.text || "", "textarea", null, true)}</div><p class="hint" id="jdHint">请逐项确认要求值、是否硬性与权重；未提及的条件不要添加。权重自动按总和归一化。</p><div id="criteriaRows">${v.criteria.map(criterionRow).join("")}</div><button class="btn" type="button" id="addCriterion">＋ 添加岗位要求</button><label class="checkbox-label section-gap"><input type="checkbox" name="confirmed" required>我已确认岗位条件；发布后生成独立版本</label>${endForm("确认并发布版本")}</form>`,
    true,
  );
  const weights = document.createElement("p");
  weights.className = "hint";
  weights.id = "weightSummary";
  $("#criteriaRows").after(weights);
  const drawWeights = () => {
    const rows = [...$("#criteriaRows").children];
    const total = rows.reduce(
      (sum, row) => sum + Number(row.querySelector(".c-weight").value || 0),
      0,
    );
    weights.textContent =
      "评分占比：" +
      rows
        .map(
          (row) =>
            `${row.querySelector(".c-value").value || "未命名条件"} ${total ? Math.round((Number(row.querySelector(".c-weight").value || 0) / total) * 1000) / 10 : 0}%`,
        )
        .join(" · ") +
      "。硬性条件单独判断，不等于额外加分。";
  };
  $("#criteriaRows").oninput = drawWeights;
  $("#addCriterion").onclick = () => {
    $("#criteriaRows").insertAdjacentHTML("beforeend", criterionRow());
    drawWeights();
  };
  $("#criteriaRows").onclick = (e) => {
    if (e.target.closest("[data-remove-row]"))
      e.target.closest(".criteria-row").remove();
    drawWeights();
  };
  drawWeights();
  $("#jdFile").onchange = async (e) => {
    if (!e.target.files[0]) return;
    try {
      $("#jdHint").textContent = "正在本地提取 JD 原文…";
      const r = await api("jd-text", {
        file: await encodeFile(e.target.files[0]),
      });
      $("#jobForm [name=text]").value = r.text;
      $("#jdHint").textContent = "原文已提取，请人工确认下方硬性与优先条件。";
    } catch (e) {
      formError(e);
    }
  };
  formHandler("#jobForm", async (data) => {
    const criteria = $$(".criteria-row").map((row) => ({
      kind: row.querySelector(".c-kind").value,
      value: row.querySelector(".c-value").value,
      weight: Number(row.querySelector(".c-weight").value),
      hard: row.querySelector(".c-hard").checked,
    }));
    await api("job", { ...data, id: j.id, rev: j.rev, criteria });
    closeModal();
    await sync();
    notify("新 JD 版本已发布，旧版本保持不变");
  });
}
function jobHistory(id) {
  const j = find("jobs", id);
  openModal(
    "JD 版本历史 · " + j.title,
    `<div class="team-stack">${j.versionIds
      .map((id) => find("jobVersions", id))
      .reverse()
      .map(
        (v) =>
          `<section class="panel"><h3>v${v.number} · ${esc(v.actor)} · ${fmt(v.created)}</h3><div class="quote">${esc(v.text)}</div>${v.criteria.map((c) => `<p>${tag(c.hard ? "硬性" : "优先", c.hard ? "blue" : "gray")} ${esc(KIND[c.kind])}：${esc(c.value)} · 权重 ${c.weight}</p>`).join("")}</section>`,
      )
      .join("")}</div>`,
    true,
  );
}
function pipelinePage() {
  if (!can("pipeline")) throw Error("当前角色不能维护岗位流程");
  const rows = applications().sort((a, b) =>
    String(a.due).localeCompare(String(b.due)),
  );
  $("#workspace").innerHTML =
    title(
      "岗位流程与责任待办",
      "人才库状态独立保留；每个岗位分别推进阶段、分配负责人和下一步",
      button("＋ 加入岗位", "editApplication", "", true),
    ) +
    `<div class="filterbar"><select id="queueOwner"><option value="">全部负责人</option>${usersOptions()
      .map(
        (u) =>
          `<option value="${u.value}" ${queue.ownerId === u.value ? "selected" : ""}>${esc(u.label)}</option>`,
      )
      .join(
        "",
      )}</select><select id="queueStage"><option value="">全部阶段</option>${stages.map((s) => `<option ${queue.stage === s ? "selected" : ""}>${s}</option>`).join("")}</select><label><input type="checkbox" id="queueLate" ${queue.overdue ? "checked" : ""}>仅逾期</label></div>` +
    table(
      ["人才", "岗位", "阶段", "负责人", "下一步 / 结论", "截止时间", "操作"],
      appRows(rows),
    );
  $("#queueOwner").onchange = (e) => {
    queue.ownerId = e.target.value;
    pipelinePage();
  };
  $("#queueStage").onchange = (e) => {
    queue.stage = e.target.value;
    pipelinePage();
  };
  $("#queueLate").onchange = (e) => {
    queue.overdue = e.target.checked;
    pipelinePage();
  };
}
function editApplication(id, candidateId = "", jobId = "") {
  const a = id ? find("applications", id) : {};
  if (!S.jobs.length || !S.candidates.length) {
    notify("请先建立岗位与人才档案");
    return;
  }
  openModal(
    id ? "更新岗位跟进" : "将人才加入岗位流程",
    `<form id="applicationForm"><div class="form-grid">${input(
      "candidateId",
      "候选人",
      a.candidateId || candidateId,
      "text",
      S.candidates.map((c) => ({
        value: c.id,
        label: c.name + " · " + c.role,
      })),
    )}${input(
      "jobId",
      "关联岗位",
      a.jobId || jobId,
      "text",
      S.jobs.map((j) => ({ value: j.id, label: j.title })),
    )}${input("stage", "当前阶段", a.stage || "待联系", "text", stages)}${input("ownerId", "负责人", a.ownerId || S.user.id, "text", usersOptions())}${input("nextAction", "下一步具体动作", a.nextAction || "")}${input("due", "截止日期时间", toLocal(a.due), "datetime-local")}${input("result", "本次结果 / 结案说明", a.result || "", "textarea", null, true)}</div>${a.history ? `<p class="hint">阶段历史：${a.history.map((h) => esc(h.stage) + " " + fmt(h.at)).join(" → ")}</p>` : ""}${endForm("保存跟进与阶段")}</form>`,
  );
  if (id) {
    $("#applicationForm [name=candidateId]").disabled = true;
    $("#applicationForm [name=jobId]").disabled = true;
  }
  formHandler("#applicationForm", async (v) => {
    await api("application", {
      ...v,
      id: a.id,
      rev: a.rev,
      candidateId: a.candidateId || v.candidateId,
      jobId: a.jobId || v.jobId,
      due: iso(v.due),
    });
    closeModal();
    await sync();
    notify("岗位流程已更新，人才库全局状态保持独立");
  });
}
function interviewTable(rows) {
  return table(
    [
      "岗位 / 轮次",
      "候选人 / 面试官",
      "安排时间",
      "反馈截止 / 负责人",
      "反馈状态",
      "操作",
    ],
    rows.map((i) => [
      `${esc(jname(i.jobId))}<small style="display:block">第 ${i.round} 轮 · ${esc(i.type)}</small>`,
      `${esc(cname(i.candidateId))}<small style="display:block">${esc(uname(i.interviewerId))}</small>`,
      `${fmt(i.time)}<small style="display:block">${i.duration} 分钟 · ${esc(i.meetingMode || "方式待确认")}</small>${i.meetingLocation ? `<small style="display:block">${esc(i.meetingLocation)}</small>` : ""}`,
      `<span class="${overdue(i.due, i.status) ? "overdue" : ""}">${fmt(i.due)}${overdue(i.due, i.status) ? " · 反馈逾期" : ""}</span><small style="display:block">${esc(uname(i.ownerId))}</small>`,
      tag(i.status, i.status === "已完成" ? "" : "blue"),
      can("interview")
        ? button("安排 / 填写反馈", "editInterview", i.id)
        : "只读",
    ]),
  );
}
function interviewsPage() {
  $("#workspace").innerHTML =
    title(
      "面试安排与反馈",
      "按岗位和轮次记录；保存时检查候选人、面试官的时间冲突",
      can("pipeline") ? button("＋ 安排面试", "editInterview", "", true) : "",
    ) +
    `<div class="filterbar"><input class="search" id="interviewSearch" placeholder="搜索人才、岗位或面试官"><select id="interviewStatus"><option value="">全部状态</option><option>已安排</option><option>待反馈</option><option>已完成</option><option>已取消</option><option value="late">反馈逾期</option></select></div><div id="interviewRows"></div>`;
  const draw = () => {
    const q = $("#interviewSearch").value.toLowerCase(),
      s = $("#interviewStatus").value;
    $("#interviewRows").innerHTML = interviewTable(
      S.interviews
        .filter(
          (i) =>
            (!q ||
              [
                cname(i.candidateId),
                jname(i.jobId),
                uname(i.interviewerId),
                i.feedback,
              ]
                .join(" ")
                .toLowerCase()
                .includes(q)) &&
            (!s || s === "late"
              ? s !== "late" || overdue(i.due, i.status)
              : i.status === s),
        )
        .sort((a, b) => a.time.localeCompare(b.time)),
    );
  };
  $("#interviewSearch").oninput = draw;
  $("#interviewStatus").onchange = draw;
  draw();
}
function editInterview(id, applicationId = "") {
  const i = id ? find("interviews", id) : {};
  const apps = S.applications;
  if (!apps.length) {
    notify("请先将候选人加入岗位流程，再安排面试");
    return;
  }
  const readonly = S.user.role === "面试官";
  openModal(
    readonly ? "填写本人面试反馈" : "面试安排与统一评价",
    `<form id="interviewForm"><div class="form-grid">${input(
      "applicationId",
      "关联岗位候选人流程",
      i.applicationId || applicationId || apps[0].id,
      "text",
      apps.map((a) => ({
        value: a.id,
        label: cname(a.candidateId) + " / " + jname(a.jobId),
      })),
    )}${input("round", "轮次", i.round || 1, "number")}${input("type", "面试类型", i.type || "电话初筛", "text", ["电话初筛", "业务面试", "综合面试"])}${input("time", "面试开始时间", toLocal(i.time), "datetime-local")}${input("duration", "时长（分钟）", i.duration || 60, "number")}${input("interviewerId", "面试官", i.interviewerId || S.user.id, "text", usersOptions())}${input("ownerId", "反馈跟进负责人", i.ownerId || S.user.id, "text", usersOptions())}${input("due", "反馈截止时间", toLocal(i.due), "datetime-local")}${input("status", "当前状态", i.status || "已安排", "text", ["已安排", "待反馈", "已完成", "已取消"])}${["score", "communication", "expertise", "problemSolving"].map((k) => input(k, { score: "总体评价", communication: "沟通表达", expertise: "专业能力", problemSolving: "问题解决" }[k] + "（1–5，选填）", i[k] || "", "text", ["", "1", "2", "3", "4", "5"])).join("")}${input("feedback", "具体反馈与证据", i.feedback || "", "textarea", null, true)}${input("nextAction", "HR 汇总 / 下一步建议", i.nextAction || "", "textarea", null, true)}</div><p class="hint">1 需明显提升，3 基本符合岗位要求，5 有明确优秀表现；留空表示尚未评价。不会自动加入简历匹配分。</p>${endForm("保存面试安排 / 反馈")}</form>`,
  );
  const form = $("#interviewForm");
  const grid = form.querySelector(".form-grid");
  const arrangement = document.createElement("details");
  arrangement.className = "profile-section wide";
  arrangement.open = !id;
  arrangement.innerHTML =
    "<summary>安排信息</summary><div class='form-grid'></div>";
  const evaluation = document.createElement("details");
  evaluation.className = "profile-section wide";
  evaluation.open = !!id;
  evaluation.innerHTML =
    "<summary>评价与反馈</summary><div class='form-grid'></div>";
  [...grid.children].forEach((field) => {
    const name = field.querySelector("[name]")?.name;
    const feedback = [
      "status",
      "score",
      "communication",
      "expertise",
      "problemSolving",
      "feedback",
      "nextAction",
    ].includes(name);
    (feedback ? evaluation : arrangement)
      .querySelector(".form-grid")
      .append(field);
  });
  grid.append(arrangement, evaluation);
  arrangement
    .querySelector(".form-grid")
    .insertAdjacentHTML(
      "beforeend",
      `${input("meetingMode", "面试方式", i.meetingMode || "待确认", "text", ["待确认", "电话", "视频", "现场"])}${input("meetingLocation", "地点 / 会议链接", i.meetingLocation || "")}`,
    );
  if (readonly)
    for (const k of [
      "applicationId",
      "round",
      "type",
      "time",
      "duration",
      "interviewerId",
      "ownerId",
      "due",
      "nextAction",
      "meetingMode",
      "meetingLocation",
    ]) {
      const field = $("#interviewForm [name=" + k + "]");
      field.disabled = true;
      const group = field.closest("fieldset");
      if (group) group.disabled = true;
      field
        .closest(".field")
        .querySelectorAll("button")
        .forEach((button) => {
          button.disabled = true;
        });
    }
  formHandler("#interviewForm", async (v) => {
    const a = find("applications", v.applicationId || i.applicationId);
    await api("interview", {
      ...i,
      ...v,
      id: i.id,
      rev: i.rev,
      applicationId: a.id,
      candidateId: a.candidateId,
      jobId: a.jobId,
      time: readonly ? i.time : iso(v.time),
      due: readonly ? i.due : iso(v.due),
    });
    closeModal();
    await sync();
    if (v.status === "已完成" && can("pipeline")) {
      openModal(
        "面试反馈已保存",
        `<p>岗位阶段仍为“${esc(find("applications", a.id).stage)}”，人才库状态不变。</p><div class="team-actions">${button("继续更新岗位阶段", "editApplication", a.id, true)}<button class="btn" type="button" id="finishFeedback">完成</button></div>`,
      );
      $("#finishFeedback").onclick = closeModal;
    }
    notify("面试记录已保存");
  });
}
function matchingPage() {
  if (!can("write")) throw Error("当前角色不能运行匹配");
  $("#workspace").innerHTML =
    title(
      "岗位匹配与历史快照",
      "逐项查看硬性条件、覆盖度与原文证据；排序不自动录用或淘汰",
      button("创建匹配任务", "newRun", "", true),
    ) +
    `<p class="hint">排序分组：满足已确认条件 → 待确认 → 存在明确差距；组内按覆盖度及证据得分排序。覆盖度低于 70% 标为信息不足。</p>` +
    table(
      ["岗位 / JD 版本", "创建时间", "任务进度", "评分方式", "操作"],
      [...S.runs]
        .reverse()
        .map((r) => [
          esc(r.versionSnapshot.title) + " · v" + r.versionSnapshot.number,
          fmt(r.created),
          `<span id="run-status-${r.id}">${tag(RUNSTATE[r.state] || r.state)} ${r.done || 0} / ${r.scope}${r.errors?.length ? " · 失败 " + r.errors.length : ""}</span>`,
          r.configSnapshot.mode === "model" ? "本地模型" : "本地证据规则",
          button("查看固定快照", "viewRun", r.id) +
            (["partial", "failed"].includes(r.state)
              ? button("重试失败项", "retryRun", r.id)
              : ""),
        ]),
    ) +
    `<div id="runContent"></div>`;
  if (routeId) viewRun(routeId, false);
}
function newRun(jobId = "") {
  if (!S.jobs.length) {
    notify("请先创建岗位并确认 JD");
    return;
  }
  const versions = [...S.jobVersions].reverse();
  const selectedVersion = jobId
    ? find("jobs", jobId)?.currentVersionId
    : versions[0]?.id;
  openModal(
    "创建固定输入的匹配任务",
    `<form id="runForm"><div class="form-grid">${input(
      "versionId",
      "岗位与 JD 版本",
      selectedVersion,
      "text",
      versions.map((v) => ({
        value: v.id,
        label: v.title + " · v" + v.number,
      })),
    )}${input("scope", "选择匹配范围", "complete", "text", [
      { value: "complete", label: "全部已核实且完整档案" },
      { value: "filtered", label: "当前人才列表筛选结果中的已核实档案" },
      { value: "pipeline", label: "已加入该岗位的已核实档案" },
    ])}</div><p class="modal-note">创建时固定 JD、规则、模型配置、候选人修订和选定简历版本。任务后台执行，可离开页面；历史结果不会随档案更新而变化。</p>${endForm("保存快照并开始后台匹配")}</form>`,
  );
  const eligible = S.candidates.filter(
    (candidate) => candidate.verified && !candidate.missing?.length,
  );
  const excluded = S.candidates.filter(
    (candidate) => !eligible.includes(candidate),
  );
  const quality = document.createElement("details");
  quality.className = "profile-section";
  quality.innerHTML = `<summary>当前可匹配 ${eligible.length} 人 · 待处理 ${excluded.length} 人</summary>${excluded.map((candidate) => `<p>${esc(candidate.name)}：${esc(candidate.missing?.length ? candidate.missing.map((key) => F[key]).join("、") : "尚未人工核实")} ${button("补全 / 核实", "editCandidate", candidate.id)}</p>`).join("") || "所有可访问档案均符合当前匹配准入条件。"}`;
  $("#runForm").prepend(quality);
  formHandler("#runForm", async (v) => {
    let ids = [];
    if (v.scope === "filtered") ids = filteredCandidates().map((c) => c.id);
    if (v.scope === "pipeline") {
      const jobId = find("jobVersions", v.versionId).jobId;
      ids = S.applications
        .filter((a) => a.jobId === jobId)
        .map((a) => a.candidateId);
    }
    if (v.scope !== "complete" && !ids.length)
      throw Error("所选范围没有候选人");
    const run = await api("run", { versionId: v.versionId, candidateIds: ids });
    closeModal();
    await sync(false);
    nav("recruitment/matching/" + run.id);
    notify("匹配任务已创建，输入快照已固定");
  });
}
async function viewRun(id, inModal = true) {
  currentRun = await api("detail/run/" + id);
  activeMatch = 0;
  if (inModal) {
    openModal(
      "匹配结果 · " + currentRun.versionSnapshot.title,
      '<div id="modalRunContent"></div>',
      true,
    );
  }
  renderRun();
}
function sortedItems() {
  const groups = { 满足已确认条件: 0, 待确认: 1, 存在明确差距: 2 };
  return [...currentRun.items].sort(
    (a, b) =>
      groups[a.group] - groups[b.group] ||
      b.coverage - a.coverage ||
      (b.score ?? -1) - (a.score ?? -1),
  );
}
function renderRun() {
  const r = currentRun;
  const content = $("#dialog").open ? $("#modalRunContent") : $("#runContent");
  if (!r || !content) return;
  const items = sortedItems();
  activeMatch = Math.min(activeMatch, Math.max(0, items.length - 1));
  const summary = $("#run-status-" + r.id);
  if (summary)
    summary.innerHTML = `${tag(RUNSTATE[r.state] || r.state)} ${r.items.length} / ${r.scope}${r.errors.length ? " · 失败 " + r.errors.length : ""}`;
  content.innerHTML = `<div class="snapshot">固定快照：JD v${r.versionSnapshot.number} · ${esc(r.ruleVersion)} · ${fmt(r.created)}<br>评分方式：${r.configSnapshot.mode === "model" ? "本地模型 " + esc(r.configSnapshot.model) : "本地证据规则"} · 完成 ${r.items.length}/${r.scope} · ${RUNSTATE[r.state] || r.state}</div><div class="task-progress"><i style="width:${r.scope ? ((r.items.length + r.errors.length) / r.scope) * 100 : 0}%"></i></div>${can("export") ? button("导出本次固定结果", "exportRun", r.id) : ""}<div class="team-grid section-gap"><div class="matchlist">${items.map((v, n) => `<button class="rank ${n === activeMatch ? "sel" : ""}" data-match-index="${n}" style="width:100%;text-align:left"><small>${n + 1}</small><span class="avatar">${esc(v.name[0])}</span><div class="body"><b>${esc(v.name)}</b><p>${esc(v.group)} · 覆盖 ${v.coverage}%${v.provisional ? " · 信息不足" : ""}</p></div><span class="score">${v.score ?? "—"}</span></button>`).join("") || '<div class="empty">后台正在逐人处理；可刷新查看进度。</div>'}</div><div id="matchDetail" class="result-panel"></div></div>${r.errors.length ? `<div class="section-gap"><h3>失败项（成功结果保留）</h3>${r.errors.map((e) => `<p class="hint overdue">${esc(e.name)}：${esc(e.error)}</p>`).join("")}${button("重试失败项", "retryRun", r.id)}</div>` : ""}`;
  function detail() {
    const v = items[activeMatch];
    if (!v) return;
    content.querySelector("#matchDetail").innerHTML =
      `<h3>${esc(v.name)} · ${esc(v.group)}</h3><p class="hint">证据得分 ${v.score ?? "未知"} · 覆盖度 ${v.coverage}%${v.provisional ? " · 信息不足，暂定分数" : ""}<br>档案修订 ${v.candidateSnapshot.rev} · 简历版本 ${esc(v.resumeSnapshot?.name || "手工档案")}<br>未提及视为待确认，不视为明确不满足。</p>${v.dimensions.map((d) => `<div class="evidence-item"><b>${esc(KIND[d.kind])}：${esc(d.value)}</b> ${tag({ MET: "满足", PARTIAL: "部分满足", NOT_MET: "不满足", UNKNOWN: "待确认" }[d.status], d.status === "UNKNOWN" ? "amber" : d.status === "NOT_MET" ? "gray" : "")} ${tag(d.hard ? "硬性" : "优先", "blue")}<br>权重 ${d.weight} · 维度分 ${d.level ?? "未知"}<br>${esc(d.quote || "尚无可回溯证据，需进一步核实。")}${d.location ? `<br>第 ${d.location.page} 页 / 段落组，第 ${d.location.line} 行` : ""}</div>`).join("")}<div class="team-actions section-gap">${button("查看评分时原文", "snapshotResume", v.candidateId)}${button("当前人才档案", "profile", v.candidateId)}${can("pipeline") ? button("HR 决定加入岗位流程", "matchToPipeline", v.candidateId) : ""}</div>`;
  }
  if (can("export"))
    content
      .querySelector("[data-action=exportRun]")
      .insertAdjacentHTML(
        "afterend",
        button("导出明细 CSV", "exportRunCsv", r.id),
      );
  content.querySelectorAll("[data-match-index]").forEach(
    (b) =>
      (b.onclick = () => {
        activeMatch = Number(b.dataset.matchIndex);
        content
          .querySelectorAll("[data-match-index]")
          .forEach((x) => x.classList.toggle("sel", x === b));
        detail();
      }),
  );
  detail();
}
async function analytics() {
  if (S.user.role === "面试官") throw Error("当前角色不能查看团队运营指标");
  $("#workspace").innerHTML =
    title(
      "招聘运营看板",
      "统一口径，支持按岗位、来源与入库时间队列复盘",
      can("export")
        ? button("导出汇总 CSV", "exportMetricsCsv") +
            button("导出 JSON", "exportMetrics")
        : "",
    ) +
    `<form class="filterbar" id="metricsForm">${input("start", "入库日期起", metricsFilter.start || "", "date")}${input("end", "入库日期止", metricsFilter.end || "", "date")}${input("source", "渠道", metricsFilter.source || "", "text", ["", ...new Set(S.candidates.map((c) => c.source).filter(Boolean))])}${input("jobId", "岗位", metricsFilter.jobId || "", "text", [{ value: "", label: "全部岗位" }, ...S.jobs.map((j) => ({ value: j.id, label: j.title }))])}<button class="btn primary" type="submit">应用筛选</button></form><div id="metricsContent" class="section-gap"></div>`;
  $("#metricsForm").onsubmit = async (e) => {
    e.preventDefault();
    metricsFilter = Object.fromEntries(new FormData(e.target));
    try {
      await drawMetrics();
    } catch (e) {
      notify(e.message);
    }
  };
  await drawMetrics();
}
let metrics = null;
async function drawMetrics() {
  metrics = await api("metrics", metricsFilter);
  const m = metrics,
    max = Math.max(1, ...m.trends.map((x) => x[1]));
  $("#metricsForm").setAttribute(
    "aria-label",
    "入库队列筛选；导入质量按上传日期统计",
  );
  $("#metricsContent").innerHTML =
    `<div class="team-kpis"><button class="team-kpi" data-action="drillTotal">队列人才<b>${m.total}</b>查看范围内人才</button><div class="team-kpi">待补全 / 待核实<b>${m.incomplete} / ${m.unverified}</b>完整与核实独立统计</div><button class="team-kpi" data-action="drillOverdue">岗位逾期待办<b>${m.overdue}</b>查看跟进逾期人才</button><button class="team-kpi" data-action="drillFeedback">逾期面试反馈<b>${m.feedbackOverdue}</b>查看反馈逾期人才</button></div><div class="team-grid"><section class="panel"><h3>按入库月份新增趋势</h3><div class="trend">${m.trends.map(([k, n]) => `<div title="${k}：${n}"><small>${n}</small><i style="height:${(n / max) * 130}px"></i><span class="trend-label">${k}</span></div>`).join("") || '<p class="hint">此范围没有人才</p>'}</div></section><section class="panel"><h3>导入质量</h3><p>解析成功率：${m.parseRate === null ? "尚无已处理任务" : m.parseRate + "%"}<br>分母：${m.parseDenominator} 个已完成解析或失败的导入任务<br>疑似重复上传项：${m.duplicateCount}<br>统计时点：${fmt(m.asOf)}</p></section></div><section class="panel section-gap"><h3>岗位阶段人数、转化与停留</h3>${table(
      [
        "阶段",
        "当前申请数",
        "曾到达本阶段",
        "到达下一阶段 / 转化率",
        "平均停留天数",
        "关联人才",
      ],
      m.stages.map((s) => [
        esc(s.stage),
        s.current,
        s.reached,
        s.conversion === null ? "—" : `${s.advanced} / ${s.conversion}%`,
        s.averageDays ?? "—",
        button("查看当前阶段人才", "drillStage", s.stage),
      ]),
    )}</section><section class="panel section-gap"><h3>渠道质量（去重人才）</h3>${table(
      ["来源", "入库", "已安排面试", "当前录用", "面试率 / 录用率", "关联人才"],
      m.channels.map((s) => [
        esc(s.source),
        s.candidates,
        s.interviewed,
        s.hired,
        `${s.interviewRate}% / ${s.hireRate}%`,
        button("查看渠道人才", "drillChannel", s.source),
      ]),
    )}</section><details class="profile-section"><summary>完整统计口径</summary><p class="hint">${esc(m.definitions)}</p></details>`;
  $("#metricsContent").insertAdjacentHTML(
    "afterbegin",
    `<p class="profile-quality">统计时点：${esc(fmt(m.asOf))}。人才、渠道和阶段按人才入库日期形成队列；导入质量按上传日期统计。跳过的阶段不推定已通过。</p>`,
  );
}
function drill(ids, title, reason) {
  const cohort = metrics.cohort || {};
  const scope = [
    `岗位：${cohort.jobId ? jname(cohort.jobId) : "全部岗位"}`,
    `渠道：${cohort.source || "全部渠道"}`,
    `入库日期：${cohort.start || "不限起始"} 至 ${cohort.end || "不限结束"}`,
  ].join(" · ");
  list = {
    ...list,
    q: "",
    city: "",
    source: "",
    skills: "",
    status: [],
    role: "",
    education: "",
    years: "",
    updatedFrom: "",
    updatedTo: "",
    resumeFrom: "",
    resumeTo: "",
    incomplete: false,
    unverified: false,
    ids,
    resultContext: { title, reason, scope, asOf: metrics.asOf },
    page: 1,
  };
  nav("candidates");
}
function settings() {
  const conf = S.config || {};
  $("#workspace").innerHTML =
    title("系统设置", "账号、权限、模型与备份均由服务器校验") +
    `<div class="team-grid"><section class="panel"><h3>当前身份</h3><p>${esc(S.user.name)} · ${esc(S.user.role)}<br>可用权限：${S.permissions.map(esc).join("、")}<br>会话 ${S.limits?.sessionHours || 8} 小时有效；修改密码会注销本人全部会话。</p>${button("修改本人密码", "changePassword")}<h3 class="section-gap">字段治理</h3><p>性别无必要业务用途，不收集、不设必填、不提供筛选统计、不进入匹配。未任职通过明确选项表示；占位值不算完整。联系方式、薪资和原件仅限管理员 / HR 查看。面试官只能查看安排给本人的人才和面试。</p></section>${can("admin") ? `<section class="panel"><h3>本地模型与 OCR</h3><p>简历字段提取默认使用 Qwen/Qwen3.8-27B；岗位匹配默认使用可复核证据规则。模型请求由服务端发送，浏览器不接触模型接口。无远程回退。</p>${button("配置模型 / OCR", "editConfig")}<h3 class="section-gap">共享数据备份</h3><p>包含数据库记录、账号密码哈希、原件与审计；备份含敏感信息，请妥善保管。恢复后所有会话失效。</p>${button("导出完整工作区", "backup", "", true)} ${button("恢复工作区备份", "restoreBackup")}<input type="file" id="backupFile" accept=".json" hidden></section>` : '<section class="panel"><h3>共享工作区</h3><p>人才、原件和任务保存在服务端，不依赖当前浏览器。模型配置、用户管理、审计与备份恢复仅管理员可用。</p></section>'}</div>${
      can("admin")
        ? `<section class="panel section-gap"><div class="work-title"><h3>团队账号与访问控制</h3>${button("＋ 创建账号", "editUser", "", true)}</div>${table(
            ["账号", "姓名", "角色", "状态", "操作"],
            S.users.map((u) => [
              esc(u.username),
              esc(u.name),
              esc(u.role),
              u.active ? "启用" : "禁用",
              button("编辑 / 重置密码", "editUser", u.id),
            ]),
          )}</section><section class="panel section-gap"><h3>全局审计记录</h3>${table(
            ["时间", "实际操作者", "动作", "对象"],
            S.audit.map((a) => [
              fmt(a.time),
              esc(a.actor),
              esc(a.action),
              esc(a.entity),
            ]),
          )}</section>`
        : ""
    }`;
  if ($("#backupFile")) $("#backupFile").onchange = restoreBackup;
}
function editUser(id) {
  const u = id ? S.users.find((u) => u.id === id) : {};
  openModal(
    id ? "维护团队账号" : "创建独立团队账号",
    `<form id="userForm"><div class="form-grid">${input("username", "登录账号", u.username || "")}${input("name", "显示姓名", u.name || "")}${input("role", "角色", u.role || "HR", "text", ["管理员", "HR", "招聘经理", "面试官"])}${input("password", id ? "重置密码（留空保留原密码）" : "初始密码（至少 10 个字符）", "", "password")}<label class="checkbox-label"><input type="checkbox" name="active" ${u.active !== 0 ? "checked" : ""}>启用账号</label></div><p class="hint">管理员 / HR 可查看薪资、原件并导出；招聘经理不可查看薪资、原件和导出；面试官只可访问安排给本人的档案及反馈。修改账号后旧会话失效。</p>${endForm("保存账号")}</form>`,
  );
  if (id) $("#userForm [name=username]").disabled = true;
  formHandler("#userForm", async (v) => {
    await api("admin/user", {
      ...v,
      id: u.id,
      username: u.username || v.username,
      active: v.active === "on",
    });
    closeModal();
    await sync();
    notify("账号与权限已保存");
  });
}
function editConfig() {
  const c = S.config;
  openModal(
    "本地模型与 OCR 配置",
    `<form id="configForm"><div class="form-grid"><h4 class="config-heading">简历字段提取</h4>${input(
      "extractionMode",
      "字段识别方式",
      c.extractionMode ?? (c.mode === "model" ? "model" : "rules"),
      "text",
      [
        { value: "rules", label: "规则提取" },
        { value: "model", label: "本地大模型填表" },
      ],
    )}<p class="config-help">模型不可用时保留规则结果供核对；没有原文依据的字段保持空白。</p><h4 class="config-heading">岗位匹配</h4>${input(
      "mode",
      "匹配评分方式",
      c.mode,
      "text",
      [
        { value: "rules", label: "证据规则" },
        { value: "model", label: "本地大模型辅助评分" },
      ],
    )}<p class="config-help">此设置只影响岗位匹配，不影响简历字段提取。</p><h4 class="config-heading">本地模型服务</h4>${input(
      "model",
      "模型 ID",
      c.model,
    )}${input(
      "modelUrl",
      "OpenAI 兼容接口",
      c.modelUrl,
      "text",
      null,
      true,
    )}<label class="field wide">API Key<input type="password" name="apiKey" autocomplete="new-password" maxlength="4096" placeholder="${c.apiKeyConfigured ? "已配置，留空保留原密钥" : "输入模型接口密钥"}"></label><div class="config-actions wide"><button type="button" class="btn" data-action="testModelConfig">测试模型连接</button><span id="modelTestResult" class="config-test" role="status" aria-live="polite"></span></div><h4 class="config-heading">扫描件 OCR</h4><label class="checkbox-label wide"><input type="checkbox" name="ocr" ${c.ocr ? "checked" : ""}>扫描 PDF 启用本机 OCR</label><p class="config-help">OCR 负责把扫描图片转成文字，字段提取再使用上方规则或大模型。没有 OCR 时，TXT、DOCX 和带文字层的 PDF 仍可提取；纯扫描 PDF 无法只靠规则识别。</p><p class="hint wide">Windows 使用系统 OCR 语言包；Linux 使用 Tesseract。模型接口仅允许 localhost / 127.0.0.1 / ::1 或指定内网端点 http://172.30.0.101:20001/v1，禁止跳转。配置的字段提取或匹配使用本地模型时，简历原文会发送至该接口。</p></div>${endForm("保存配置")}</form>`,
  );
  formHandler("#configForm", async (v) => {
    await api("admin/config", { ...v, rev: c.rev, ocr: v.ocr === "on" });
    closeModal();
    await sync();
    notify("配置已保存；历史匹配仍保留旧配置快照");
  });
}
async function testModelConfig() {
  const form = $("#configForm");
  const result = $("#modelTestResult");
  const button = form.querySelector('[data-action="testModelConfig"]');
  const values = Object.fromEntries(new FormData(form));
  result.className = "config-test";
  result.textContent = "正在测试模型连接…";
  button.disabled = true;
  try {
    const response = await api("admin/model-test", {
      model: values.model,
      modelUrl: values.modelUrl,
      apiKey: values.apiKey,
    });
    result.className = "config-test success-line";
    result.textContent = `${response.message}：${response.model}`;
  } catch (error) {
    result.className = "config-test inline-error";
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function changePassword() {
  openModal(
    "修改本人密码",
    `<form id="passwordForm"><div class="form-grid">${input("old", "原密码", "", "password")}${input("password", "新密码（至少 10 个字符）", "", "password")}</div>${endForm("修改并重新登录")}</form>`,
  );
  formHandler("#passwordForm", async (v) => {
    await api("password", v);
    closeModal();
    S = null;
    await showLogin();
  });
}
async function restoreBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const backup = JSON.parse(await f.text());
    openModal(
      "恢复前确认",
      `<form id="restoreForm"><p class="modal-note">将替换当前服务端的业务数据与账号，所有用户将退出登录。请先保存当前备份。备份日期：${esc(backup.created || "未知")}</p>${input("confirm", "请输入“替换工作区”确认")}${endForm("确认替换并恢复")}</form>`,
    );
    formHandler("#restoreForm", async (v) => {
      await api("restore", { backup, confirm: v.confirm });
      closeModal();
      S = null;
      await showLogin();
      notify("工作区已恢复，请使用备份中的账号登录");
    });
  } catch (e) {
    notify("备份读取失败：" + e.message);
  }
}
async function exportCandidates() {
  const ids = filteredCandidates().map((c) => c.id);
  if (!ids.length) {
    notify("当前结果为空");
    return;
  }
  const r = await api("export", { ids });
  const keys = Object.keys(F).filter(
    (k) =>
      k !== "text" && (can("salary") || !["monthly", "annual"].includes(k)),
  );
  saveCsv("人才列表.csv", [
    keys.map((key) => F[key]),
    ...r.candidates.map((candidate) => keys.map((key) => candidate[key])),
  ]);
  notify("已按当前筛选和账号权限导出 " + r.candidates.length + " 条");
}
const actions = {
  refresh: () => sync(),
  candidates: () => nav("candidates"),
  imports: () => {
    closeModal();
    nav("imports");
  },
  profile: (id) => {
    profileTab = "resume";
    nav("profile/" + id);
  },
  editCandidate,
  filterCandidates,
  exportCandidates,
  upload,
  reviewImport,
  reparseImport: async (id) => {
    if (
      !confirm("重新提取将替换本次解析值，尚未保存的手工修改不会保留。继续？")
    )
      return;
    const task = await api("detail/import/" + id);
    await api("import/" + id, { rev: task.rev, action: "reparse" });
    closeModal();
    nav("imports");
    await sync();
    notify("已重新排队提取，原件保留");
  },
  viewResume,
  editJob,
  jobHistory,
  editApplication,
  editInterview,
  scheduleApplication: (id) => editInterview("", id),
  editUser,
  editConfig,
  testModelConfig,
  changePassword,
  editApplicationForCandidate: (id) => editApplication("", id),
  editApplicationForJob: (id) => editApplication("", "", id),
  matchJob: (id) => newRun(id),
  newRun: () => newRun(),
  viewRun,
  expandResume: async () => {
    const reader = $("#dialog[open] .resume-reader") || $(".resume-reader");
    if (reader) await reader.requestFullscreen();
  },
  prevPage: () => {
    list.page = Math.max(1, list.page - 1);
    candidates();
  },
  nextPage: () => {
    list.page++;
    candidates();
  },
  allCandidates: () => {
    list = {
      ...list,
      q: "",
      city: "",
      source: "",
      skills: "",
      status: [],
      role: "",
      education: "",
      years: "",
      updatedFrom: "",
      updatedTo: "",
      resumeFrom: "",
      resumeTo: "",
      incomplete: false,
      unverified: false,
      ids: null,
      resultContext: null,
      page: 1,
    };
    candidates();
  },
  statusFilter: (s) => {
    list.status = list.status.includes(s)
      ? list.status.filter((value) => value !== s)
      : [...list.status, s];
    list.page = 1;
    candidates();
  },
  incompleteFilter: () => {
    list.incomplete = !list.incomplete;
    list.page = 1;
    candidates();
  },
  unverifiedFilter: () => {
    list.unverified = !list.unverified;
    list.page = 1;
    candidates();
  },
  retryImport: async (id) => {
    const t = await api("detail/import/" + id);
    await api("import/" + id, { rev: t.rev, action: "retry" });
    closeModal();
    await sync();
    notify("失败任务已重新排队");
  },
  adoptResume: async (id) => {
    const r = find("resumes", id),
      c = find("candidates", r.candidateId);
    openModal(
      "采用本版解析值前确认",
      `<p class="modal-note">此操作会更新当前选定简历、简历正文和本版提取到的字段，已核实状态将清除。未提取字段保留，旧版本不删除。</p><div class="actions">${button("确认采用并重新核实", "confirmAdopt", id, true)}</div>`,
    );
  },
  confirmAdopt: async (id) => {
    const r = find("resumes", id),
      c = find("candidates", r.candidateId);
    await api("adopt", { resumeId: id, rev: c.rev });
    closeModal();
    await sync();
    notify("已采用新版本，请重新核实字段");
  },
  retryRun: async (id) => {
    await api("retry-run/" + id, {});
    closeModal();
    await sync();
    notify("匹配失败项已重新排队，成功项未丢失");
  },
  snapshotResume: (id) => {
    const v = currentRun.items.find((i) => i.candidateId === id);
    openModal(
      "评分时的固定简历原文",
      `<div class="snapshot">档案修订 ${v.candidateSnapshot.rev} · ${esc(v.resumeSnapshot?.name || "手工录入")} · 该快照不会随最新档案更新。</div><div class="raw-lines">${v.resumeSnapshot ? rawPages(v.resumeSnapshot.pages) : esc(v.candidateSnapshot.text)}</div>`,
      true,
    );
  },
  matchToPipeline: (id) => {
    const jobId = currentRun.versionSnapshot.jobId;
    closeModal();
    editApplication("", id, jobId);
  },
  exportRun: async (id) => {
    const r = await api("export-run", { id });
    saveDownload("岗位匹配固定快照.json", r);
    notify("已生成匹配快照，请查看浏览器下载列表");
  },
  exportRunCsv: async (id) => {
    const r = await api("export-run", { id });
    const run = r.run || r;
    saveCsv("岗位匹配明细.csv", [
      [
        "岗位",
        "JD版本",
        "匹配时间",
        "候选人",
        "分组",
        "证据分",
        "覆盖度%",
        "条件",
        "状态",
        "权重",
        "维度分",
        "原文证据",
      ],
      ...run.items.flatMap((item) =>
        item.dimensions.map((dimension) => [
          run.versionSnapshot.title,
          run.versionSnapshot.number,
          run.created,
          item.name,
          item.group,
          item.score,
          item.coverage,
          `${KIND[dimension.kind]}：${dimension.value}`,
          {
            MET: "满足",
            PARTIAL: "部分满足",
            NOT_MET: "不满足",
            UNKNOWN: "待确认",
          }[dimension.status],
          dimension.weight,
          dimension.level,
          dimension.quote,
        ]),
      ),
    ]);
    notify("已生成匹配明细 CSV，请查看浏览器下载列表");
  },
  exportMetrics: async () => {
    const r = await api("metrics", { ...metricsFilter, export: true });
    saveDownload("招聘运营汇总.json", r);
    notify("已生成运营汇总，请查看浏览器下载列表");
  },
  exportMetricsCsv: async () => {
    const report = await api("metrics", { ...metricsFilter, export: true });
    saveCsv("招聘运营汇总.csv", [
      ["统计时点", report.asOf],
      ["筛选条件", JSON.stringify(report.cohort)],
      ["口径", report.definitions],
      ["指标", "数值"],
      ["队列人才", report.total],
      ["待补全", report.incomplete],
      ["待核实", report.unverified],
      ["逾期待办", report.overdue],
      ["逾期反馈", report.feedbackOverdue],
      ["解析成功率%", report.parseRate],
      ["解析任务分母", report.parseDenominator],
      [],
      [
        "阶段",
        "当前申请数",
        "曾到达",
        "到达下一阶段",
        "转化率%",
        "平均停留天数",
      ],
      ...report.stages.map((stage) => [
        stage.stage,
        stage.current,
        stage.reached,
        stage.advanced,
        stage.conversion,
        stage.averageDays,
      ]),
      [],
      ["来源", "入库人数", "已安排面试", "当前录用", "面试率%", "录用率%"],
      ...report.channels.map((channel) => [
        channel.source,
        channel.candidates,
        channel.interviewed,
        channel.hired,
        channel.interviewRate,
        channel.hireRate,
      ]),
    ]);
    notify("已生成运营 CSV，请查看浏览器下载列表");
  },
  backToMetrics: () => nav("analytics"),
  drillTotal: () =>
    drill(
      metrics.candidateIds,
      "统计范围内人才",
      "展示符合招聘统计岗位、渠道与入库日期条件的全部人才。",
    ),
  drillOverdue: () =>
    drill(
      metrics.overdueIds,
      "岗位跟进逾期人才",
      "展示存在未结案且跟进截止时间已过的岗位申请所关联的人才。",
    ),
  drillFeedback: () =>
    drill(
      metrics.feedbackIds,
      "面试反馈逾期人才",
      "展示反馈截止时间已过、且面试尚未完成或取消所关联的人才。",
    ),
  drillStage: (s) =>
    drill(
      metrics.stages.find((x) => x.stage === s).candidateIds,
      `当前招聘阶段：${s}`,
      `仅展示当前处于“${s}”的岗位申请关联人才，不包含仅曾到达此阶段的申请。按人才去重，人数可能少于当前申请数；招聘阶段与人才库状态分别管理。`,
    ),
  drillChannel: (s) =>
    drill(
      metrics.channels.find((x) => x.source === s).candidateIds,
      `来源渠道：${s}`,
      `展示来源为“${s}”且符合当前统计范围的人才。`,
    ),
  backup: async () => {
    saveDownload("TalentHub共享工作区备份.json", await api("backup"));
    notify("完整备份已导出，包含账号哈希和附件，请妥善保管");
  },
  restoreBackup: () => $("#backupFile").click(),
};
document.addEventListener("click", async (e) => {
  const dateShortcut = e.target.closest("[data-date-offset]");
  if (dateShortcut) {
    const field = dateShortcut.closest(".field").querySelector("input");
    if (field.disabled) return;
    const date = new Date();
    date.setDate(date.getDate() + Number(dateShortcut.dataset.dateOffset));
    const local = toLocal(date);
    field.value =
      field.type === "date"
        ? local.slice(0, 10)
        : local.slice(0, 10) + (field.value.slice(10) || local.slice(10));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const choice = e.target.closest("[data-choice]");
  if (choice) {
    const group = choice.closest("[data-choice-group]");
    const field = group.closest(".choice-field").querySelector("input");
    if (field.disabled) return;
    field.value =
      group.dataset.clearable && field.value === choice.dataset.choice
        ? ""
        : choice.dataset.choice;
    group.querySelectorAll("[data-choice]").forEach((option) => {
      option.setAttribute(
        "aria-pressed",
        String(option.dataset.choice === field.value),
      );
    });
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const n = e.target.closest("[data-nav]");
  if (n) {
    nav(n.dataset.nav);
    return;
  }
  const b = e.target.closest("[data-action]");
  if (!b) return;
  e.preventDefault();
  try {
    await actions[b.dataset.action]?.(b.dataset.id);
  } catch (e) {
    formError(e);
  }
});
$("#closeModal").onclick = closeModal;
$("#dialog").addEventListener("close", () => {
  currentRun = null;
});
$("#logout").onclick = async () => {
  try {
    await api("logout", {});
    S = null;
    closeModal();
    await showLogin();
  } catch (e) {
    notify(e.message);
  }
};
$("#refresh").onclick = () => sync().catch((e) => notify(e.message));
$("#fullscreen").onclick = () =>
  document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen().catch(() => {});
window.addEventListener("hashchange", () => {
  closeModal();
  render();
});
setInterval(async () => {
  if (
    !S ||
    pollBusy ||
    $("#dialog").open ||
    !["imports", "recruitment"].includes(route)
  )
    return;
  pollBusy = true;
  try {
    await sync(false);
    if (
      route === "recruitment" &&
      location.hash.split("/")[1] === "matching" &&
      routeId
    ) {
      currentRun = await api("detail/run/" + routeId);
      renderRun();
    } else render();
  } catch (e) {
    notify(e.message);
  } finally {
    pollBusy = false;
  }
}, 4000);
(async () => {
  try {
    await sync();
  } catch (e) {
    try {
      await showLogin();
    } catch {
      if (location.protocol === "file:")
        $("#workspace").innerHTML =
          '<div class="empty">请先运行项目根目录的 start_windows.cmd 或 python server.py，然后打开 http://127.0.0.1:4173 。</div>';
      else
        $("#workspace").innerHTML =
          '<div class="empty">无法连接共享服务，请检查启动窗口。</div>';
    }
  }
})();
