# 部署到阿里云 ECS（大陆节点）

目标是让**国内不翻墙也能打开**。Cloudflare 的 `*.workers.dev` 在国内被阻断，所以这张贺卡改成跑在自己的服务器上：Next.js 用 `next start` 启动，贺卡数据存本机 SQLite，音乐存本机目录，不依赖 Cloudflare 的 D1 / R2。

## 一、买什么

| 项目 | 选择 |
|---|---|
| 产品 | ECS 云服务器（学生认证后有优惠套餐 / 免费试用额度，以后台实际价格为准） |
| 地域 | 离你和朋友近的：华北2（北京）、华东1（杭州）、华南1（深圳） |
| 镜像 | **Ubuntu 22.04 LTS** 或 24.04 LTS（不要选 CentOS，脚本按 apt 写的） |
| 配置 | 2 核 2G 足够；系统盘 40G |
| 带宽 | 按固定带宽 3M 起步；或按使用流量（贺卡页面首屏资源约 2~3MB，流量计费更省） |
| 安全组 | 放行 **22**（SSH）、**80**、**443**；调试期再临时放行 **3000** |

**同时买一个域名**（阿里云"域名注册"，.com / .cn 都行）。备案是针对域名的，没有域名无法备案；域名必须实名认证通过才能提交备案。

## 二、备案（只有大陆节点需要）

在阿里云控制台搜「ICP 备案」→ 备案类型选「首次备案」→ 填主体信息（身份证、手机号）→ 填网站信息：

- 网站名称：**圣诞贺卡**
- 网站内容：**个人分享类网页 / 生活记录**
- 服务内容：其他

提交后阿里云会初审（1~2 天），然后转到管局审核（一般 7~20 天）。**这期间域名解析到大陆 IP 是不通的**，但可以用 `http://服务器IP:3000` 先正常用。

> 备案要求：服务器必须已经买了 ≥3 个月的包年包月实例（按量付费实例不能备案），并且备案主体年满 18 岁。

## 三、装环境

把仓库拉到服务器上（或在服务器上 `git clone` 你自己的仓库）：

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/lileikesi-del/MYWAREHOUSE.git /tmp/cards
sudo bash /tmp/cards/deploy/aliyun/setup.sh
```

脚本会做完这些事：装 Node 22 和 pnpm → 把代码同步到 `/srv/christmas-cards` → `pnpm install && pnpm build` → 创建系统服务 `christmas-cards` 并启动（监听 `127.0.0.1:3000`）→ 开防火墙 → 自检。

跑完之后直接访问 `http://服务器公网IP:3000` 就能用（**不需要备案**，3000 端口不受 80/443 的备案拦截）。

## 四、绑域名 + HTTPS（备案通过后）

1. 域名解析：加一条 A 记录，主机记录 `@` 或 `cards`，值填服务器公网 IP
2. 配 Nginx：

```bash
sudo cp /srv/christmas-cards/deploy/aliyun/nginx.conf /etc/nginx/sites-available/christmas-cards
sudo sed -i 's/cards.example.com/你的域名/g' /etc/nginx/sites-available/christmas-cards
sudo ln -sf /etc/nginx/sites-available/christmas-cards /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

3. 免费证书：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

certbot 会自动改写 Nginx 配置、加 443 和 http→https 跳转，并注册自动续期。

## 五、日常维护

```bash
systemctl status christmas-cards        # 是否在跑
journalctl -u christmas-cards -f        # 看日志
sudo systemctl restart christmas-cards  # 重启
```

**数据在哪**：`/srv/christmas-cards/data/`

- `letters.db` —— 所有贺卡内容（SQLite）
- `uploads/` —— 上传的音乐

**这两样一定要备份**，重装或换机器时把 `data/` 拷走再放回去即可。建议加个每日备份：

```bash
sudo crontab -e
# 每天 4 点打包到 /root/backup
0 4 * * * tar czf /root/backup/cards-$(date +\%F).tgz -C /srv/christmas-cards data && find /root/backup -name 'cards-*.tgz' -mtime +14 -delete
```

**更新代码**：

```bash
cd /tmp && rm -rf cards && git clone https://github.com/lileikesi-del/MYWAREHOUSE.git cards
sudo bash /tmp/cards/deploy/aliyun/setup.sh   # 幂等，会重新 build 并重启服务
```

## 六、和 Cloudflare 版本的区别

| | Cloudflare Workers | 阿里云 ECS |
|---|---|---|
| 国内直接打开 | ❌ 需要代理 | ✅ 可以 |
| 贺卡数据 | D1 数据库 | 本机 SQLite 文件 |
| 音乐存储 | R2 对象桶 | 本机 `data/uploads/` |
| 扩容 | 自动 | 手动（单机足够，贺卡量很小） |
| 成本 | 免费额度内 0 元 | 服务器 + 域名（学生机约 10 元/月） |
| 宕机风险 | 极高可用 | 单机，挂了要手动重启（systemd 会自愈进程，机器挂了不会） |
