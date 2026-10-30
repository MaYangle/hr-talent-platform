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
