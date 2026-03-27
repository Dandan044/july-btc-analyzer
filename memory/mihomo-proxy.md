# Mihomo (Clash Meta) 代理配置

> 创建日期: 2026-03-27

## 基本信息

| 项目 | 值 |
|------|-----|
| **代理地址** | `http://127.0.0.1:7890` |
| **SOCKS5** | `socks5://127.0.0.1:7890` |
| **控制面板** | `http://127.0.0.1:9090` |
| **服务名称** | mihomo.service |

## 文件位置

| 文件 | 路径 |
|------|------|
| 配置文件 | `~/.config/clash/config.yaml` |
| GeoIP数据库 | `~/.config/clash/geoip.metadb` |
| 可执行文件 | `~/bin/mihomo` |
| 切换脚本 | `~/bin/clash-switch` |
| 服务文件 | `~/.config/systemd/user/mihomo.service` |

## 订阅信息

- **订阅链接**: `https://dy11.baipiaoyes.com/api/v1/client/subscribe?token=66357b836643462b4d52817a19cfab78&flag=clash`
- **流量**: 249.81 GB / 月
- **到期**: 2027-03-22

---

## 常用操作

### 开启/关闭代理（当前终端）

```bash
proxy.on      # 开启代理
proxy.off     # 关闭代理
proxy.test    # 测试当前IP
```

### 服务管理

```bash
systemctl --user status mihomo    # 查看状态
systemctl --user start mihomo     # 启动服务
systemctl --user stop mihomo      # 停止服务
systemctl --user restart mihomo   # 重启服务
```

### 节点操作

```bash
# 查看所有节点
clash-switch

# 切换节点
clash-switch "节点名称"

# 查看当前节点
curl -s http://127.0.0.1:9090/proxies/白嫖机场 | python3 -c "import json,sys; print(json.load(sys.stdin).get('now',''))"
```

### 更新订阅

```bash
curl -s "https://dy11.baipiaoyes.com/api/v1/client/subscribe?token=66357b836643462b4d52817a19cfab78&flag=clash" -o ~/.config/clash/config.yaml
systemctl --user restart mihomo
```

### 测试延迟

```bash
# 测试代理连接
curl -x http://127.0.0.1:7890 -s https://api.ipify.org

# 查看出口IP详情
curl -x http://127.0.0.1:7890 -s https://ipinfo.io/json
```

---

## 节点列表

### 🇺🇸 美国节点 (推荐)

| 节点名称 | 延迟 | 特点 |
|----------|------|------|
| 🇺🇸美国光速7-0.5倍率 | ~171ms | ⭐ 最快 |
| 🇺🇸美国光速8-0.5倍率 | ~172ms | 低延迟 |
| 🇺🇸美国光速6-0.5倍率 | ~176ms | 低延迟 |
| 🇺🇸美国光速1-解锁GPT | ~179ms | 解锁GPT |
| 🇺🇸美国光速2-解锁台区迪士尼 | ~180ms | 解锁迪士尼 |
| 🇺🇸美国光速3-解锁台区Netflix | ~177ms | 解锁Netflix |
| 🇺🇸美国🚀Chatgpt | ~184ms | ChatGPT专用 |

### 🇯🇵 日本节点

| 节点名称 | 延迟 |
|----------|------|
| 🇯🇵日本trojan | ~246ms |

### 🇬🇧 英国节点

| 节点名称 | 延迟 |
|----------|------|
| 🇬🇧英国🚀Chatgpt | ~397ms |

---

## API 参考

控制面板 API: `http://127.0.0.1:9090`

```bash
# 获取所有代理
GET /proxies

# 获取指定代理组信息
GET /proxies/白嫖机场

# 切换节点
PUT /proxies/白嫖机场
Body: {"name": "节点名称"}

# 测试延迟
GET /proxies/{节点名}/delay?timeout=5000&url=http://www.gstatic.com/generate_204
```

---

## 故障排查

### 代理不工作

1. 检查服务状态: `systemctl --user status mihomo`
2. 检查端口监听: `ss -tlnp | grep 7890`
3. 重启服务: `systemctl --user restart mihomo`

### 节点连接失败

1. 更新订阅配置
2. 尝试其他节点
3. 检查机场是否过期

### 开机不自启

```bash
# 确保linger已启用
loginctl user-status | grep Linger

# 启用服务
systemctl --user enable mihomo
```