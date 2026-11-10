# 手机与电脑真实连接契约

## 目标
沿用已确认手机布局和电脑主动连接公网的架构。单用户单台 Mac 试用；真实数据不进入 GitHub Pages、仓库、日志或明文中继。手机离线不取消电脑已启动任务。

## 模块与顺序
1. secure-channel：端点 AES-256-GCM 加密，HKDF 派生 topic/c2d/d2c；MQTT over WSS 应用消息中继，不进行端口转发。
2. desktop-bridge：仅电脑本地读取配置与授权作品目录。项目与文件使用不透明ID。只读接口、独立手机会话与任务执行。
3. mobile-client：配对、真实作品/章节/会话、电脑任务状态，明确离线/超时/错误。未配对不展示虚构内容为真实内容。

## 安全边界
配对secret 32随机字节，仅在本地权限0600配置与URL fragment，页面解析后立即清除 fragment，仅保留页面内存，刷新后须重新配对；只有taskId使用sessionStorage保存，支持断开和本机撤销。配对链接不得入库、日志、HTTP路径、第三方请求、公开构建产物。公共broker仅作试用，不承诺生产可用性；不使用retained消息。
AES-GCM随机12字节nonce、版本与方向AAD。请求/响应均加密；请求ID、客户端ID、时间窗与去重防重放；响应只匹配当前挂起请求。消息/文件/队列长度受限，拒绝未知命令、路径穿越、隐藏目录、配置文件、symlink、根外读取。XSS：真实内容仅textContent，DOM不拼接用户文字。

## v1 RPC
每条请求 {v:1,id,clientId,issuedAt,method,params}，响应 {v:1,id,clientId,issuedAt,ok,result|error}。项目ID由本地授权目录映射，不传本机绝对路径。
- hello → {device,version,capabilities,model,connection,startedAt}
- projects.list → [{id,name,modifiedAt,chapterCount,candidateCount}]
- files.list {projectId,category:chapters|candidates|materials} → [{id,name,category,size,modifiedAt}]
- file.read {projectId,fileId} → {id,name,content,version,truncated}
- sessions.list {projectId} → 会话标题、ID、来源、更新时间，最多50项
- session.read {projectId,sessionId} → 仅user/assistant文本，工具/配置不外传
- task.start {projectId,text,mode:readonly|writing} → {taskId}，按请求ID持久去重；最多1个生成任务，默认readonly；writing最多只写新候选，不允许覆盖正式稿与既有候选
- task.get {taskId} → 持久化快照（消息、进度、待回答问题、完成/失败），支持断线后读取
- task.answer {taskId,questionId,answers} / task.stop {taskId}

## 电脑执行
不修改当前有未提交更改的桌面仓库；通过构建适配器复用现有TS controller和工具校验，密钥从本机prefs读取，使用Node流式HTTP适配器。独立手机会话/用量/任务存在用户本地私有runtime目录。桌面既有会话仅只读，不冒充正在控制当前桌面窗口。模型任务执行前保存请求意图，重启不自动重试不确定任务。

## 验收
Node原生test覆盖密钥错误/篡改/方向/时间窗、穿越/symlink/超大文件、重放与客户端隔离；两独立公网WSS客户端可完成hello和真实文件读；WebKit访问公网部署版完成配对、真实列表和正文显示（只记录条数不记录小说正文）；未配对和错误凭据不能读取；真实模型最小探针只请求回复连接成功，不发送作品或写作文件；手机任务运行不依赖网页保持前台。

## 命令
Node: /Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
Install: node /Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs install
Test: node --test tests/*.test.mjs
Build: node scripts/build.mjs
Run: node bridge/main.mjs（配置位置 ~/.deepcompose-mobile，不上传配置）

## 发布与撤销
公网静态页面与公开源码不包含任何配对secret或作品。独立本地连接进程提供电脑数据；停止进程立即停止访问，删除/轮换本地secret撤销所有旧配对。
