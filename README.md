# DeepCompose Mobile Companion

DeepCompose 手机工作台，GitHub Pages 托管前端，电脑主动通过公网 MQTT/WSS 应用消息中继提供实际数据与独立手机任务。不是端口映射或远程桌面。

入口：https://3470437923-cloud.github.io/deepcompose-mobile-preview/

## 当前能力

- 未配对时不展示真实作品；配对后可读取授权电脑的作品、章节、候选、资料和桌面会话历史。
- 只读讨论与生成新候选，复用原 DeepCompose TypeScript controller 和工具检查。
- 手机任务独立保存在电脑的私有 runtime；桌面历史只读；不覆盖正文、既有候选或资料。候选采用仍在桌面操作。
- 任务在电脑执行，手机离线后可重新配对恢复；支持提问、回答与停止。
- 原布局示例保留在 demo.html，全部为虚构数据。

## 连接与运行

需要 Node 24 与 DeepCompose 源码构建任务执行器。安装依赖后运行 `node scripts/build.mjs`，再运行 `node bridge/main.mjs`。可通过环境变量 DEEPCOMPOSE_SOURCE 指定桌面源码位置；缺省为相邻 DeepCompose 目录。

电脑连接进程读取原 macOS prefs 目录，不将模型密钥下发浏览器。私有配对信息、任务与会话保存于用户主目录的 `.deepcompose-mobile`（目录0700、文件0600），绝不纳入本仓库。

通过 `node bridge/main.mjs --print-link` 在本机查看私有配对链接。链接中的 fragment 是访问凭据，不可转发；网页读取后立即清除地址栏fragment，凭据仅驻页面内存。刷新后重新打开私有链接即可配对，taskId单独保存在sessionStorage。配对有效期7天。撤销时先停止旧连接进程，再用 `node bridge/main.mjs --rotate` 启动新凭据；旧链接立即不能访问。

电脑须保持在线且不睡眠。网页“断开”会清除本页凭据和明文，不会停止已经在电脑执行的任务；停止任务请使用任务停止按钮。

## 安全与试用边界

原生 WebCrypto HKDF + AES-256-GCM，方向与活动会话隔离，带认证的时间窗、请求去重与重启隔离。只转发密文，非retained消息。文件仅授权作品Markdown分类，拒绝隐藏文件、链接文件与根外路径；有包长、速率、读取与任务上限。

使用公共 EMQX broker 进行单用户连接试用，服务稳定性与元数据隐私不等同自建生产服务；公开网页代码和GitHub账户也属于信任边界。生产版应迁移有ACL、设备撤销与独立域名的自建中继，且保留端到端加密。

长文件仅返回受限片段并标注截断；历史会话仅返回有预算的user/assistant文本，不返回工具参数、密钥或配置。

## 验证

`node --test tests/*.test.mjs`；`node scripts/smoke-relay.mjs`（公开网络加密合成数据测试）；`node scripts/probe-model.mjs`（使用本机模型和空白隔离项目的最小连接探针，不读取实际作品）。

## 发布

GitHub Pages 从 preview 分支根目录发布。公开仓库仅含代码、锁文件、测试和静态素材；`.bridge` 构建目录、node_modules和本地配置不入库。撤下网页可在仓库Pages设置取消发布；停止电脑连接进程则立即停止数据访问。

## License

GPL-3.0-only。DeepCompose 标志与复用核心来自原项目，原作者 Liumorrow。Inter字体许可在 assets/LICENSE-Inter.txt；运行依赖许可随锁定依赖及浏览器bundle法律声明保留。
