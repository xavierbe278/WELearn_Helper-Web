# Welearn Helper | Web 

基于 PHP + 原生 JS 构建的 WeLearn 高效学习 Web 交互端。本项目为原系列项目的一个 Web 分支版本（基于版本：0.5dev），核心执行逻辑基于现有的更新维护者源码进行二次修改与重构开发。

**⚠️ 严正声明：本项目仅供编程学习与网络请求研究使用，严禁用于任何形式的商业用途、代刷盈利或二次倒卖。使用本项目产生的任何后果及平台违规风险由使用者自行承担。**

## ✨ 核心特性

- **Web 全覆盖**：支持在任意手机、平板、电脑上打开网页直接运行。
- **PHP 代理转发**：利用 `api.php` 中转 `cURL` 发包运行，将源文件放置于服务器上即可。
- **错峰高并发**：内置任务队列与错峰延时机制，在极速完成单元时长的同时，避免瞬时并发过高被拦截。
- **精准可视化日志**：显示进度展示逻辑，实时掌控运行状态。

## 🚀 部署指南

由于项目包含用于跨站请求转发的 PHP 代理服务，你需要将其部署在一个支持 PHP 的 Web 服务器上。

### 1. 环境要求
- 任何支持 PHP 的 Web 环境（Nginx / Apache 等）
- PHP 7.4+（需开启 `curl` 扩展）

### 2. 部署步骤
1. 克隆或下载本仓库的所有文件至你的 Web 网站根目录。
2. 确保在目录中存在一个名为 `data` 的文件夹（系统运行后会在此自动生成数据统计与记录文件）。
3. **权限设置**：请确保 Web 用户对 `data` 目录拥有读写权限。
```bash
   chmod 755 data
```
4. 在浏览器中访问 `index.html` 即可使用。


### 公告配置 (可选)

如果需要给访问者展示弹窗公告，可以在 `data` 目录下手动新建 `announcement.json` 文件：

```json
{
    "message": "这里写你要展示的网站公告内容，支持换行。"
}

```

## 💖 鸣谢与版权信息

本 Web 端工具的底层 API 交互逻辑与并发策略，均脱胎于开源社区的优秀前辈项目。在此向原作者与维护者致以最诚挚的敬意：

* **核心代码更新与维护者（本分支修改来源）**：[YZBRH](https://github.com/YZBRH)
* 维护版仓库：[Welearn_helper](https://github.com/YZBRH/Welearn_helper)

* **原系列项目基石（原 Python 项目作者）**：[Avenshy](https://github.com/Avenshy) & SSmJaE
* 原项目仓库：[WELearnToSleeep](https://github.com/Avenshy/WELearnToSleeep)

## 📄 开源协议

本项目遵循 [GPL-3.0 License](https://opensource.org/licenses/GPL-3.0) 开源协议。
允许任何人学习、修改和分享，但衍生项目必须同样开源并保留原作者信息。
