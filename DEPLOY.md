# 云端部署指南

仓库：<https://github.com/bansu233/emoji-web>

本文按当前仓库的第二阶段版本编写：Node.js 22、内置 SQLite、批量上传、审核、分类、收藏、ZIP、管理后台、审计日志、可选 S3 对象存储。

## 0. 推荐结论

### 0.1 服务器规格

| 场景 | 推荐 | 说明 |
| --- | --- | --- |
| 首选（有备案） | 大陆云厂商 2C4G / 80 GB SSD / 5–10 Mbps | 腾讯云 CVM、阿里云 ECS、华为云 ECS；大陆访问延迟最低，域名需 ICP 备案 |
| 首选（无备案） | 香港/新加坡 2C4G / 80 GB SSD / 5 Mbps+ | 腾讯云轻量（香港/新加坡）、阿里云轻量（香港）、Vultr、DigitalOcean；无需 ICP |
| 低成本海外 | Hetzner / Vultr / DigitalOcean 2C2G–2C4G | 欧洲或美西便宜，但中国大陆访问延迟约 150–250 ms |
| 不想运维 | Railway / Render + Persistent Volume | 单实例 + 单持久卷；设置 `DATA_DIR=/data`、`UPLOAD_DIR=/data/uploads`，由平台提供 HTTPS |

**本项目的最低建议是 2 vCPU / 4 GB RAM / 80 GB SSD / 5 Mbps 以上，Ubuntu 24.04 LTS。**
2C2G 也能跑，适合 20–30 人以内的小团队；4 GB 内存对批量上传、ZIP 打包和后续图片处理更从容。

带宽需要特别注意：5 MB 图片在 5 Mbps 链路上理论下载约 8 秒，在 10 Mbps 上约 4 秒。团队外部公开访问建议 10 Mbps 起步，或后续接对象存储 + CDN。

### 0.2 国内备案与地区

- 服务器在中国大陆：域名必须完成 **ICP 备案**，否则 80/443 通常会被阻断。
- 服务器在香港/新加坡：无需 ICP，国内访问通常可用，但延迟和线路质量取决于厂商。
- 主要用户在中国大陆、且能备案：优先大陆同区域。
- 想最快上线、不想备案：选香港轻量服务器。

### 0.3 参考成本

以下只是量级，实际以云厂商实时报价为准：

- 香港/新加坡 2C2G / 40–80 GB：约 $8–20/月。
- 香港/新加坡 2C4G / 80 GB / 5 Mbps：约 $15–30/月。
- 大陆 2C4G + 5 Mbps 固定带宽：常见在 ¥100–300+/月，带宽和备案是主要差异。
- 域名：约 $10–15/年；对象存储和快照按量计费。
- 先买 1 个月按量/月付测试，确认线路和备案后再年付。

### 0.4 是否需要对象存储

首版建议先用本地磁盘 + 每日备份：

- 单机 SQLite + 本地图片足够支撑小团队。
- 图片会随使用量增长，`data/` 与 `uploads/` 必须放持久卷。
- 需要多实例、CDN 或更大容量时，再启用 S3 兼容对象存储（Cloudflare R2、阿里云 OSS、腾讯云 COS、MinIO 等）。

当前代码已支持 S3 兼容存储；本地文件仍保留，可用作快速读取和回退。**不要在首日同时引入对象存储和复杂 CDN，先把闭环稳定跑起来。**

## 1. 部署架构

```text
Internet
   │  80/443
   ▼
Caddy 2.10（自动 HTTPS、gzip/zstd、56 MB 请求体上限）
   │  Docker 内网 app:3000
   ▼
Node.js 22 应用（非 root）
   ├── /app/data      → ./data       SQLite（含 WAL）
   ├── /app/uploads   → ./uploads    原图与缩略图
   └── /app/backups   → ./backups    一致性备份
```

