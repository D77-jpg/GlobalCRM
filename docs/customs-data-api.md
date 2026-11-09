# 海关数据接口清单

**状态：** 设计基线
**前缀：** `/api/customs`
**认证：** CRM 用户会话，和现有业务接口一致
**关联文档：** `docs/customs-data-plan.md`、`docs/customs-data-dictionary.md`

## 1. 通用约定

- 所有接口要求登录和当前项目头。
- 所有接口同时校验组织和项目。
- 分页参数使用 `page`、`limit`。
- 排序参数使用 `sortBy`、`sortOrder`。
- 写操作返回 200 或 201。
- 同步任务返回 202。
- 错误响应沿用现有 `ApiError` 结构。
- 原始海关数据不进入日志和错误详情。

## 2. 搜索和公司档案

### GET `/api/customs/search`

搜索海关记录。

查询参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `q` | string | 公司、产品、提单号 |
| `hsCode` | string | HS Code |
| `importerCountry` | string | 进口国 |
| `exporterCountry` | string | 出口国 |
| `importerName` | string | 进口商 |
| `exporterName` | string | 出口商 |
| `dateFrom` | date | 开始日期 |
| `dateTo` | date | 结束日期 |
| `minAmountUsd` | number | 最小金额 |
| `maxAmountUsd` | number | 最大金额 |
| `port` | string | 港口 |
| `sourceId` | ObjectId | 数据源 |
| `page` | number | 页码 |
| `limit` | number | 每页数量，最大 100 |
| `sortBy` | enum | `shipmentDate`、`amountUsd`、`importerName` |
| `sortOrder` | enum | `asc`、`desc` |

响应：

