# 部署到 Cloudflare（Git 集成版）

这份说明对应"Cloudflare 直接连 GitHub 仓库、由 Cloudflare 自己构建部署"的方式。
上游的 `docs/deploy.md` 是本地用 wrangler 部署的流程，两条路最终产物相同。

## 1. 先建好三样东西

Cloudflare Dashboard → 左侧菜单：

| 资源 | 类型 | 名字 |
| --- | --- | --- |
| 贺卡数据库 | D1 SQL Database | `christmas-letters` |
| 音乐存储 | R2 bucket（私有） | `christmas-letters-audio` |
| 页面缓存 | R2 bucket（私有） | `christmas-letters-cache` |

建好 D1 后点进去，复制它的 **Database ID**，填到 `wrangler.jsonc` 里
`"database_id"` 那一行（现在是 `replace-with-your-d1-database-id`）。

R2 如果提示要先启用，跟着走完即可；两个桶都不要开 Public access。

## 2. 把表结构推进线上数据库

仓库里的 `migrations/0001_letters.sql` 是建表语句。两种推法，任选其一：

- Dashboard 打开该 D1 → **Console**，把 `migrations/0001_letters.sql` 的内容整段粘贴执行；
- 或者本地执行（需要 `wrangler login` 能通）：
  ```bash
  pnpm db:migrate:remote
  ```

## 3. 在 Cloudflare 里连仓库

Workers & Pages → **Create** → **Workers** → **Connect to Git** → 选
`lileikesi-del/MYWAREHOUSE`，然后在构建设置里填：

| 设置项 | 值 |
| --- | --- |
| Build command | `npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Node version | 22（仓库里有 `.nvmrc`，通常会自动读到） |

`wrangler.jsonc` 里已经声明了 D1 与两个 R2 的绑定，Cloudflare 构建时会按名字自动挂上，
不需要在 Dashboard 里手动加绑定 —— 前提是第 1 步的资源名字完全一致。

## 4. 部署

保存后 Cloudflare 会拉代码、装依赖、构建、部署。之后每次推送 `main` 都会自动重新部署。

第一次构建大概 3–6 分钟。构建日志里如果看到 `Couldn't find a D1 DB with the name or binding`，
就是第 1 步的名字对不上，或者 `database_id` 还没填。

## 5. 访问地址

部署成功后在 Worker 的详情页能看到 `https://christmas-letters.<你的账号>.workers.dev`。

这个地址在部分网络（尤其微信内）可能打不开。以后有了自己的域名，在 `wrangler.jsonc` 里加回：

```jsonc
"routes": [{ "pattern": "cards.你的域名.com", "custom_domain": true }]
```

再推一次即可，Cloudflare 会自动建 DNS 记录和证书。域名所在的 zone 必须在同一个账号下。

> 贺卡链接里的域名取自发信人打开页面时的地址，所以加域名后要在新域名下重新写信，
> 旧链接仍然指向 `workers.dev`。