- 只暴露 Caddy 的 80/443；应用端口 3000 不发布到宿主机。
- Caddy 自动申请和续期 Let's Encrypt 证书。
- 应用容器以 `node` 用户运行，去掉 Linux capabilities。
- `data/`、`uploads/` 使用 bind mount，备份和迁移直观。
- SQLite 与本地文件决定了当前必须是 **单实例**；不要直接横向扩容多个 app 副本。
- Caddy 固定使用 `2.10-alpine`：`request_body` 指令需要 Caddy 2.10+（[官方文档](https://caddyserver.com/docs/caddyfile/directives/request_body)），升级 Caddy 前先运行 `caddy validate`。

## 2. 准备清单

- 一台 Ubuntu 24.04 LTS 云服务器（2C4G / 80 GB SSD 起）。
- 一个域名，A 记录指向服务器公网 IP。
- 服务器安全组放行：22、80、443（TCP），可选 443/UDP（HTTP/3）。
- 本地 SSH 私钥；建议禁用密码登录。
- 如果域名走 Cloudflare 代理：首次签发证书时先把记录设为 **DNS only（灰云）**，否则 HTTP-01 验证可能失败。证书签发后可再评估代理模式；最稳妥是保持 DNS only 或改用 DNS challenge。若开启橙云，还需配置 Caddy 的受信代理/`CF-Connecting-IP`，否则按 IP 的限流会按 Cloudflare 节点统计。

## 3. 初始化服务器

以 root 登录后创建部署用户（如果云厂商已经提供非 root 用户可跳过）：

```bash
adduser deploy
usermod -aG sudo deploy

# 把当前 root 的 SSH 公钥复制给 deploy（确认 ~/.ssh/authorized_keys 已存在）
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy/
```

确认可以用 `deploy` 登录后，再修改 SSH 配置：

```bash
sudo tee /etc/ssh/sshd_config.d/99-emoji-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
EOF
sudo systemctl reload ssh
```

基础软件、防火墙与时区：

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw ca-certificates dnsutils rsync
sudo timedatectl set-timezone Asia/Shanghai

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status
```

2 GB 内存机器建议加 2 GB swap，防止构建镜像时内存不足：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version
docker compose version
```

如果服务器在中国大陆、拉取 Docker Hub 较慢，请按云厂商文档配置镜像加速，或使用云厂商提供的容器镜像服务。不要使用来路不明的镜像源。

## 4. 拉取代码与配置

```bash
sudo mkdir -p /opt/emoji-web
sudo chown "$USER":"$USER" /opt/emoji-web
git clone https://github.com/bansu233/emoji-web.git /opt/emoji-web
cd /opt/emoji-web
```

如果仓库是私有的，先在 GitHub 配置 Deploy Key，或使用带权限的 HTTPS Token 克隆；不要把 Token 写进仓库。

### 4.1 生产环境变量

```bash
cp deploy/env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

至少修改：

```dotenv
DOMAIN=emoji.example.com
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
COOKIE_SECURE=1
TRUST_PROXY=1
SEED_DEMO_ACCOUNTS=0
TZ=Asia/Shanghai

DATA_DIR=/app/data
UPLOAD_DIR=/app/uploads
BACKUP_DIR=/app/backups
BACKUP_KEEP=14
```

说明：

- `DOMAIN` 只填主机名，不带 `https://`。
- 证书邮箱是可选的；Caddyfile 默认不写邮箱，若要接收 Let's Encrypt 到期提醒，可在 Caddyfile 的全局块加 `email`。
- `SEED_DEMO_ACCOUNTS=0` 防止生产环境出现默认演示账号；管理员稍后用命令行创建。
- 不建议把管理员密码写进 `.env.production`；使用下一节的 `create-user` 交互式创建。
- 开启 S3 时再加四项 S3 配置，详见第 9 节。

### 4.2 数据目录权限

容器内应用以 UID/GID `1000`（node 用户）运行；宿主机目录必须可写：

```bash
mkdir -p data uploads backups
sudo chown -R 1000:1000 data uploads backups
ls -ld data uploads backups
```

## 5. 启动

先确认 DNS 已生效：

```bash
dig +short "$(grep '^DOMAIN=' .env.production | cut -d= -f2-)"
```

先做配置静态校验，再启动：

```bash
docker compose config >/dev/null
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile

docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100 app caddy
```

预期：

- `app` 显示 `healthy`。
- `caddy` 申请证书成功，日志出现 `certificate obtained successfully`。
- 浏览器打开 `https://你的域名` 能看到登录页。

如果证书申请失败，先检查：

1. DNS A 记录是否指向本机公网 IP；
2. 安全组/UFW 是否放行 80、443；
3. Cloudflare 是否仍为橙色云代理；
4. 域名是否已备案（大陆服务器）。

### 创建管理员和审核员

生产环境 `SEED_DEMO_ACCOUNTS=0`，首次启动没有账号。用一次性容器创建：

```bash
read -rsp "设置管理员密码: " NEW_USER_PASSWORD; echo

docker compose run --rm \
  -e NEW_USER_PASSWORD \
  app node --disable-warning=ExperimentalWarning scripts/create-user.js admin admin

unset NEW_USER_PASSWORD
```

可选审核员：

```bash
read -rsp "设置审核员密码: " NEW_USER_PASSWORD; echo

docker compose run --rm \
  -e NEW_USER_PASSWORD \
  app node --disable-warning=ExperimentalWarning scripts/create-user.js reviewer reviewer

unset NEW_USER_PASSWORD
```

`create-user` 也可以更新已有账号的密码或角色；更新密码会让该账号现有会话全部失效。

### 验证

```bash
curl -fsS "https://$(grep '^DOMAIN=' .env.production | cut -d= -f2-)/api/health"
```

然后浏览器实际走一遍：

1. 管理员登录；
2. 批量上传 2–3 张图片；
3. 审核员通过；
4. 广场搜索并下载；
5. 收藏，测试 ZIP 打包下载；
6. 管理后台修改分类、角色、回收站恢复。

## 6. GitHub Actions 部署

仓库已经提供两个工作流：

- `.github/workflows/ci.yml`：push/PR 自动跑 14 项测试，并额外校验 `docker compose config`、`caddy validate` 和 Docker 镜像构建。
- `.github/workflows/deploy.yml`：手动触发，测试通过后 SSH 到服务器，先执行一次一致性备份，再 `git reset --hard origin/<branch>` 并重建容器。

> 服务器上的 `/opt/emoji-web` 应视为一次性部署目录：工作流会丢弃该目录里的 Git 修改。`data/`、`uploads/`、`backups/` 都已被 gitignore，不会被重置；但仍不要把重要文件手工放在仓库目录里。

### 6.1 准备部署密钥

在本机执行：

```bash
ssh-keygen -t ed25519 -C "github-actions-emoji" -f ./emoji_deploy -N ""
ssh-copy-id -i ./emoji_deploy.pub deploy@SERVER_IP
ssh-keyscan -H SERVER_IP > ./deploy_known_hosts
```

把公钥追加到服务器 `~deploy/.ssh/authorized_keys`。`ssh-copy-id` 已自动完成。确认 `deploy` 用户可以执行 `docker compose`。

### 6.2 配置 GitHub Secrets

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 示例 | 说明 |
| --- | --- | --- |
| `DEPLOY_HOST` | `203.0.113.10` | 服务器 IP 或域名 |
| `DEPLOY_USER` | `deploy` | 部署用户 |
| `DEPLOY_PATH` | `/opt/emoji-web` | 服务器项目目录 |
| `DEPLOY_SSH_KEY` | `emoji_deploy` 私钥全文 | 包含 BEGIN/END 行 |
| `DEPLOY_KNOWN_HOSTS` | `deploy_known_hosts` 全文 | 防止 SSH 中间人 |

然后在 GitHub `Actions → Deploy to VPS → Run workflow` 手动选择 `main` 执行。

> 当前本地新增的 Docker/部署文件需要先 commit 并 push；在 push 前，GitHub 上不会出现这两个工作流。

如果服务器上是私有仓库，还要在服务器配置只读 Deploy Key 或凭据，否则 `git pull` 会失败。

## 7. 备份与恢复

### 7.1 手动备份

```bash
chmod +x ops/backup.sh
./ops/backup.sh
```

脚本在应用容器内执行：

- 使用 SQLite `VACUUM INTO` 生成一致性数据库快照；
- 复制 `uploads/` 全部文件；
- 写入 `manifest.json`（时间、记录数、文件数、大小）；
- 按 `BACKUP_KEEP` 保留最近 N 份，默认 14 份。

结果在宿主机：

```text
backups/20261105-031500/
├─ meme-vault.db
├─ uploads/
└─ manifest.json
```

### 7.2 每日定时备份

```bash
crontab -e
```

加入：

```cron
0 3 * * * cd /opt/emoji-web && ./ops/backup.sh >> "$HOME/emoji-backup.log" 2>&1
```

同时建议开启云厂商的磁盘快照和异地对象存储备份。应用内 `.backup` 不能替代异地备份。

### 7.3 恢复

先停应用：

```bash
cd /opt/emoji-web
docker compose stop app
```

选择备份并恢复：

```bash
STAMP=20261105-031500
cp "backups/$STAMP/meme-vault.db" data/meme-vault.db
rm -f data/meme-vault.db-wal data/meme-vault.db-shm
rsync -a --delete "backups/$STAMP/uploads/" uploads/
sudo chown -R 1000:1000 data uploads
docker compose up -d app
```

恢复后立即验证登录、列表和图片访问。不要在 app 运行期间直接覆盖 SQLite 文件。

## 8. 更新与回滚

每次更新前先备份：

```bash
cd /opt/emoji-web
./ops/backup.sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

回滚：

```bash
git log --oneline -5
git checkout <上一版本提交>
docker compose up -d --build
```

数据库迁移是向后兼容的增量迁移，但回滚应用版本前仍建议用备份验证。不要删除 `data/`、`uploads/` 或 `backups/`。

## 9. 可选：启用 S3 兼容对象存储

当需要异地冗余、CDN 或多实例时，再在 `.env.production` 设置：

```dotenv
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=emoji-vault
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

说明：

- 四项/五项必须同时配置，否则应用启动报错。
- 远程端点必须是 HTTPS。
- Bucket 建议保持私有；应用通过签名请求访问，不暴露对象 URL。
- 启用后本地仍保留副本，`backups/` 不能关闭。
- 先在一个测试环境验证上传、读取、删除和恢复，再切生产。

## 10. 常见问题

| 现象 | 排查 |
| --- | --- |
| 502 Bad Gateway | `docker compose ps` 看 app 是否 healthy；`docker compose logs app` |
| UFW 已放行但公网仍不通 | 云厂商安全组/上游防火墙也要放行 80/443；`ss -lntp` 确认 Caddy 正在监听 |
| 证书申请失败 | DNS、80/443、Cloudflare 橙云、备案 |
| 登录后立刻掉线 | `COOKIE_SECURE=1` 必须配 HTTPS；检查域名和反代头 |
| 上传返回 413 | Caddy `max_size 56MB` 和各文件 5 MB 限制 |
| 上传文件夹权限错误 | `sudo chown -R 1000:1000 data uploads backups` |
| 磁盘满 | 检查 `uploads/`、`backups/`；清理旧备份并扩容 |
| 页面中文乱码 | 确认源码为 UTF-8；不要用 Windows 记事本另存为 ANSI |
| 拉取镜像慢 | 配云厂商容器镜像加速，不要在服务器上使用不可信脚本 |

## 11. 安全检查清单

- [ ] 服务器只开放 22/80/443（以及需要的 443/UDP）
- [ ] 禁用 root 密码登录，只允许 SSH Key
- [ ] `.env.production` 权限 600，不进 Git
- [ ] `SEED_DEMO_ACCOUNTS=0`，管理员强密码
- [ ] `COOKIE_SECURE=1`，全站 HTTPS
- [ ] `data/uploads/backups` 已做持久化与异地备份
- [ ] 云防火墙与 UFW 同时检查
- [ ] 定期看 `docker compose logs`、磁盘、备份日志
- [ ] 不运行多个 app 副本共享同一个 SQLite
- [ ] 不把 `uploads/` 暴露成静态目录

## 12. 成本建议

- 2C4G / 80 GB 香港或新加坡轻量服务器：通常是最平衡的起步方案。
- 大陆 2C4G + 5–10 Mbps：访问最快，但需要备案和更高带宽费。
- 云盘快照、对象存储备份和域名是额外成本；图片量上来后，先把原图迁到对象存储 + CDN，再考虑数据库升级。

价格和活动变化很快，购买前以云厂商官网实时报价为准。对内部团队，首年优先保证“稳定 + 可备份”，不必一开始买高配。