```json
{
  "success": true,
  "data": {
    "items": [],
    "total": 0,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

### GET `/api/customs/companies`

按公司维度搜索。

参数：

- `q`
- `country`
- `companyType`
- `hsCode`
- `dateFrom`
- `dateTo`
- `minShipments`
- `minAmountUsd`
- `page`
- `limit`

### GET `/api/customs/companies/:id`

公司 360。

响应包含：

```json
{
  "company": {},
  "summary": {
    "shipmentCount": 0,
    "amountUsd": 0,
    "weightKg": 0,
    "firstShipmentAt": null,
    "lastShipmentAt": null
  },
  "trend": [],
  "topHsCodes": [],
  "topSuppliers": [],
  "topDestinations": [],
  "recentShipments": [],
  "matches": [],
  "watch": null,
  "dataSources": []
}
```

### GET `/api/customs/companies/:id/shipments`

公司发货记录，支持日期、HS、金额和分页。

### GET `/api/customs/companies/:id/insights`

公司画像和趋势聚合。

### POST `/api/customs/companies/:id/convert`

把海关公司转为潜客。

请求：

```json
{
  "ownerId": "可选，业务员 ID",
  "tags": ["可选标签"],
  "notes": "可选备注"
}
```

行为：

- 校验项目权限。
- 如果已有匹配的潜客或客户，返回已有记录，不重复创建。
- 创建 `Prospect`，`source` 为 `customs`。
- 保存 `customsCompanyId`。
- 写审计日志。

### POST `/api/customs/companies/:id/match`

人工确认或拒绝客户匹配。

请求：

```json
{
  "crmType": "customer",
  "crmId": "客户 ID",
  "decision": "confirm",
  "note": "可选说明"
}
```

## 3. 客户贸易动态

### GET `/api/customs/customers/:id/trade`

客户详情贸易动态。

响应：

```json
{
  "company": {},
  "summary": {},
  "trend": [],
  "topProducts": [],
  "suppliers": [],
  "recentShipments": [],
  "alerts": []
}
```

### POST `/api/customs/customers/:id/watch`

开启客户贸易监控。

### DELETE `/api/customs/customers/:id/watch`

关闭客户贸易监控。

### GET `/api/customs/customers/:id/suggestions`

基于贸易记录生成跟进建议。

响应中的每条建议必须包含：

- 建议内容
- 依据记录 ID
- 数据日期
- 置信度
- 是否由 AI 生成

### GET `/api/customs/companies/:id/score`

返回公司贸易匹配评分和评分依据。

## 4. 监控和预警

### GET `/api/customs/watchlists`

当前项目的监控列表。

### POST `/api/customs/watchlists`

创建监控。

请求：

```json
{
  "watchType": "company",
  "companyId": "公司 ID",
  "rules": {
    "newShipment": true,
    "supplierChange": true,
    "volumeDropPercent": 30
  }
}
```

### PATCH `/api/customs/watchlists/:id`

修改监控规则或启用状态。

### DELETE `/api/customs/watchlists/:id`

删除监控。

### GET `/api/customs/alerts`

预警列表，支持状态、类型、客户和分页。

### PATCH `/api/customs/alerts/:id`

标记已读、忽略或转为待办。

### GET `/api/customs/attribution`

管理员查看海关来源线索、客户、报价和成交的归因汇总。

## 5. 数据源和同步

以下接口仅管理员可用。

### GET `/api/customs/sources`

数据源列表，不返回凭证。

### POST `/api/customs/sources`

创建数据源。

请求：

```json
{
  "name": "Primary US provider",
  "provider": "provider_key",
  "kind": "api",
  "coverageCountries": ["US", "DE", "FR"],
  "credentials": {}
}
```

凭证只在服务端加密保存，响应不回显。

### PATCH `/api/customs/sources/:id`

修改配置、状态或字段映射。

### POST `/api/customs/sources/:id/test`

测试连接。

### POST `/api/customs/sources/:id/sync`

触发全量或增量同步。

请求：

```json
{
  "mode": "incremental"
}
```

响应 202：

```json
{
  "jobId": "..."
}
```

### GET `/api/customs/sync-jobs`

同步任务列表。

### GET `/api/customs/sync-jobs/:id`

同步任务详情、进度和错误。

### POST `/api/customs/import`

CSV 或 JSON 导入。管理员可用。

请求：

```json
{
  "sourceId": "数据源 ID",
  "rows": [],
  "dryRun": false
}
```

响应：

```json
{
  "read": 0,
  "written": 0,
  "skipped": 0,
  "errors": []
}
```

### GET `/api/customs/coverage`

数据源国家覆盖矩阵。

## 6. 用量和权限

### GET `/api/customs/usage`

当前项目用量。

响应：

```json
{
  "period": "2026-11",
  "search": 0,
  "companyView": 0,
  "export": 0,
  "recordIngested": 0,
  "limits": {}
}
```

### GET `/api/customs/entitlements`

当前项目套餐能力。

## 7. 权限矩阵

| 能力 | 管理员 | 业务员 | 只读 |
| --- | --- | --- | --- |
| 搜索公司 | 是 | 是 | 是 |
| 查看公司 360 | 是 | 是 | 是 |
| 转潜客 | 是 | 是 | 否 |
| 查看客户贸易动态 | 是 | 是 | 是 |
| 创建监控 | 是 | 是 | 否 |
| 查看预警 | 是 | 是 | 是 |
| 配置数据源 | 是 | 否 | 否 |
| 触发同步 | 是 | 否 | 否 |
| 原始导出 | 是 | 默认否 | 否 |
| 查看用量 | 是 | 否 | 否 |

## 8. 错误码

沿用现有错误码，补充业务错误信息：

- `CUSTOMS_SOURCE_NOT_FOUND`
- `CUSTOMS_SOURCE_DISABLED`
- `CUSTOMS_COVERAGE_UNAVAILABLE`
- `CUSTOMS_IMPORT_INVALID`
- `CUSTOMS_MATCH_AMBIGUOUS`
- `CUSTOMS_ENTITLEMENT_EXCEEDED`

新增错误码需要在 `ApiError` 中登记，并同步前端提示。

## 9. 实施顺序

1. 搜索、公司 360 和客户贸易动态。
2. 转潜客和客户匹配。
3. 监控和预警。
4. 数据源配置、同步和导入。
5. 用量和套餐。
6. AI 建议。
