import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

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
