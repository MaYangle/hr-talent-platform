# 第三方依赖与来源

本项目源码使用 [MIT License](LICENSE)。以下依赖不因本项目许可而改变其原有条款。运行依赖的固定版本见 [requirements.txt](requirements.txt)，开发依赖见 [requirements-dev.txt](requirements-dev.txt) 与 [package-lock.json](package-lock.json)。

## 运行依赖

| 项目                                                             | 用途                    | 许可 / 通知                                 |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| [python-docx](https://github.com/python-openxml/python-docx)     | DOCX 段落与表格提取     | MIT                                         |
| [pypdf](https://github.com/py-pdf/pypdf)                         | PDF 文字层提取          | BSD-3-Clause                                |
| [pypdfium2](https://github.com/pypdfium2-team/pypdfium2)         | 扫描 PDF 本地渲染       | Apache-2.0 / BSD-3-Clause；另含 PDFium 通知 |
| [Pillow](https://github.com/python-pillow/Pillow)                | OCR 图像处理            | MIT-CMU 及附带通知                          |
| [lxml](https://github.com/lxml/lxml)                             | python-docx XML 处理    | BSD-3-Clause；其二进制依赖保留相应许可      |
| [typing_extensions](https://github.com/python/typing_extensions) | 依赖的类型兼容支持      | PSF-2.0                                     |
| [SQLite](https://www.sqlite.org/copyright.html)                  | Python 自带的事务数据库 | Public Domain                               |

已保留的依赖许可副本位于 [licenses/](licenses/)。本仓库不分发 Python 解释器、wheel 或操作系统 OCR 组件；安装包中的完整许可证及其第三方通知仍应保留。

Windows OCR 使用系统 Windows.Media.Ocr。Linux / Docker 使用 Tesseract（Apache-2.0）和对应语言数据，其许可随系统包分发。

## 开发工具

- Ruff：MIT。
- Prettier：MIT。
- Playwright：Apache-2.0；浏览器二进制有各自的许可证。

这些工具不作为浏览器运行时依赖。

## 业务与视觉来源

界面风格基于项目需求方提供的原始设计材料演进。候选人、岗位、面试和证据匹配的业务结构参考过 OpenRecruitOS 与 AI Resume Screener ATS Platform；未复制或拼接这些项目的服务端代码。

旧浏览器原型使用过的 PDF.js、Mammoth、Fuse.js、idb-keyval 已从当前运行源码移除，不作为现版本依赖。
