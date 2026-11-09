# 海关数据字典

**状态：** 设计基线
**关联方案：** `docs/customs-data-plan.md`
**最后更新：** 2026-11-09

## 1. 通用约定

- 所有业务集合都包含 `organizationId` 和 `projectId`。
- 所有时间使用 UTC 存储，页面按项目时区显示。
- 金额统一保留原币种，同时保存 `amountUsd` 便于跨国家比较。
- 重量统一保存原单位和公斤值。
- 国家使用 ISO 3166-1 alpha-2。
- HS Code 统一保存 6 位标准码，原始 8 位或 10 位码保存在 `hsCodeRaw`。
- 所有外部记录使用 `(projectId, sourceId, sourceRecordId)` 唯一键。
- 删除采用软删除或状态标记，不物理删除已关联记录。

## 2. customs_sources

数据源配置和同步状态。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键 |
| `organizationId` | ObjectId | 组织 |
| `projectId` | ObjectId | 项目 |
| `name` | string | 数据源名称 |
| `provider` | string | 供应商标识 |
| `kind` | enum | `api`、`csv`、`object_storage` |
| `status` | enum | `active`、`paused`、`error`、`disabled` |
| `credentialsEncrypted` | string | 加密后的凭证 |
| `coverageCountries` | string[] | 覆盖国家 ISO 码 |
| `fieldMapping` | object | 供应商字段映射 |
| `syncCursor` | string | 增量同步游标 |
| `lastSyncAt` | Date | 最后同步时间 |
| `lastSuccessAt` | Date | 最后成功时间 |
| `lastError` | string | 最后错误 |
| `createdBy` | ObjectId | 创建人 |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

索引：

- `(projectId, provider)` 唯一
- `(projectId, status)`

## 3. customs_source_coverage

国家覆盖矩阵。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sourceId` | ObjectId | 数据源 |
| `country` | string | ISO 国家码 |
| `status` | enum | `full`、`partial`、`aggregate`、`unavailable` |
| `fields` | string[] | 可用字段 |
| `updateFrequency` | enum | `daily`、`weekly`、`monthly` |
| `lagDays` | number | 典型延迟天数 |
| `licenseScope` | string[] | 授权用途 |
| `lastVerifiedAt` | Date | 最后验证时间 |

索引：

- `(projectId, sourceId, country)` 唯一

## 4. customs_companies

标准化公司主数据。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `canonicalName` | string | 标准公司名 |
| `normalizedName` | string | 去后缀、去标点后的匹配名 |
| `country` | string | 国家 |
| `address` | string | 地址 |
| `domain` | string | 官网域名 |
| `vat` | string | VAT |
| `eori` | string | EORI |
| `registrationNo` | string | 当地注册号 |
| `companyType` | enum | `importer`、`exporter`、`both`、`unknown` |
| `sourceIds` | ObjectId[] | 来源 |
| `aliases` | string[] | 别名 |
| `firstSeenAt` | Date | 首次出现 |
| `lastSeenAt` | Date | 最后出现 |
| `shipmentCount` | number | 记录数缓存 |
| `totalAmountUsd` | number | 金额缓存 |
| `status` | enum | `active`、`merged`、`ignored` |
| `mergedIntoId` | ObjectId | 合并目标 |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

索引：

- `(projectId, normalizedName, country)` 普通索引
- `(projectId, domain)` 普通索引
- `(projectId, vat)` 普通索引
- `(projectId, eori)` 普通索引
- `(projectId, status, lastSeenAt)`

## 5. customs_company_aliases

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `companyId` | ObjectId | 公司 |
| `alias` | string | 原始名称 |
| `normalizedAlias` | string | 标准化名称 |
| `sourceId` | ObjectId | 来源 |
| `country` | string | 国家 |
| `createdAt` | Date | 创建时间 |

索引：

- `(projectId, normalizedAlias, country)`
- `(projectId, companyId)`

## 6. customs_shipments

每票海关或提单记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sourceId` | ObjectId | 来源 |
| `sourceRecordId` | string | 来源记录 ID |
| `importerCompanyId` | ObjectId | 进口商 |
| `exporterCompanyId` | ObjectId | 出口商 |
| `importerNameRaw` | string | 原始进口商名 |
| `exporterNameRaw` | string | 原始出口商名 |
| `importerCountry` | string | 进口国 |
| `exporterCountry` | string | 出口国 |
| `hsCode` | string | 6 位 HS |
| `hsCodeRaw` | string | 原始 HS |
| `productDescription` | string | 产品描述 |
| `quantity` | number | 数量 |
| `quantityUnit` | string | 单位 |
| `weightKg` | number | 公斤 |
| `amount` | number | 原币金额 |
| `currency` | string | 币种 |
| `amountUsd` | number | 美元金额 |
| `shipmentDate` | Date | 发货日期 |
| `arrivalDate` | Date | 到港日期 |
| `portOfLoading` | string | 起运港 |
| `portOfDischarge` | string | 目的港 |
| `transportMode` | string | 运输方式 |
| `billOfLading` | string | 提单号 |
| `dataDate` | Date | 数据日期 |
| `raw` | object | 原始字段快照 |
| `fingerprint` | string | 去重指纹 |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

索引：

