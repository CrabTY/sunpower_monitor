# Local preview with simulated data

在线体验：[项目介绍](https://crabty.github.io/sunpower_monitor/) · [只读模拟 Demo](https://crabty.github.io/sunpower_monitor/demo/?scenario=day)。以下步骤用于本地开发与复现。

这套预览直接加载当前工作树的 `web/` 页面，用固定的模拟 API 数据检查 Live、History、Panels 和 Settings。它**没有从线上 D1 数据库导出真实历史**，也不会请求或修改线上 API。适合反复比较页面状态；不能用来判断真实产量或验证数据库查询。

## 启动

使用 Node.js 22+，在仓库根目录安装依赖后启动：

```sh
npm ci
npm run preview
```

打开 <http://127.0.0.1:4173/>。顶部提示栏标明 `Simulated data · local review`，可切换场景；选中的场景会保存在当前浏览器，切换页面时继续生效。若 4173 端口被占用，可运行 `PORT=4174 npm run preview` 并打开对应端口。退出用 `Ctrl-C`。

| 场景 | 固定时间（站点时区 America/Los_Angeles） | Review 重点 |
| --- | --- | --- |
| Night | 2026-09-23 00:45 PDT | 夜间微小读数、Live/History 的 0.5 kW 最低刻度、Panels 等待日光 |
| Day | 2026-09-22 14:00 PDT | 正常日间曲线、21 块面板中的 19 块产出与 2 块未上报 |
| Day without output | 2026-09-22 14:00 PDT | 白天已有采样但零产出，与 Night 的“尚未到采样时间”对照 |

也可直接访问 `/?scenario=night`、`/?scenario=day`、`/?scenario=idle` 切换。然后用页面导航进入 History 或 Panels。

## 数据范围与实现

- 模拟数据从 2026-08-24 00:00 PDT 开始，按分钟生成站点功率与累计电量，按五分钟生成面板读数，并提供逐小时天气、日出日落和日照时长。History 的 1 分钟、5 分钟、每日视图都使用这批数据。
- 2026-09-19 的云层让产量降低；2026-09-21 10:30–11:05 PDT 有一段源数据错误，供检查历史缺口。Night 包含会显示为 `0.0 kW` 的极小夜间读数。
- 预览服务器在 [`scripts/preview.mjs`](../scripts/preview.mjs)；数据生成、固定时钟和 `/api/v1/*` 浏览器内替身在 [`scripts/preview-client.js`](../scripts/preview-client.js)。页面仍读取当前 `web/` 文件，修改前端后刷新即可看到效果。
- 这份数据覆盖约 30 天；可检查 Today、Week、Month 和指定日期。Year 仍只有这段模拟记录，页面会标明未覆盖的时间。预览固定为 PDT，不用于检查夏令时切换。

运行 `npm run check:preview` 可检查三个场景和面板数据一致性；`npm run check` 运行仓库的全部检查。

## 项目介绍站点

同一服务器的 `/introduction/` 提供公开介绍、开始使用、方案对比和项目说明四页；`?lang=en` 切换英文。源码位于独立的 `site/` 目录，站点使用 `site/assets/` 的模拟界面截图，不访问家庭数据。

## 可直接托管的演示产物

```sh
npm run build:site
python3 -m http.server 4174 --bind 127.0.0.1 --directory dist/site
```

打开 <http://127.0.0.1:4174/>，从介绍页进入 Demo。`dist/site/` 是可删除、可重新生成的静态产物，不是第二套源代码；既可托管在域名根路径，也可托管在 GitHub Pages 的项目子路径。部署平台只需发布该目录，域名和 GitHub About 的 Website 地址在真正发布后设置。

Demo 复用 `web/` 和同一份模拟数据，所有 API 均在浏览器内响应，不连接 PVS 或 Cloudflare。未模拟的网络请求被拒绝，Settings 控件与定位禁用；显示的坐标是旧金山市中心示例。生产仪表盘仍需登录，并使用用户自己的部署和数据。

### GitHub Pages

介绍站与模拟 Demo 使用同一仓库的 `.github/workflows/pages.yml`，只发布生成的 `dist/site/`。无需另建源码仓库、提交生成文件或维护 `gh-pages` 分支。

本仓库已使用免费的 GitHub Pages 上线，**Settings → Pages → Source** 为 **GitHub Actions**。若在自己的仓库复现，需先满足 GitHub Pages 的套餐/可见性要求并选择相同发布来源；工作流不会改变仓库可见性，也不自动启用 Pages。

Actions 中手动运行 `pages`，不勾选 `publish` 可验证安全检查、构建与临时 Pages artifact；勾选后才执行托管。首次上线后，公开仓库中影响站点的 main 更新会自动发布，安全检查失败时不会发布。私有仓库的 push 只验证构建，不自动发布。

本仓库首页为 `https://crabty.github.io/sunpower_monitor/`，Demo 位于 `demo/`；README 与 GitHub About 使用已验证地址。若在其他仓库部署，以工作流返回的实际 `page_url` 验证链接。GitHub Pages 不读取 Cloudflare 的 `_headers` 文件；Demo 的网络限制通过 HTML CSP 和浏览器内替身实现，设置与真实定位仍禁用。
