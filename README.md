<p align="center">
  <img src="public/assets/brand/mark.webp" alt="christmas-cards" width="120" />
</p>

<h1 align="center">Christmas Cards</h1>

<p align="center">
  3D 互动圣诞贺卡:挑一张纸雕卡片,写下祝福,贴贴纸、传一首歌,封上火漆印,生成链接寄给重要的人。
</p>

<p align="center">
  <a href="https://3dcards.theliang.com/">
    <img src="public/social-preview.jpg" alt="christmas-cards: 3D paper-cut Christmas cards fanned out on a table" width="720" />
  </a>
</p>

<p align="center">
  <a href="https://3dcards.theliang.com/"><img src="https://img.shields.io/badge/live-3dcards.theliang.com-111111" alt="Live" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm_Noncommercial_1.0.0-4c4c4c" alt="License" /></a>
</p>

> **源码许可 / Source terms:** 源码仅授权非商业学习、修改与分发;禁止商业使用、商业产品集成、广告和品牌项目。Source is available for noncommercial use only and is not OSI-approved open-source software. See [LICENSE](LICENSE).

## 在线体验 / Live

- 在线写一张贺卡:<https://3dcards.theliang.com>
- 建议桌面浏览器(Chrome / Edge / Firefox)打开,需要 WebGL2 与硬件加速
- 移动端可用,但 3D 编辑器在小屏上以底部工具栏布局呈现

## 功能

- **3D 纸雕卡片** —— 多层纸雕封面、翻盖弯曲、纸张浮雕与光影,全部实时渲染(Three.js)
- **卡片编辑器** —— 三段文字槽位、贴纸跨折页拖拽、撤销/重做、草稿自动保存
- **火漆信封** —— 长按盖印、拆信动画,把寄信这件事做出仪式感
- **音乐** —— 上传一首歌,收信人拆开信封时自动播放
- **定时送达** —— 选定送达日期,到期前信件内容对收信人保密
- **链接寄送** —— 一封信一个链接;发件箱(outbox)入口只有发件人持有
- **隐私友好的统计(可选)** —— Umami 经自家域名同源中转,不配置则完全不加载

## 技术栈

- Next.js 15(App Router)+ React 19 + TypeScript
- Three.js:自研纸张浮雕烘焙、弯曲与光影管线
- Tailwind CSS 4 + Radix UI / shadcn 组件
- Cloudflare Workers(OpenNext)+ D1(信件)+ R2(音频与页面缓存)
- Vitest 单元测试

## 本地 AI 制作 Skill（3d-card-master）

如果想在本地直接用 Claude Code / Codex 离线生成同等质感的 3D 纸雕互动贺卡，可以使用独立发布的 Skill 仓库：[**`dongliang1993/3d-card-master`**](https://github.com/dongliang1993/3d-card-master)（含离线 Three.js 渲染模板、冷压棉纸浮雕与烫金烘焙脚本、透明抠图脚本与完整使用示例）。

## 本地开发

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

本地开发时,信件存在 `data/letters.db`(SQLite),上传的音频存在 `data/uploads/`。

```bash
pnpm test         # vitest
```

## 部署

部署到 Cloudflare(Workers + D1 + R2),完整步骤见 [docs/deploy.md](docs/deploy.md)。
如果用 Cloudflare 的 Git 集成(连仓库、由 Cloudflare 构建),按 [DEPLOY.md](DEPLOY.md) 走。简版:

```bash
cp wrangler.jsonc.example wrangler.jsonc   # 填入你的 D1 database_id 和域名
pnpm db:migrate:remote
pnpm cf:deploy
```

## 配置

复制 `.env.example` 为 `.env.local`,以下均为可选:

| 变量                           | 说明                                     |
| ------------------------------ | ---------------------------------------- |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | Umami 站点 ID。留空则不注入任何统计脚本  |
| `NEXT_PUBLIC_TRACKED_DOMAIN`   | 只统计该域名的访问(本地与预览环境不计入) |

## 素材说明

- **卡片插画与贴纸**:AI 图像模型生成,经 `scripts/` 切分与浮雕烘焙后入库;原始大图(`assets-src/`)未入库。随项目以相同的非商业条款分享,不得单独商用
- **音效**:`scripts/sfx/paper_card.py` 程序化合成(与翻盖铰链的物理弹簧同步)
- **字体**:Inter、Caveat、Long Cang(Google Fonts,SIL OFL,构建时经 `next/font` 自托管)

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) —— 可自由用于学习、研究、修改与**非商业**再分发;**不允许商业用途**。所有副本与衍生作品必须保留 LICENSE 中的 `Required Notice`。

本站名称、品牌标识与卡片美术不授权用作其他产品的品牌标识。
