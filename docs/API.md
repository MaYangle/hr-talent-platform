# API 说明

本文记录当前浏览器客户端使用的 API，不是独立版本承诺的公共 SDK。破坏性接口变更应在发布说明中注明。

## 认证与响应

除健康检查和初始化状态外，业务接口需要 `talent_session` Cookie。登录后通过 `GET /api/boot` 获取当前权限和 CSRF Token；修改请求必须提供同源 `Origin`、`Content-Type: application/json` 及 `X-CSRF-Token`。不要把会话 Token 或密码写入 URL。

错误响应为 `{"error":"可读的错误说明"}`。常用状态码：

| 状态码 | 含义                                 |
| ------ | ------------------------------------ |
| 400    | 参数、文件签名、日期或领域规则无效   |
| 401    | 未登录或会话已失效                   |
| 403    | 权限、主机、来源或 CSRF 校验失败     |
| 404    | 资源不存在或当前用户不可访问         |
| 409    | 修订冲突、日程冲突或幂等请求内容变化 |
| 413    | JSON 请求超过配置上限                |
| 429    | 登录尝试过于频繁                     |
| 503    | 就绪检查发现数据库或 Worker 不可用   |

更新业务记录时提交读取到的 `id` 与 `rev`；遇到 409 应刷新并重新核对，不能无条件覆盖。

## 健康与初始化

| 方法与路径                            | 用途                                         |
| ------------------------------------- | -------------------------------------------- |
| `GET /health/live`                    | 进程存活信息、应用标识和代码版本             |
| `GET /health/ready`                   | 数据库可读且 Worker 存活时返回 200，否则 503 |
| `GET /api/status`                     | 是否需要首次管理员初始化                     |
| `POST /api/setup`                     | 在服务本机创建首个管理员，仅允许一次         |
| `POST /api/login`、`POST /api/logout` | 建立 / 注销会话                              |
| `POST /api/password`                  | 修改本人密码，并使本人旧会话全部失效         |
| `GET /api/boot`                       | 当前角色可访问的业务快照与运行限制           |

就绪检查不会调用 OCR 或模型，不暴露数据目录、密钥、档案或账号列表。

## 业务接口

| 方法与路径                       | 用途                                           |
| -------------------------------- | ---------------------------------------------- |
| `POST /api/candidate`            | 创建或修订档案，重新计算完整度                 |
| `POST /api/job`                  | 创建岗位或发布新的不可变 JD 版本               |
| `POST /api/application`          | 维护岗位阶段、负责人和下一步                   |
| `POST /api/interview`            | 安排面试或填写本人可操作的反馈                 |
| `GET /api/detail/candidate/{id}` | 当前人才档案，按权限隐藏字段                   |
| `GET /api/detail/resume/{id}`    | 鉴权后的版本文本与证据                         |
| `GET /api/file/resume/{id}`      | 鉴权原件访问，记录审计                         |
| `POST /api/export`               | 按 ID 范围与当前角色生成导出数据               |
| `POST /api/metrics`              | 按队列、岗位、来源计算运营指标；导出需额外权限 |

## 导入与任务

`POST /api/upload` 接收来源和文件数组。每个文件包含 `name` 和 Base64 编码的 `base64`；服务器校验真实格式和体积后持久保存原件与导入项。

客户端可提供 UUID 格式 `requestId`。同一用户重复发送相同请求 ID 和内容会返回原任务，不重复建任务；同一 ID 改变内容返回 409。它与文件哈希去重不同：前者处理网络重试，后者用于 HR 的简历重复审查。

| 方法与路径                    | 用途                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `GET /api/detail/import/{id}` | 查看保存、解析、错误、字段及证据                                  |
| `POST /api/import/{id}`       | 携带 `rev` 和审查决定：create、link、skip、retry、reparse、manual |
| `GET /api/file/import/{id}`   | 读取该导入项保留的原件                                            |
| `POST /api/adopt`             | 明确采用已有简历版本的解析值，取消核实状态                        |
| `POST /api/jd-text`           | 本地提取 JD 原文供 HR 确认                                        |
| `POST /api/run`               | 固定输入范围和版本，创建后台匹配任务                              |
| `GET /api/detail/run/{id}`    | 查看输入快照、已完成项和失败项                                    |
| `POST /api/retry-run/{id}`    | 仅重试失败项，保留已有成功结果                                    |
| `POST /api/export-run`        | 按权限导出本次固定快照                                            |

导入状态包括 queued、running、review、duplicate、failed、done、skipped。匹配状态包括 queued、running、partial、failed、done。服务恢复时将运行中的任务重新排队；已完成匹配项不重算。评分规则升级后应创建新任务。

系统配置的 `extractionMode`（简历字段提取）、`mode`（岗位匹配评分）和 `ocr`（扫描件识别）相互独立。导入任务的 `parserMode` 为 `rules` 或 `model`，`modelWarning` 记录模型失败后保留规则结果的原因。模型字段的 evidence 包含 `method: "model"`、page、line、quote、raw 与 `confirmed: false`。所有值仍需人工核对，解析本身不会创建人才档案。`reparse` 仅适用于 review、duplicate、failed 状态，以当前配置重新排队；不修改已建档档案。`retry` 仍仅适用于 failed。新保存的简历版本保留解析字段，采用版本时沿用其字段与证据并取消核实状态；旧版本仍可使用规则提取。

## 管理接口

`POST /api/admin/user`、`POST /api/admin/config`、`POST /api/admin/model-test`、`GET /api/backup` 和 `POST /api/restore` 只允许管理员。模型测试接口接收当前表单的 `modelUrl` 与 `model`，发送不含简历内容的短提示，不保存配置；成功表示接口认证和一次聊天补全均正常。备份包含原件和账号密码哈希；恢复需要明确确认，并注销所有会话。业务记录及静态资源之外的服务器文件不对外公开。
