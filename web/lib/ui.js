// Shared presentation helpers. Callers provide trusted markup for table cells/actions.
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const fmt = (v) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "未设置";
export const dateOnly = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    : "";
export const tag = (text, kind = "") =>
  `<span class="tag ${kind}">${esc(text)}</span>`;
export const button = (label, action, id = "", primary = false) =>
  `<button class="btn ${primary ? "primary" : ""}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
export const title = (h, p, actions = "") =>
  `<div class="work-title"><div><h3>${esc(h)}</h3><p>${esc(p)}</p></div><div class="team-actions">${actions}</div></div>`;
export const table = (heads, rows, empty = "暂无记录") =>
  `<div class="table-card"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
export function input(
  name,
  label,
  value = "",
  type = "text",
  options = null,
  wide = false,
) {
  if (["date", "datetime-local"].includes(type)) {
    return `<div class="field ${wide ? "wide" : ""}"><label for="date-${name}">${esc(label)}</label><input id="date-${name}" name="${name}" type="${type}" value="${esc(value)}"><div class="date-shortcuts"><button type="button" class="date-shortcut" data-date-offset="0">今天</button><button type="button" class="date-shortcut" data-date-offset="1">明天</button></div></div>`;
  }
  if (
    options &&
    options.length > 0 &&
    options.length <= 8 &&
    !name.endsWith("Id")
  ) {
    const choices = options.map((option) =>
      typeof option === "object"
        ? { value: String(option.value), label: String(option.label) }
        : { value: String(option), label: String(option) || "全部" },
    );
    const rating =
      choices.map((choice) => choice.value).join(",") === ",1,2,3,4,5";
    const selected = choices.some((choice) => choice.value === String(value))
      ? String(value)
      : choices[0].value;
    return `<fieldset class="field choice-field ${wide ? "wide" : ""}"><legend>${esc(label)}</legend><input type="hidden" name="${name}" value="${esc(selected)}"><div class="choice-group ${rating ? "rating-group" : ""}" data-choice-group ${rating ? 'data-clearable="true"' : ""}>${choices
      .filter((choice) => !rating || choice.value)
      .map(
        (choice) =>
          `<button type="button" class="choice-option" data-choice="${esc(choice.value)}" aria-pressed="${choice.value === selected}" aria-label="${esc(label + "：" + choice.label)}">${esc(choice.label)}</button>`,
      )
      .join("")}</div></fieldset>`;
  }
  return `<label class="field ${wide ? "wide" : ""}">${esc(label)}${
    options
      ? `<select name="${name}">${options
          .map((o) => {
            const v = typeof o === "object" ? o.value : o;
            const l = typeof o === "object" ? o.label : o;
            return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`;
          })
          .join("")}</select>`
      : type === "textarea"
        ? `<textarea name="${name}" rows="5">${esc(value)}</textarea>`
        : `<input name="${name}" type="${type}" value="${esc(value)}" ${type === "number" ? 'min="0" step="0.5"' : ""}>`
  }</label>`;
}
export function saveDownload(name, value, type = "application/json") {
  const content =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function saveCsv(name, rows) {
  const quote = (value) => {
    let text = String(value ?? "");
    if (typeof value !== "number" && /^[\s]*[=+@-]|^[\t\r]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  saveDownload(
    name,
    "\ufeff" + rows.map((row) => row.map(quote).join(",")).join("\r\n"),
    "text/csv;charset=utf-8",
  );
}