- `(projectId, sourceId, sourceRecordId)` 唯一
- `(projectId, importerCompanyId, shipmentDate)`
- `(projectId, exporterCompanyId, shipmentDate)`
- `(projectId, hsCode, shipmentDate)`
- `(projectId, fingerprint)`
- `(projectId, dataDate)`

文本索引：

- `productDescription`
- `importerNameRaw`
- `exporterNameRaw`

## 7. customs_company_profiles

公司聚合画像，可重算。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `companyId` | ObjectId | 公司 |
| `period` | string | `YYYY-MM` |
| `shipmentCount` | number | 票数 |
| `amountUsd` | number | 金额 |
| `weightKg` | number | 重量 |
| `topHsCodes` | object[] | HS 占比 |
| `topSuppliers` | object[] | 供应商及占比 |
| `topDestinations` | object[] | 目的地 |
| `updatedAt` | Date | 更新时间 |

索引：

- `(projectId, companyId, period)` 唯一

## 8. customs_matches

海关公司与 CRM 实体的匹配关系。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `companyId` | ObjectId | 海关公司 |
| `crmType` | enum | `customer`、`prospect` |
| `crmId` | ObjectId | CRM 实体 |
| `method` | enum | `domain`、`vat`、`eori`、`name_country`、`address`、`fuzzy`、`manual` |
| `confidence` | number | 0 到 1 |
| `evidence` | string[] | 匹配证据 |
| `status` | enum | `suggested`、`confirmed`、`rejected` |
| `confirmedBy` | ObjectId | 确认人 |
| `confirmedAt` | Date | 确认时间 |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

索引：

- `(projectId, companyId, crmType, crmId)` 唯一
- `(projectId, crmType, crmId, status)`

## 9. customs_watches

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `watchType` | enum | `company`、`customer`、`market` |
| `companyId` | ObjectId | 公司 |
| `customerId` | ObjectId | 客户 |
| `country` | string | 市场国家 |
| `hsCode` | string | HS |
| `rules` | object | 预警规则 |
| `enabled` | boolean | 是否启用 |
| `createdBy` | ObjectId | 创建人 |

索引：

- `(projectId, watchType, enabled)`
- `(projectId, customerId)`

## 10. customs_alerts

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `watchId` | ObjectId | 监控 |
| `companyId` | ObjectId | 公司 |
| `customerId` | ObjectId | 客户 |
| `type` | enum | `new_shipment`、`new_buyer`、`supplier_change`、`volume_drop`、`new_product` |
| `severity` | enum | `info`、`warning`、`critical` |
| `title` | string | 标题 |
| `summary` | string | 摘要 |
| `evidence` | object[] | 关联记录 |
| `status` | enum | `unread`、`read`、`dismissed`、`converted` |
| `createdAt` | Date | 创建时间 |

索引：

- `(projectId, status, createdAt)`
- `(projectId, customerId, createdAt)`

## 11. customs_scores

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `companyId` | ObjectId | 公司 |
| `customerId` | ObjectId | 可选客户 |
| `score` | number | 0 到 100 |
| `reasons` | object[] | 分数解释 |
| `calculatedAt` | Date | 计算时间 |
| `version` | number | 评分版本 |

索引：

- `(projectId, companyId, calculatedAt)`
- `(projectId, customerId, calculatedAt)`

## 12. customs_usage

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `metric` | enum | `search`、`company_view`、`export`、`record_ingested` |
| `quantity` | number | 用量 |
| `sourceId` | ObjectId | 来源 |
| `userId` | ObjectId | 用户 |
| `metadata` | object | 查询条件摘要，不含敏感内容 |
| `createdAt` | Date | 时间 |

索引：

- `(projectId, metric, createdAt)`
- `(projectId, userId, createdAt)`

## 13. customs_sync_jobs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sourceId` | ObjectId | 来源 |
| `mode` | enum | `full`、`incremental`、`csv` |
| `status` | enum | `queued`、`running`、`succeeded`、`failed`、`cancelled` |
| `cursorBefore` | string | 开始游标 |
| `cursorAfter` | string | 结束游标 |
| `recordsRead` | number | 读取数 |
| `recordsWritten` | number | 写入数 |
| `recordsSkipped` | number | 跳过数 |
| `error` | string | 错误 |
| `startedAt` | Date | 开始时间 |
| `finishedAt` | Date | 结束时间 |
| `createdBy` | ObjectId | 创建人 |

索引：

- `(projectId, sourceId, createdAt)`
- `(projectId, status, createdAt)`

## 14. 现有模型扩展

### Product

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hsCode` | string | 6 位 HS |
| `hsCodeRaw` | string | 原始编码 |
| `hsCodeSource` | enum | `manual`、`ai`、`import` |
| `customsKeywords` | string[] | 搜索关键词 |

### Prospect

- `source` 增加 `customs`
- `customsCompanyId` ObjectId
- `customsMatchConfidence` number

### Customer

- `customsCompanyId` ObjectId
- `customsMatchConfidence` number
- `customsMatchedAt` Date

### CustomerEvent

新增事件类型：

- `customs_activity`
- `customs_alert`

## 15. 数据保留和删除

- 原始供应商文件按合同保留。
- 标准化记录在客户删除后保留匿名聚合，或按合同删除。
- 客户与海关公司的匹配关系随客户软删除。
- 导出文件不长期保存。
- 真实数据不进入测试 fixture。
