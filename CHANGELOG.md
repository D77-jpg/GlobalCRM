# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本控制（SemVer 2.0.0）](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- 持续优化全渠道收件箱自动化工作流与跨电脑协同升级体验
- GlobalSite 前端业务入口与 C4/C5 联调收尾

---

## [2.7.0] - 2026-11-23

面向团队内部本地化部署试运行的里程碑版本，汇集工作台升级、全渠道收件箱、自动化触达完整闭环、海关贸易数据、GlobalSite 完整集成协议及单业务独立拆分部署能力。

### Added
- **全渠道与 WhatsApp 工作台（PR #114 / #115）**：新增独立三栏全渠道收件箱，支持 WhatsApp（Meta Cloud API 接入及人工辅助模式）与阿里巴巴询盘邮件自动解析入池（迁移 `018`）。
- **AI 销售工作台升级（PR #114）**：集成项目政策护栏（Policy Guardrails）、三栏邮件副驾驶（Mail Copilot）、回复场景选择器、长邮件线程自动裁剪与引用清理、结构化 JSON 输出与评分拆解、双模式报价 / RFQ 工作台、客户看板与知识库问答（迁移 `017`）。
- **单业务拆分与本机部署工具链**：新增 `scripts/export-project-bundles.cjs`、`scripts/import-project-bundle.ps1`、`scripts/import-project-bundle.sh` 及自动化校验测试，支持将多项目集成环境按业务线安全拆分为独立本机数据包（自动重加密凭证、隔离附件与本地语义索引、零跨项目泄露校验），配套运维文档 `docs/operations/single-project-local-deploy.md`。
- **自动化开发信完整闭环与在线评测（PR #106–#112）**：补齐品牌行业包（Brand Package）导出/导入、灰度发布模式（Shadow / Pilot / Active）、`--use-crm-ai` 与 `--provider` 在线质量评测、AI 请求超时弹性与网站证据去重（迁移 `014`–`016`）。
- **海关贸易数据与归因（PR #91–#96）**：新增海关贸易数据导入、查询 UI、互动追踪、Provider 抽象与 AI 归因分析（迁移 `012`–`013`）。
- **GlobalSite C1–C5 集成能力（PR #83–#86）**：
  - C1 公开产品与资料只读接口
  - C2 自助式服务凭证管理与宽限期轮换
  - J1 / C3 幂等询盘写入、异步私有附件与待审回复草稿（迁移 `009`）
  - C4 HMAC-SHA256 签名 Webhook 事件推送与手动重发（迁移 `010`）
  - C5 OAuth2 + PKCE S256 / OIDC 身份提供端（迁移 `011`，Node `>= 22.12`）

### Changed
- **品牌与文档正式化**：全面升级 `README.md`，统一 `v2.7.0` 版本声明与 Node.js `>= 22.12.0` 环境要求，并建立 `CHANGELOG.md` 迭代记录体系。
- **邮件与客户时间线体验（PR #97–#105 / #113）**：支持从客户时间线直接打开已发送开发信与客户回复邮件、统一回复弹窗交互、规范签名中的 `&nbsp;` 防重复并保留品牌 Logo。
- **产品表格展示（PR #114）**：修复产品规格列溢出，新增产品缩略图与参考价展示。

### Fixed
- 修复 Nginx SPA 路由目录重定向及内部端口泄露问题（PR #110）。
- 修复 OpenAI Responses `createTurn` 请求中显式空 `tools` 数组丢失问题（PR #114）。
- 修复 `ops:verify-upgrade` 中 `schema_migrations` 校验方式（PR #109）。

---

## [2.6.0] - 2026-11-04

### Added
- 多项目工作空间隔离与默认组织架构（`Genesis Bags`、`IRONHUE`、`VELATURO`），按组织/项目两级租户隔离数据。
- Cookie + Double-Submit CSRF 会话模型、可选邮件 2FA、版本化 MongoDB 迁移与 Docker Compose 单机生产编排。
- 产品目录、阶梯报价核对、企业知识库本地 ONNX + `sqlite-vec` 语义检索与销售 Agent 工作区。

---

## [2.5.0] - 2026-10-16

### Added
- 邮件中心（IMAP/POP3 同步、SMTP 通道、邮件线程、开发信中英对照审校与发送合规）。
- 潜客搜索画像、公共池领取机制与基础自动化开发流程。

---

## [2.0.0] - 2026-09-24

### Added
- GlobalCRM 核心客户管理、开发信编辑器、跟进记录、报价管理与 Integration API v1 基础框架。
