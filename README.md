# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号、修订号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView,SyncCenter}.tsx
        └── utils/{db,unitConvert,id,hash,offlineMerge,tracePacket}.ts
```

合并逻辑有两组 Node 断言脚本（不依赖浏览器，用 esbuild 打包后直接跑）：

```bash
cd frontend
npx esbuild scripts/test-merge.mts    --bundle --platform=node --format=esm --outfile=/tmp/t1.mjs && node /tmp/t1.mjs
npx esbuild scripts/test-rollback.mts --bundle --platform=node --format=esm --outfile=/tmp/t2.mjs && node /tmp/t2.mjs
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，序号跳号报错 | PrepProcedure、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |
| `/sync` | 离线留痕包导出/导入、三方合并、两版待核裁决、重算结果回显 | 全部四表 |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 领用记录）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：为四类记录补齐离线合并所需的 `rev`（修订号）、`updatedAt`，工序新增 `conflicts`（两版待核），影像新增 `contentHash`（内容指纹）。**旧数据无修订号，升级时按当前值回填 `rev=1`**；旧留痕包导入时同样回填。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、4 个材料批次与 2 张留痕影像，便于直接查看。

## 离线留痕合并（合作修复室回馆）

「离线合并」页（路由 `/sync`）处理修复室送回的留痕包，规则：

- **单边新改直接并入**：按修订号比对，只有一方相对共同版本有改动时，取高修订号版本整版并入。
- **两边都动过留两版待核**：同一工序双方修订号相同但内容不一致（即分叉）时，主记录暂留本机版并在 `conflicts` 内挂「本机版 / 留痕包版」两版快照，时间线上标「N 版待核」；在合并页逐条「核定采用」后自增修订号定稿。
- **影像归挂与去重**：影像按拍摄时间（工序开始/结束窗口）与 `stage` 归到对应工序修订（前/中/后），重新挂接后同步工序的 `photoBeforeIds/AfterIds`；同标本 + 同拍摄时间 + 同内容指纹的重复影像只保留一条。
- **合并后重算**：完成度（done/total/percent）、材料余量（在库/累计领用/低量）与每标本的对照说明随合并结果重算，页面表格与「前后对照」页即时反映。
- **旧包失效**：本机工序一旦改动（新增/完成/回退/裁决），写入 `dirty-since` 标记；导出时间早于该标记的留痕包会被拒绝，需让修复室基于最新留痕重新导出。
- **分批写入**：包体超过单包容量（默认约 8 MB JSON）自动拆成分片（文件名含 `part1ofN`），导入时同批分片需一次选齐，缺片/混批/坏标识都会被拦下。
- **失败回滚重导**：合并在单个 Dexie 读写事务内完成，任一步失败四张表整体回滚到导入前状态，修正后可重新导入；同一批次重导按修订号与影像指纹幂等对账。
- 留痕包为 JSON 文件，头含 `magic=gbfossilprep/trace-packet`、`packetVersion`、`batchId`、`partIndex/partCount`、`schemaVersion`。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
