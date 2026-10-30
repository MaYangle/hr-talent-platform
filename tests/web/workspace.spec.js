import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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

test("an empty workspace guides the first real action", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "从第一份人才资料开始" }),
  ).toBeVisible();
  await page.locator("#navigation [data-nav=candidates]").click();
  await expect(page.locator(".table-card .empty")).toBeVisible();
  await expect(page.locator(".table-card tbody")).toContainText("暂无记录");
  await expect(page.locator("#candidateSize")).toHaveValue("20");
  expect(errors).toEqual([]);
});

test("a rejected upload does not prevent later files from being saved", async ({
  page,
}) => {
  await page.locator("#navigation [data-nav=imports]").click();
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
  await page.locator("[data-action=editCandidate]").click();
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
