# Mihomo (Clash Meta) 代理使用方法

> 敏感凭证已移至 `~/.openclaw/credentials/` 统一管理

## 代理地址

- HTTP: `http://127.0.0.1:7890`
- SOCKS5: `socks5://127.0.0.1:7890`
- 控制面板: `http://127.0.0.1:9090`

## 服务管理

```bash
systemctl --user status mihomo    # 查看状态
systemctl --user start mihomo     # 启动
systemctl --user stop mihomo      # 停止
systemctl --user restart mihomo   # 重启
```

## 代理开关（终端）

```bash
proxy.on      # 开启代理
proxy.off     # 关闭代理
proxy.test    # 测试当前IP
```

## 节点切换

```bash
clash-switch              # 查看所有节点
clash-switch "节点名称"   # 切换节点
```

## 在脚本中使用

```javascript
// Node.js 请求使用代理
const response = await fetch(url, {
  agent: new HttpsProxyAgent('http://127.0.0.1:7890')
});
```

```python
# Python requests 使用代理
proxies = {
    "http": "http://127.0.0.1:7890",
    "https": "http://127.0.0.1:7890"
}
requests.get(url, proxies=proxies)
```

## 测试

```bash
curl -x http://127.0.0.1:7890 -s https://api.ipify.org
curl -x http://127.0.0.1:7890 -s https://ipinfo.io/json
```

---

⚠️ **订阅链接、Trojan密码等敏感信息请查看**: `~/.openclaw/credentials/mihomo-proxy.json`