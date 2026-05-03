# Excel Bulk Upload Design

Excel 在这个系统里只作为批量上传模板，不作为数据源。

## 核心原则

1. 系统数据源是应用自己的数据层。
   - 当前原型是 `data/shipping-lines.json`。
   - 正式上线建议迁移到 Postgres。

2. Excel 只是运营录入工具。
   - 用户下载空模板。
   - 填写后上传。
   - 系统解析、校验、预览差异。
   - 用户确认后才写入应用数据层。

3. 不允许“直接把 Excel 当数据库”。
   - 不能每次页面计算都读 Excel。
   - 不能依赖某个本地 Excel 路径启动系统。
   - 不能把微信临时文件路径作为构建前提。

## 模板生成

生成空模板：

```bash
npm run templates:excel
```

输出文件：

```text
templates/bulk-upload/express-line-bulk-upload-template.xlsx
```

这个文件没有业务数据，只包含 sheet、字段、说明和部分下拉校验。

## 推荐 Sheet 结构

### `shipping_lines`

维护船公司主数据。

字段：

- `shipping_line_id`
- `name`
- `enabled`
- `invoice_to_consignee_only`
- `invoice_note`
- `demurrage_cutoff_handler`

### `container_types`

维护柜型主数据。

字段：

- `container_type_key`
- `label`
- `module`
- `enabled`

### `tax_presets`

维护税率预设。

字段：

- `module`
- `tax_id`
- `label`
- `rate`

### `handover_local_charges`

维护换单 local charges。

字段：

- `shipping_line_id`
- `charge_id`
- `concept`
- `charge_scope`
- `container_type_key`
- `amount`
- `currency`
- `tax_rate`
- `note`

### `handover_guarantees`

维护押金 / 免押金规则。

字段：

- `shipping_line_id`
- `benefit_enabled`
- `benefit_expires_at`
- `container_type_key`
- `amount`
- `currency`
- `tax_rate`
- `note`

### `handover_demurrage`

维护换单 demoras 阶梯。

字段：

- `shipping_line_id`
- `container_type_key`
- `start_day`
- `end_day`
- `amount_per_day`
- `currency`
- `tax_rate`
- `note`

规则：

- `amount_per_day = 0` 表示免费天。
- 只有最后一段可以留空 `end_day`。
- 上传时必须校验区间连续、不重叠。

### `customs_ports_terminals`

维护港口和码头。

字段：

- `port_id`
- `port_name`
- `terminal_id`
- `terminal_name`
- `enabled`
- `note`

### `customs_yards`

维护场站，以及场站与港口、船公司的多对多关系。

字段：

- `yard_id`
- `yard_name`
- `port_id`
- `shipping_line_id`
- `enabled`
- `note`

规则：

- 一个场站对应多个港口时，使用多行。
- 一个场站对应多个船公司时，使用多行。
- 上传时按 `yard_id` 合并成同一个场站。

### `customs_terminal_fees`

维护码头固定费用。

字段：

- `port_id`
- `terminal_id`
- `fee_id`
- `concept`
- `container_type_key`
- `amount`
- `currency`
- `tax_rate`
- `note`

### `customs_storage_rules`

维护码头堆存阶梯。

字段：

- `port_id`
- `terminal_id`
- `container_type_key`
- `start_day`
- `end_day`
- `amount_per_day`
- `currency`
- `tax_rate`
- `note`

规则同 demurrage：

- `amount_per_day = 0` 表示免费天。
- 区间必须连续、不重叠。
- 只有最后一段可以留空 `end_day`。

### `customs_yard_fees`

维护落柜和清关场站费用。

字段：

- `yard_id`
- `fee_type`
- `fee_id`
- `concept`
- `container_type_key`
- `amount`
- `currency`
- `tax_rate`
- `note`

`fee_type` 取值：

- `dropoff`
- `customs`

## 推荐上传流程

1. 用户在后台下载模板。
2. 用户填写模板。
3. 用户上传 Excel。
4. 后端解析 workbook。
5. 后端做 dry-run 校验。
6. 页面展示校验结果：
   - 新增多少条
   - 修改多少条
   - 禁用多少条
   - 哪些行有错误
7. 用户确认导入。
8. 系统写入应用数据层。
9. 系统生成 audit log 和 import snapshot。

## 必须校验的内容

- 必填字段不能为空。
- ID / key 只能使用小写字母、数字、短横线。
- 引用必须存在，比如 `shipping_line_id`、`container_type_key`、`port_id`、`terminal_id`。
- 金额不能为负数。
- 税率不能为负数。
- 币种只能是 `MXN` 或 `USD`。
- 阶梯规则必须连续、不重叠。
- 只有最后一条阶梯可以没有 `end_day`。
- 多对多映射需要合并去重。

## 为什么不把 Excel 当数据源

Excel 适合批量录入，但不适合做系统数据源：

- 难做权限控制。
- 难做并发编辑。
- 难做审计和回滚。
- 难做引用完整性校验。
- 文件路径不稳定，尤其是微信临时目录。
- 部署到 Railway / Vercel 这类平台时，本地 Excel 文件不可依赖。

因此正确结构是：

```text
Excel 模板 -> 上传 -> 校验 -> 预览 -> 确认 -> 应用数据层
```

不是：

```text
Excel 文件 -> 页面计算时直接读取
```
