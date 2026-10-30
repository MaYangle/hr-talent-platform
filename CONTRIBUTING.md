# 贡献指南

感谢你帮助改进 Talent Hub。请先通过 [Issue](https://github.com/MaYangle/hr-talent-platform/issues) 描述实际问题和希望看到的行为；涉及权限、数据模型、模型输入或部署方式的较大修改，先说明方案与兼容性影响。

## 本地准备

1. 按 [README](README.md#快速开始) 创建 Python 3.12 虚拟环境。
2. 激活环境，运行 `python -m pip install -r requirements-dev.txt`。
3. 需要前端检查或浏览器测试时，安装 Node.js 22+ 并运行 `npm ci`。
4. 设置独立的 `TALENT_DATA_DIR`，运行 `python server.py`。

完整命令、测试隔离方式和 CI 说明见[开发与测试](docs/DEVELOPMENT.md)。不需要云端 API Key 或真实候选人资料即可执行回归测试。

## 修改约定

- 从 main 创建聚焦的分支；一个 PR 解决一个清楚的问题。
- 保持权限校验在服务端，所有业务写入通过数据层事务与修订校验。
- 解析或模型无法确认的事实保持未知，不能编造字段或证据。
- 模型与 OCR 保持本地处理；改变数据外发边界应先讨论并提供明确的用户选择。
- 用户流程、API、环境变量、权限或数据结构发生变化时同步更新相关文档。
- 依赖升级要说明原因、兼容性、许可变化和验证结果；不要自动升级到未验证的最新版本。

## 提交前检查

```bash
python -m ruff check server.py talent_hub tests scripts
python -m ruff format --check server.py talent_hub tests scripts
python -m unittest discover -s tests -v
python scripts/check_repository.py
npm run format:check
npm run check:js
```

修改界面交互时再运行 `npm run test:web`；首次需执行 `npx playwright install chromium`。测试应证明用户可观察的行为，优先覆盖权限、失败恢复和数据一致性，不为复述实现而增加测试。

## 数据与凭据

不要提交真实简历、完整模拟简历、候选人清单、数据库、导出备份、密码、Token 或 API Key。测试所需的最小字段应在临时工作区生成并清理，不进入应用初始化或安装数据。

复现问题时提供最小描述或充分脱敏的输入，避免把完整附件、工作区备份或个人路径贴到公开 Issue。安全问题按 [SECURITY.md](SECURITY.md) 私密报告。

## 提交说明与 Pull Request

推荐使用 `feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:` 前缀，标题写清行为变化。例如 `fix: preserve reviewed fields when adding a resume version`。

PR 描述应包含：

- 原问题及最终行为；
- 修改范围和兼容性 / 数据迁移影响；
- 已执行的检查及结果，尚未验证的环境；
- 必要的无个人信息界面截图。

提交前查看差异，确保不包含临时文件、运行数据或无关改动。请勿为 Issue 或 PR 中未经审查的内容赋予自动执行权限。

## 许可

提交贡献即表示你有权提供该内容，并同意按本项目的 [MIT License](LICENSE) 分发；第三方内容需要保留其原有许可和来源。项目当前不要求额外 CLA。
