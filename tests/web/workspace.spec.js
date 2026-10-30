import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const browserErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator("#loginForm").waitFor();
  await page.locator("[name=username]").fill("browser-owner");
  await page.locator("[name=password]").fill("temporary-browser-test-password");
  if (await page.locator("#loginForm [name=name]").count()) {
    await page.locator("#loginForm [name=name]").fill("Browser regression");
  }
  await page.locator("#loginForm .primary").click();
  await expect(page.locator("#navigation [data-nav=candidates]")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

test("an empty workspace guides the first real action", async ({ page }) => {
  await expect(page.locator(".browser")).toHaveCount(0);
  await expect(page.locator("#navigation [data-nav]")).toHaveCount(4);
  await expect(page.locator("#candidateSort")).toBeVisible();
  await expect(page.locator(".table-card .empty")).toBeVisible();
  await expect(page.locator(".table-card tbody")).toContainText("暂无记录");
  await expect(page.locator("#candidateSize")).toHaveValue("20");
});

test("mouse workflow creates and edits records inside the consolidated recruitment module", async ({
  page,
}) => {
  await expect(page.getByRole("combobox", { name: "常用视图" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存视图", exact: true }),
  ).toHaveCount(0);
  await page.locator("[data-action=editCandidate]").first().click();
  await page.locator("#candidateForm [name=name]").fill("界面验收人才");
  await page.locator("#candidateForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "界面验收人才", exact: true }).click();
  await page.locator("[data-action=editCandidate]").first().click();
  await page.locator("#candidateForm [name=city]").fill("上海");
  await page.locator("#candidateForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await page.locator("#navigation [data-nav=recruitment]").click();
  await page.locator("[data-action=editJob]").first().click();
  await page.locator("#jobForm [name=title]").fill("界面验收岗位");
  await page.locator("#jobForm [name=text]").fill("需要 SQL 数据分析经验");
  await page.locator("#jobForm .c-value").fill("SQL");
  await page.locator("#jobForm [name=confirmed]").check();
  await page.locator("#jobForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator("#workspace")).toContainText("界面验收岗位");
  await page.locator("[data-action=editJob]").last().click();
  await page
    .locator("#jobForm [name=text]")
    .fill("需要 SQL 和 Python 数据分析经验");
  await page.locator("#jobForm [name=confirmed]").check();
  await page.locator("#jobForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  for (const tab of ["matching", "pipeline", "interviews", "jobs"]) {
    await page
      .locator(`#sectionNavigation [data-nav="recruitment/${tab}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`#recruitment/${tab}$`));
    await expect(page.locator("#workspace")).not.toBeEmpty();
    await expect(page.locator("#workspace")).not.toContainText("暂时无法打开");
  }
  await page.goto("/#matching");
  await expect(page).toHaveURL(/#recruitment\/matching$/);
  await page.goto("/#dashboard");
  await expect(page).toHaveURL(/#candidates$/);
});

test("candidate status filters toggle multiple statuses and emphasize matching badges", async ({
  page,
}) => {
  for (const [name, status] of [
    ["Status New", "新入库"],
    ["Status Interview", "面试中"],
    ["Status Reserve", "人才储备"],
  ]) {
    await page.locator("[data-action=editCandidate]").first().click();
    await page.locator("#candidateForm [name=name]").fill(name);
    await page
      .getByRole("button", { name: `人才库状态：${status}`, exact: true })
      .click();
    await page.locator("#candidateForm .primary").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
  }
  const statusFilter = (status) =>
    page.locator(`[data-action=statusFilter][data-id="${status}"]`);
  const all = page.locator("[data-action=allCandidates]");
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await statusFilter("新入库").click();
  await expect(statusFilter("新入库")).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".table-card tbody")).not.toContainText(
    "Status Interview",
  );
  await statusFilter("面试中").click();
  await expect(statusFilter("新入库")).toHaveAttribute("aria-pressed", "true");
  await expect(statusFilter("面试中")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".table-card tbody")).toContainText("Status New");
  await expect(page.locator(".table-card tbody")).toContainText(
    "Status Interview",
  );
  await expect(page.locator(".table-card tbody")).not.toContainText(
    "Status Reserve",
  );
  for (const badge of await page.locator(".candidate-status").all()) {
    await expect(badge).toHaveClass(/is-selected/);
  }
  await page.screenshot({
    path: test.info().outputPath("candidate-status-selection.png"),
  });
  await statusFilter("新入库").click();
  await expect(statusFilter("新入库")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".table-card tbody")).not.toContainText(
    "Status New",
  );
  await page.locator("[data-action=filterCandidates]").click();
  await expect(
    page.locator('#filterForm [data-candidate-status][value="面试中"]'),
  ).toBeChecked();
  await page
    .locator('#filterForm [data-candidate-status][value="人才储备"]')
    .check();
  await page.locator("#filterForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(statusFilter("人才储备")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".table-card tbody")).toContainText(
    "Status Reserve",
  );
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(
      '.candidate-filter[data-action=statusFilter][aria-pressed="true"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator(".candidate-status.is-selected")).toHaveCount(0);
  await statusFilter("面试中").focus();
  await page.keyboard.press("Space");
  await expect(statusFilter("面试中")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(all).toHaveAttribute("aria-pressed", "true");
});

test("recruitment metrics explain related candidate queries and preserve the return scope", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/boot")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": boot.csrf,
  };
  const create = async (path, data) => {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const candidate = await create("candidate", {
    name: "统计范围人才",
    source: "统计验收",
  });
  const job = await create("job", {
    title: "统计验收岗位",
    text: "SQL",
    criteria: [{ kind: "skill", value: "SQL", weight: 100 }],
  });
  await create("application", {
    candidateId: candidate.id,
    jobId: job.id,
    ownerId: boot.user.id,
    stage: "业务面试",
    nextAction: "确认面试",
    due: "2099-12-01T10:00:00+08:00",
  });
  await page.reload();
  await page.locator("#navigation [data-nav=recruitment]").click();
  await page.locator('#sectionNavigation [data-nav="analytics"]').click();
  await page.locator("#metricsForm [name=jobId]").selectOption(job.id);
  await page
    .getByRole("button", { name: "渠道：统计验收", exact: true })
    .click();
  await page.locator("#metricsForm [name=start]").fill("2020-01-01");
  await page.locator("#metricsForm [name=end]").fill("2099-12-31");
  await page.locator("#metricsForm .primary").click();
  const stage = page.locator(
    '#metricsContent [data-action=drillStage][data-id="业务面试"]',
  );
  await expect(page.locator("#metricsContent")).not.toContainText("下钻");
  await stage.click();
  await expect(page).toHaveURL(/#candidates$/);
  const context = page.getByRole("region", { name: "人才查询来源" });
  await expect(context).toContainText("当前招聘阶段：业务面试");
  await expect(context).toContainText("不包含仅曾到达此阶段");
  await expect(context).toContainText("岗位：统计验收岗位");
  await expect(context).toContainText("渠道：统计验收");
  await expect(context).toContainText("2020-01-01 至 2099-12-31");
  await expect(context).toContainText("1 位关联人才");
  await expect(page.locator(".table-card tbody")).toContainText("统计范围人才");
  await expect(page.locator(".table-card tbody tr")).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("candidate-query-context.png"),
  });
  await page.getByRole("button", { name: "返回招聘统计", exact: true }).click();
  await expect(page).toHaveURL(/#analytics$/);
  await expect(page.locator("#metricsForm [name=jobId]")).toHaveValue(job.id);
  await expect(page.locator("#metricsForm [name=start]")).toHaveValue(
    "2020-01-01",
  );
  await page
    .locator('#metricsContent [data-action=drillStage][data-id="已录用"]')
    .click();
  await expect(context).toContainText("当前招聘阶段：已录用");
  await expect(context).toContainText("0 位关联人才");
  await expect(page.locator(".table-card .empty")).toContainText("暂无记录");
  await page.getByRole("button", { name: "返回招聘统计", exact: true }).click();
  await page
    .locator('#metricsContent [data-action=drillChannel][data-id="统计验收"]')
    .click();
  await expect(context).toContainText("来源渠道：统计验收");
  await page.getByRole("button", { name: "查看全部人才", exact: true }).click();
  await expect(context).toHaveCount(0);
  await expect(page.locator(".work-title h3")).toHaveText("人才库");
});

test("recruitment keeps jobs matching pipeline and interviews within one navigation entry", async ({
  page,
}) => {
  await page.locator("#navigation [data-nav=recruitment]").click();
  await expect(page.locator("#sectionNavigation [data-nav]")).toHaveCount(5);
  for (const route of [
    "matching",
    "pipeline",
    "interviews",
    "analytics",
    "jobs",
  ]) {
    const target = route === "analytics" ? route : `recruitment/${route}`;
    await page.locator(`#sectionNavigation [data-nav="${target}"]`).click();
    await expect(
      page.locator(`#sectionNavigation [data-nav="${target}"]`),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.locator("#navigation [data-nav=recruitment]"),
    ).toHaveClass(/sel/);
    await expect(page.locator("#workspace")).not.toContainText("暂时无法打开");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .locator("#sectionNavigation")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(false);
  await page.locator("#navigation [data-nav=candidates]").click();
  await expect(page.locator("#sectionNavigation")).not.toBeVisible();
});

test("a rejected upload does not prevent later files from being saved", async ({
  page,
}) => {
  await page.locator("#navigation [data-nav=imports]").click();
  await expect(
    page.getByRole("heading", { name: "简历导入", exact: true }),
  ).toBeVisible();
  await page.locator("[data-action=upload]").click();
  await page.locator("#uploadFiles").setInputFiles([
    { name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from([255]) },
    {
      name: "valid.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Skills: SQL"),
    },
  ]);
  await page.locator("#uploadForm .primary").click();
  await expect(page.locator("#uploadProgress")).toContainText(
    "invalid.txt · 未保存",
  );
  await expect(page.locator("#uploadProgress")).toContainText(
    "valid.txt · 已保存",
  );
  await page.locator("#uploadForm [data-action=imports]").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator("[data-action=reviewImport]")).toBeVisible({
    timeout: 10_000,
  });
  await page.locator("[data-action=reviewImport]").click();
  await expect(page.locator(".evidence-list")).toContainText("Skills: SQL");
  await page.locator("#reviewForm [name=name]").fill("entry");
  await page.locator("#reviewForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator(".table-card")).toContainText("已人工处理");
});

test("user text stays text and records survive a page reload", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#navigation [data-nav=candidates]").click();
  await expect(page.locator("#candidateSort")).toBeVisible();
  await page.locator("[data-action=editCandidate]").click();
  await expect(page.locator("#candidateForm .profile-quality")).toContainText(
    "需补全或修正",
  );
  await expect(
    page.locator("#candidateForm .profile-section").last(),
  ).not.toHaveAttribute("open");
  const label = '<img src="invalid" onerror="throw Error(1)">';
  await page.locator("#candidateForm [name=name]").fill(label);
  await page.locator("#candidateForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: label, exact: true }),
  ).toBeVisible();
  await expect(page.locator("#workspace img")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: label, exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test("verified profiles show readable DOCX and PDF originals without stale evidence labels", async ({
  page,
}) => {
  const python =
    process.env.TALENT_TEST_PYTHON ||
    (process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python");
  const files = JSON.parse(
    execFileSync(
      python,
      [
        "-c",
        `
import base64, io, json
from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
document = Document()
document.add_heading('Resume Reader', level=1)
document.add_paragraph('Reader Profile - Original DOCX content')
document.add_paragraph().add_run('Original bold text').bold = True
document.add_table(rows=1, cols=1).cell(0, 0).text = 'SQL experience table'
document.add_paragraph('<script>throw Error(123)</script>')
docx = io.BytesIO()
document.save(docx)
writer = PdfWriter()
sheet = writer.add_blank_page(width=595, height=842)
font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
sheet[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
content = DecodedStreamObject()
content.set_data(b'BT /F1 24 Tf 50 760 Td (Original PDF Resume) Tj ET')
sheet[NameObject('/Contents')] = writer._add_object(content)
pdf = io.BytesIO()
writer.write(pdf)
print(json.dumps({'docx':base64.b64encode(docx.getvalue()).decode(),'pdf':base64.b64encode(pdf.getvalue()).decode()}))
`,
      ],
      { encoding: "utf8" },
    ),
  );
  const boot = await (await page.request.get("/api/boot")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": boot.csrf,
  };
  const post = async (path, data) => {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const importFile = async (extension) => {
    const [queued] = await post("upload", {
      files: [
        { name: `reader-original.${extension}`, base64: files[extension] },
      ],
    });
    let task;
    await expect
      .poll(async () => {
        task = await (
          await page.request.get(`/api/detail/import/${queued.id}`)
        ).json();
        return task.state;
      })
      .toBe("review");
    return task;
  };
  const docx = await importFile("docx");
  const adopted = await post(`import/${docx.id}`, {
    rev: docx.rev,
    action: "create",
    fields: {
      name: "Reader Profile",
      phone: "13900008888",
      email: "reader@example.invalid",
      city: "上海",
      targetCity: "上海",
      targetRole: "分析师",
      years: "0",
      education: "本科",
      english: "英语六级",
      employment: "未任职",
      verified: true,
    },
  });
  const pdf = await importFile("pdf");
  const linked = await post(`import/${pdf.id}`, {
    rev: pdf.rev,
    action: "link",
    candidateId: adopted.candidateId,
  });
  await page.reload();
  await page.goto(`/#profile/${adopted.candidateId}`);
  await expect(page.locator(".profile-grid")).toContainText("已核实");
  await expect(page.locator("#profileContent .evidence-item")).toHaveCount(0);
  await expect(page.locator(".profile-grid")).not.toContainText(
    "履历与字段证据",
  );
  await expect(page.locator("#profileContent")).not.toContainText("待核对");
  const preview = page.frameLocator(".resume-document");
  await expect(
    preview.getByRole("heading", { name: "Resume Reader" }),
  ).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("Original bold text");
  await expect(preview.locator("table")).toContainText("SQL experience table");
  await expect(preview.locator("body")).toContainText(
    "<script>throw Error(123)</script>",
  );
  await expect(preview.locator("script")).toHaveCount(0);
  expect(
    await page
      .locator(".compact-meta")
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(15);
  await page.screenshot({
    path: test.info().outputPath("profile-docx-reader.png"),
    fullPage: true,
  });
  const response = page.waitForResponse((response) =>
    response.url().endsWith(`/api/preview/resume/${linked.resumeId}?page=1`),
  );
  await page.locator("#profileResumeSelect").selectOption(linked.resumeId);
  expect((await response).headers()["content-type"]).toBe("image/png");
  await expect(preview.getByAltText("简历第 1 页")).toBeVisible();
  await expect
    .poll(() =>
      preview
        .getByAltText("简历第 1 页")
        .evaluate((image) => image.naturalWidth),
    )
    .toBeGreaterThan(500);
  await page.screenshot({
    path: test.info().outputPath("profile-pdf-reader.png"),
  });
  await page.locator("[data-action=expandResume]").click();
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(true);
  await page.evaluate(() => document.exitFullscreen());
});

test("a local model fills the import form before human review and can be retried", async ({
  page,
}) => {
  const rows = {
    name: {
      value: "Alex Example",
      page: 1,
      line: 1,
      quote: "Alex Example | Analyst",
    },
    city: { value: "Shanghai", page: 1, line: 3, quote: "Based in Shanghai" },
  };
  let requests = 0;
  let offline = false;
  const model = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.writeHead(offline ? 503 : 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(rows) } }],
        }),
      );
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    await page.locator("#navigation [data-nav=settings]").click();
    await page.locator("[data-action=editConfig]").click();
    await page
      .getByRole("button", {
        name: "字段识别方式：本地大模型填表",
        exact: true,
      })
      .click();
    await expect(page.locator("#configForm [name=mode]")).toHaveValue("rules");
    await page.locator("#configForm [name=model]").fill("browser-test-only");
    await page
      .locator("#configForm [name=modelUrl]")
      .fill(`http://127.0.0.1:${model.address().port}/v1`);
    await page.locator('[data-action="testModelConfig"]').click();
    await expect(page.locator("#modelTestResult")).toContainText(
      "模型连接成功",
    );
    await page.locator("#configForm .primary").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    await page.locator("#navigation [data-nav=imports]").click();
    await page.locator("[data-action=upload]").click();
    await page.locator("#uploadFiles").setInputFiles({
      name: "model-review.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Alex Example | Analyst\nEmail: alex@example.invalid\nBased in Shanghai",
      ),
    });
    await page.locator("#uploadForm .primary").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    const row = page
      .locator(".table-card tr")
      .filter({ hasText: "model-review.txt" });
    await expect(row).toContainText("本地模型填表", { timeout: 10000 });
    await row.locator("[data-action=reviewImport]").click();
    await expect(page.locator("#reviewForm [name=name]")).toHaveValue(
      "Alex Example",
    );
    await expect(page.locator("#reviewForm [name=city]")).toHaveValue(
      "Shanghai",
    );
    await expect(page.locator("#reviewForm [name=targetCity]")).toHaveValue("");
    await expect(page.locator("#reviewForm [name=verified]")).not.toBeChecked();
    await expect(page.locator(".evidence-list")).toContainText("模型提取");
    offline = true;
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-action=reparseImport]").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    await expect(row).toContainText("本地模型填表未完成", { timeout: 10000 });
    await row.locator("[data-action=reviewImport]").click();
    await expect(page.locator(".inline-error[role=status]")).toContainText(
      "已保留规则结果",
    );
    offline = false;
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-action=reparseImport]").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    await expect(row).toContainText("本地模型填表", { timeout: 10000 });
    await row.locator("[data-action=reviewImport]").click();
    await expect(page.locator("#reviewForm [name=name]")).toHaveValue(
      "Alex Example",
    );
    await page.locator("#reviewForm [name=name]").fill("Alex Reviewed");
    await page.locator("#reviewForm .primary").click();
    await expect(page.locator("#dialog")).not.toBeVisible();
    await page.locator("#navigation [data-nav=candidates]").click();
    await expect(
      page.getByRole("button", { name: "Alex Reviewed", exact: true }),
    ).toBeVisible();
    expect(requests).toBe(4);
  } finally {
    await model.closeAllConnections();
    await new Promise((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("matching snapshots render inside their dialog rather than the page", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/boot")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": boot.csrf,
  };
  const create = async (path, data) => {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const candidate = await create("candidate", {
    name: "快照测试",
    phone: "13900005678",
    email: "snapshot@example.invalid",
    city: "上海",
    targetCity: "上海",
    targetRole: "分析师",
    years: "5",
    education: "本科",
    english: "英语六级",
    employment: "未任职",
    company: "测试公司",
    role: "分析师",
    skills: "SQL",
    text: "技能：SQL",
    verified: true,
  });
  const job = await create("job", {
    title: "快照岗位",
    text: "SQL",
    criteria: [{ kind: "skill", value: "SQL", weight: 100 }],
  });
  const state = await (await page.request.get("/api/boot")).json();
  const published = state.jobs.find((entry) => entry.id === job.id);
  await create("run", {
    versionId: published.currentVersionId,
    candidateIds: [candidate.id],
  });
  await page.reload();
  await page.locator("#navigation [data-nav=recruitment]").click();
  await page
    .locator('#sectionNavigation [data-nav="recruitment/matching"]')
    .click();
  await page.locator("[data-action=viewRun]").last().click();
  await expect(page.locator("#dialog .snapshot")).toContainText("固定快照");
  await expect(page.locator("#workspace #runContent")).toBeEmpty();
  await expect(page.locator("#runContent")).toHaveCount(1);
  const matchDownload = page.waitForEvent("download");
  await page.locator("#dialog [data-action=exportRunCsv]").click();
  const matchFile = await matchDownload;
  expect(matchFile.suggestedFilename()).toBe("岗位匹配明细.csv");
  expect(await readFile(await matchFile.path(), "utf8")).toContain("覆盖度%");
  await page.locator("#dialog button[aria-label=关闭]").click();
  await page.locator("#sectionNavigation [data-nav=analytics]").click();
  await expect(page.locator("#metricsContent .profile-quality")).toContainText(
    "上传日期",
  );
  const metricsDownload = page.waitForEvent("download");
  await page.locator("[data-action=exportMetricsCsv]").click();
  const metricsFile = await metricsDownload;
  expect(await readFile(await metricsFile.path(), "utf8")).toContain(
    "解析任务分母",
  );
});

test("interview scores select clear and save once on desktop and mobile", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/boot")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": boot.csrf,
  };
  const create = async (path, data) => {
    const response = await page.request.post(`/api/${path}`, { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const candidate = await create("candidate", { name: "评分交互测试" });
  const job = await create("job", {
    title: "评分测试岗位",
    text: "SQL",
    criteria: [{ kind: "skill", value: "SQL", weight: 100 }],
  });
  const application = await create("application", {
    candidateId: candidate.id,
    jobId: job.id,
    stage: "待联系",
    ownerId: boot.user.id,
    nextAction: "电话初筛",
    due: "2030-01-02T10:00:00+08:00",
  });
  await page.reload();
  await page.locator("#navigation [data-nav=recruitment]").click();
  await page
    .locator('#sectionNavigation [data-nav="recruitment/pipeline"]')
    .click();
  await page
    .locator("#workspace tr")
    .filter({ hasText: "评分交互测试" })
    .locator("[data-action=scheduleApplication]")
    .click();
  await expect(page.locator("#interviewForm [name=applicationId]")).toHaveValue(
    application.id,
  );
  await page
    .locator("#interviewForm summary")
    .filter({ hasText: "评价与反馈" })
    .click();
  const score = page.locator("#interviewForm [name=score]");
  const group = score.locator("..");
  let writes = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/interview" &&
      request.method() === "POST"
    )
      writes++;
  });
  await group.locator('[data-choice="4"]').click();
  await expect(score).toHaveValue("4");
  await expect(group.locator('[data-choice="4"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await group.locator('[data-choice="4"]').click();
  await expect(score).toHaveValue("");
  await group.locator('[data-choice="3"]').click();
  await group.locator('[data-choice="5"]').click();
  await expect(score).toHaveValue("5");
  expect(writes).toBe(0);
  await page.locator("#interviewForm [name=time]").fill("2030-01-02T10:00");
  await page.locator("#interviewForm [name=due]").fill("2030-01-02T18:00");
  await page
    .locator("#interviewForm [name=meetingLocation]")
    .fill("测试会议室 A");
  const dueField = page.locator("#interviewForm [name=due]").locator("..");
  await dueField.getByRole("button", { name: "明天", exact: true }).click();
  await expect(page.locator("#interviewForm [name=due]")).toHaveValue(
    /T18:00$/,
  );
  await page.locator("#interviewForm [name=due]").fill("2030-01-02T18:00");
  await page.screenshot({
    path: test.info().outputPath("interview-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("interview-mobile.png"),
  });
  expect(
    await page
      .locator("#dialog")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(false);
  await page.locator("#interviewForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  expect(writes).toBe(1);
  await page
    .locator('#sectionNavigation [data-nav="recruitment/interviews"]')
    .click();
  const saved = await (await page.request.get("/api/boot")).json();
  expect(saved.interviews.at(-1).score).toBe("5");
  expect(saved.interviews.at(-1).meetingLocation).toBe("测试会议室 A");
  await page.locator("[data-action=editInterview]").last().click();
  const persistedScore = page.locator("#interviewForm [name=score]");
  await persistedScore.locator("..").locator('[data-choice="5"]').click();
  await expect(persistedScore).toHaveValue("");
  await page.locator("#interviewForm .primary").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  const cleared = await (await page.request.get("/api/boot")).json();
  expect(cleared.interviews.at(-1).score).toBe("");
  await page.locator("[data-action=editInterview]").last().click();
  await page
    .getByRole("button", { name: "当前状态：已完成", exact: true })
    .click();
  await page.locator("#interviewForm .primary").click();
  await expect(page.locator("#modalTitle")).toHaveText("面试反馈已保存");
  await page
    .getByRole("button", { name: "继续更新岗位阶段", exact: true })
    .click();
  await expect(page.locator("#applicationForm [name=candidateId]")).toHaveValue(
    candidate.id,
  );
  await page.locator("#dialog button[aria-label=关闭]").click();
  await create("admin/user", {
    username: "direct-reviewer",
    name: "面试官控件测试",
    role: "面试官",
    password: "temporary-browser-reviewer-password",
  });
  const withReviewer = await (await page.request.get("/api/boot")).json();
  const reviewer = withReviewer.users.find(
    (user) => user.username === "direct-reviewer",
  );
  await create("interview", {
    ...(await (await page.request.get("/api/boot")).json()).interviews.at(-1),
    interviewerId: reviewer.id,
  });
  await page.locator("#logout").click();
  await page.locator("#loginForm [name=username]").fill("direct-reviewer");
  await page
    .locator("#loginForm [name=password]")
    .fill("temporary-browser-reviewer-password");
  await page.locator("#loginForm .primary").click();
  await page.locator("#navigation [data-nav=recruitment]").click();
  await page.locator("[data-action=editInterview]").click();
  await expect(
    page
      .locator("#interviewForm [name=type]")
      .locator("..")
      .locator("[data-choice]")
      .first(),
  ).toBeDisabled();
  await expect(
    page
      .locator("#interviewForm [name=score]")
      .locator("..")
      .locator('[data-choice="4"]'),
  ).toBeEnabled();
  await page.locator("#closeModal").click();
  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
