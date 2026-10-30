# 配置参考

返回 [README](../README.md) · [部署与运维](OPERATIONS.md)

## 进程配置与业务配置

进程配置来自环境变量，由 `Settings` 在启动时统一校验；无效端口、数值范围或主机格式会导致启动失败，并给出错误。`--host`、`--port` 参数优先于对应环境变量。

模型模式、接口地址、模型名及 OCR 开关是管理员维护的业务配置，保存在工作区数据库中。匹配任务会固定当时的业务配置，后续修改不改变旧结果。

## 环境变量

| 变量                             | 默认值                            | 范围及说明                                                  |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `TALENT_DATA_DIR`                | 用户本地 `TalentHub/workspace-v2` | 业务数据路径；空字符串使用默认值                            |
| `TALENT_HOST`                    | `127.0.0.1`                       | 监听地址；内网部署可用 `0.0.0.0`                            |
| `TALENT_PORT`                    | `4173`                            | 1–65535；命令行参数优先                                     |
| `TALENT_ALLOWED_HOSTS`           | 无额外主机                        | 逗号分隔主机名 / IP，不带协议、端口或路径；始终允许回环主机 |
| `TALENT_SECURE_COOKIE`           | `0`                               | `1` 表示 Cookie 只通过 HTTPS 发送；本机 HTTP 保持 `0`       |
| `TALENT_SESSION_HOURS`           | `8`                               | 1–24，登录会话有效小时数                                    |
| `TALENT_MAX_UPLOAD_MIB`          | `20`                              | 1–100，单份文件上限                                         |
| `TALENT_MAX_REQUEST_MIB`         | `80`                              | 1–512，JSON 请求体上限；需考虑 Base64 约 4/3 的体积增幅     |
| `TALENT_MAX_BATCH_FILES`         | `50`                              | 1–100，每批文件数量上限；界面逐份保存                       |
| `TALENT_REQUEST_TIMEOUT_SECONDS` | `30`                              | 1–300，HTTP 连接读写超时                                    |
| `TALENT_MODEL_TIMEOUT_SECONDS`   | `120`                             | 1–300，单次模型请求超时                                     |
| `TALENT_MODEL_API_KEY`           | 空                                | 可选的本地模型认证密钥；不放入业务配置或备份                |
| `TALENT_OCR_LANG`                | `chi_sim+eng`                     | Linux Tesseract 语言数据名称                                |

Python 入口**不会自动加载 `.env`**。可复制根目录 [.env.example](../.env.example) 作为部署清单，但原生启动时仍需由 shell、服务管理器或密钥管理系统设置变量。

## 原生启动示例

PowerShell：

```powershell
$env:TALENT_DATA_DIR = 'D:\TalentHubData'
$env:TALENT_ALLOWED_HOSTS = 'talent.internal'
$env:TALENT_MAX_UPLOAD_MIB = '30'
.venv\Scripts\python.exe server.py --host 0.0.0.0 --port 4173
```

Linux：

```bash
export TALENT_DATA_DIR=/srv/talent-hub/data
export TALENT_ALLOWED_HOSTS=talent.internal
.venv/bin/python server.py --host 0.0.0.0 --port 4173
```

`talent.internal` 只是需要替换的部署主机名，必须由部署方配置 DNS / hosts 解析。不要在数据目录中运行多个应用实例。

## Docker 配置

Compose 从项目 `.env` 读取插值，并只将 [compose.yaml](../compose.yaml) 中明确列出的变量传入容器。复制 `.env.example` 后可按需要修改。容器内部固定监听 4173，`TALENT_PORT` 控制宿主机映射端口；`TALENT_DATA_DIR` 在容器中固定为 `/data`，由具名卷持久化。

容器回环地址指容器本身。本地模型应与应用共享网络命名空间；宿主机模型需要使用原生 Python 部署，或先设计并审查受控网络适配，不通过关闭地址校验来访问任意外部服务。

## 本地模型配置

管理员在设置中选择本地模型模式，填写已部署的模型名及 `http://127.0.0.1:11434/v1` 这类 OpenAI 兼容地址。localhost 和 `::1` 也可使用；外部地址和 HTTP 重定向被拒绝。

接口应返回逐条件的 JSON 数组。字段缺失、条件重复、无效状态或分数会使该候选人处理失败，保留其他成功结果。原文引用由程序核对；没有依据的条件保持未知。更多规则见[产品设计](PRODUCT_DESIGN.md#匹配契约)。

只有配置真实本机模型后才会发起本机推理请求；默认的证据规则模式不依赖模型服务。
