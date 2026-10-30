# 开发与测试

返回 [README](../README.md) · [贡献指南](../CONTRIBUTING.md)

## 环境

开发基线为 Python 3.12，浏览器工具使用 Node.js 22+。在仓库根目录创建并激活虚拟环境，然后安装依赖：

```bash
python -m pip install -r requirements-dev.txt
npm ci
```

未激活环境时，Windows 将 `python` 替换为 `.venv\Scripts\python.exe`，Linux 替换为 `.venv/bin/python`。安装指令见 [README](../README.md#快速开始)。

日常开发使用独立的 `TALENT_DATA_DIR`，不要连接业务工作区。前端是原生 ES Modules，直接编辑 `web/` 后刷新，无需打包。

## 质量检查

```bash
python -m ruff check server.py talent_hub tests scripts
python -m ruff format --check server.py talent_hub tests scripts
python -m unittest discover -s tests -v
python scripts/check_repository.py
npm run format:check
npm run check:js
```

自动修正格式：

```bash
python -m ruff format server.py talent_hub tests scripts
npm run format
```

仓库检查只扫描 Git 已跟踪或待提交的源文件，验证文档相对链接、可能的凭据模式及不应发布的数据文件。它不是完整的凭据检测或内容审计替代品；提交前仍应查看差异。

## 测试结构

| 测试位置                      | 关注行为                                                 |
| ----------------------------- | -------------------------------------------------------- |
| `tests/test_domain.py`        | 完整度、占位信息、薪资、证据、未知条件与保守评分         |
| `tests/test_storage.py`       | 事务回滚、乐观锁、密码哈希、任务恢复与工作区锁           |
| `tests/test_http.py`          | 真实 HTTP 会话、角色权限、上传幂等、岗位面试及空目录恢复 |
| `tests/test_parsing_model.py` | 文档签名、DOCX 提取、OCR 恢复提示及模型响应契约          |
| `tests/web/`                  | 首次使用、逐文件上传错误恢复、文本转义与刷新持久化       |

服务端测试使用标准库 unittest。测试工作区由 TemporaryDirectory 创建，结束后清理；不读取默认用户数据目录，不需要真实简历、云端凭据或模型服务。短字段和文件字节在测试运行时生成，仓库不附模拟简历或默认业务记录。

共享短选项由 `web/lib/ui.js` 渲染为带 `aria-pressed` 的按钮组及同名隐藏字段，最多八个选项；关联 ID 字段和较长选项集保留原生选择。评分清空提交空字符串，仍使用现有面试接口一次性保存。禁用字段必须同时禁用按钮组；不能仅依靠隐藏值阻止用户交互。浏览器回归覆盖评分选择 / 清空 / 修改 / 保存、日期保留时分、请求次数、面试官权限及窄屏溢出，截图保存在忽略的 test-results 目录。

模型协议测试使用进程内替身，不代表某个实际模型的效果验证。OCR 测试不要求操作系统安装语言包；需要验收 OCR 和真实本地模型时，应在独立环境使用获准的数据及已部署的服务。

## 浏览器测试

首次安装 Chromium：

```bash
npx playwright install chromium
npm run test:web
```

Linux CI 使用 `npx playwright install --with-deps chromium` 安装系统依赖。可以通过 `PLAYWRIGHT_BROWSER_EXECUTABLE` 指向已有的 Chrome / Edge 可执行文件。

测试自动启动独立服务并创建临时工作区，默认端口 4181；本地环回请求自动绕过公司代理。Python 默认使用项目 `.venv`；可用 `TALENT_TEST_PYTHON` 指定解释器，端口冲突时设置 `TALENT_TEST_PORT`。测试结束后服务及临时数据会被清理，常规开发不需要设置 `TALENT_BROWSER_DATA_DIR`。

## CI

[Quality workflow](../.github/workflows/quality.yml) 在推送 main 和 Pull Request 时运行：

- Windows Server 2025 / Ubuntu 24.04 的 Python 3.12 格式、静态检查、回归测试和仓库检查。
- Ubuntu 的前端 / 文档格式、JavaScript 语法和 Chromium 流程测试。

工作流只授予 `contents: read`，固定支持 Node 24 的 Action 提交 SHA，不需要仓库外的模型密钥。CI 通过不等于已完成企业环境、浏览器矩阵、模型质量、OCR 语言包或大规模负载验收。

## 改动边界

HTTP、进程配置和模型传输已独立为模块。新增业务规则放在 `domain.py`，事务放在 `store.py`，业务权限及流程放在 `service.py`；不要让前端按钮隐藏承担权限控制。共享 HTML 呈现函数放在 `web/lib/ui.js`，数据必须经过转义后进入模板。

迁移或规则版本变化须保留旧数据和历史输入快照，并更新配置、API 及运维文档。避免在功能修复中夹带无关依赖升级或大范围样式变化。
