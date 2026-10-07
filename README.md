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
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移；v3 起带同步基线表与分批回滚日志 |

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
        ├── types/{specimen,procedure,supply,photo,sync}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,SyncCenter,CompareView}.tsx
        └── utils/{db,unitConvert,id,hash}.ts + utils/sync/{merge,packet}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，序号跳号报错 | PrepProcedure、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/sync` | 离线合并：留痕包分批导出 / 回包三方合并 / 失败回滚 / 两版待核核定 | 全部四张表 + syncState、syncJournal |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 六张表：`specimens`（标本）、`procedures`（修复工序，含修订号 `rev` 与两版待核字段）、`supplies`（工具材料批次 + 领用记录）、`photos`（修复影像 dataUrl 独立表）、`syncState`（最近合并基线 / 本机工序改动时间）、`syncJournal`（分批写入回滚日志）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：工序新增 `rev / updatedAt / conflictId / conflictSide / conflictOtherRev`；**旧数据无修订号，升级时按当前值回填 `rev=1`、`updatedAt=startedAt`**；新增 `conflictId` 索引与两张同步表。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、4 个材料批次与 2 张留痕影像，便于直接查看。

## 离线留痕包与回馆合并（合作修复室往返）

标本送合作修复室处理后，通过顶部「离线合并」页（`/sync`）完成出包与回包合并，全程不依赖网络。

- **导出（出馆）**：把四张业务表打成 JSON 留痕包；整包超容量时按可选上限（1–16 MB/卷）**自动分批写入**多个分卷文件，每卷带稳定序列化后的 sha-256 校验和（非安全上下文回退 FNV-1a）。未定稿的「两版待核」合作室行不导出。
- **回包校验**：导入时多选同一批次全部分卷，逐卷验校验和、检查批次一致、卷号连续无重复、无缺卷；任一不过整包不入库。
- **三方合并规则**（基线取上次成功合并的快照）：
  - 只有一边新改的记录**直接并入**；馆内单边新改自然保留。
  - **两边都动过的工序留两版**（馆内版 / 合作室版，共享 `conflictId`），不互相覆盖，在「待核修订」里逐字段核对后可核定一版；核定后输方行删除，其独有影像按拍摄时间并入定稿。
  - **影像按拍摄时间与阶段（before/after/process）归到工序修订上**；同 id 或内容指纹重复的影像**只留一条**，工序拆分待核时影像自动改挂到修订行。
  - 材料标量字段取较新版本，领用明细按 id 求并集，**材料余量**在馆内当前余量上扣减合作室新登记领用，夹断在 0。
  - 标本双边改动时保留馆内版并在报告中提示人工核对。
- **合并后联动重算**：完成度按「核定行 + 每个待核组馆内版」口径重算（待核处给出提示，不重复计数）；材料台账余量刷新；前后对照页节点列表、完成度与导出的对照说明文本同步重算，并标注待核数量。
- **旧包失效**：本机任何工序增删改（含完成 / 回退 / 待核核定）都会刷新本机工序改动时间；导出时间早于它的留痕包判定为旧包，**不得直接覆盖本机工序**，差异一律转为两版待核并在预览中警告。
- **分批写入与回滚**：合并方案先预览再提交；写入按体积/行数分批，每批先在同事务登记 `syncJournal`（含受影响行原值）再落库。任一批失败自动按日志反向恢复全部已写批次并清空日志，修正后可**重新导入**；页面顶部也会列出残留批次供一键回滚。
- **修订号**：工序每次本机业务改动 `rev += 1`；单边并入取双侧较大值 +1，待核定稿再 +1。待核列表显示双侧 rev 与差异字段。

### 冒烟测试

离线合并引擎有一组基于 `fake-indexeddb` 的端到端测试（Node 运行，不需浏览器）：

```bash
cd frontend
npm run test:smoke
```

覆盖单边并入、双边留两版、影像归并去重、完成度 / 材料余量重算、旧包失效、多卷分卷与校验、分批写入失败回滚重导、待核核定与缺修订号回填等场景。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
