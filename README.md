# autoresearch

一个让 agent 一轮一轮改进某个对象的框架：每轮先改、再测量打分，分数比之前最好的高就保留，
否则回退。具体改什么、怎么测量、怎么打分由使用它的项目决定；框架负责轮次、记录和回退，
并在 agent 越界时让这一轮失败。

## 一轮里发生什么

`ResearchRunner` 每轮调用项目给的 `doResearch()`（通常是：让 agent 修改，再测量）和
`doScore()`，结果是三种之一：

- **keep**：分数高于同一评分版本下最好的保留分数，改动作为 checkpoint 提交。
- **discard**：分数没有更高，提交后立即 revert。
- **crash**：`doResearch` 抛出普通错误，算实验失败，同样提交后 revert。

`HarnessError` 表示是 harness 自身出了问题（服务不可用、需要人处理），runner 直接
抛出，不记 checkpoint，也不回退。

每个分数都带 `version`。评分方法变了就换版本，不同版本的分数不互相比较。

研究在自己的 git worktree（`.ar/worktrees/<名字>`，分支 `autoresearch/<名字>`）里进行；
checkpoint 只允许改 `scope` 列出的路径，越界的改动会让这一轮失败。实验记录（ledger）是
JSON 文件，每个研究一份，由 `FileStorageProvider` 写入。

## 模块

| 模块                    | 内容                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `runner.ts`             | `ResearchRunner`、`HarnessError`                                                           |
| `rounds.ts`             | `runRounds`：跑到轮数用完、连续 N 轮没提升或 harness 出错；`--once`、`--rounds N`          |
| `checkpoint.ts`         | git checkpoint：scope 检查、提交、revert                                                   |
| `worktree.ts`           | 研究的 worktree 与分支，`linkDependencies` 把主 checkout 的依赖链进来                      |
| `footprint.ts`          | `confine`：agent 在 scope guard 看不到的 checkout 里工作时，改了范围外的文件就让这一轮失败 |
| `gate.ts`               | 测量前必须通过的检查（如 `vp check`），不通过算实验失败                                    |
| `reset.ts`              | 找出并删除一个研究留下的 worktree、分支和 ledger                                           |
| `storage.ts`            | ledger 存储：文件或内存                                                                    |
| `agent.ts`              | agent 接口：一次 `ask` 是一轮新的对话                                                      |
| `agents/nap.ts`         | NAP 云端 agent                                                                             |
| `agents/nap-mirror.ts`  | 把本地 checkout 带进 NAP workspace、再把改动带回来                                         |
| `report/`               | 所有研究生成一个静态页面；各研究可提供自己的详情渲染                                       |
| `cli.ts`、`parallel.ts` | 只收位置参数的命令行；限并发的 `inParallel`                                                |

## NAP 镜像

agent 在云端 workspace 里工作，但看到的是本地 checkout 的路径。每轮开始前，镜像把
git 可见的文件、`.git`、各 worktree 和项目声明的路径打包上传；agent 先运行
`/workspace/.nap-mirror/unpack.sh`，它把副本解到 `/workspace/.nap-mirror/trees<本地绝对路径>`，
在本地路径处建链接，再执行项目的 setup。`node_modules` 每轮保留，不重新安装。
轮次结束后，改动和 `returns` 声明的输出拉回本地，本地的 scope guard 照常把关。

`alongside` 列出的其他 checkout（例如从旁边目录 `link:` 进来的包，包括本框架自己）也会
带进去，但只上传 git 可见的文件，不拉回任何改动。所有副本在 `trees/` 下保持和本地
一样的相对位置，所以 checkout 之间的相对链接在云端同样能解析。

## 在项目里使用

框架以 TypeScript 源码提供，用 `node --experimental-transform-types` 直接运行，没有
构建步骤。把它放在项目旁边，在项目里 link 进来：

```json
"dependencies": { "autoresearch": "link:../autoresearch" }
```

```ts
import { ResearchRunner } from "autoresearch/runner.ts";
```

`link:` 不会安装被链接包自己的依赖，所以框架目录也要单独 `vp install` 一次。用 NAP
镜像时，把框架目录放进 `alongside`，并在 setup 里为它安装生产依赖。Node 不会剥离
`node_modules` 里 `.ts` 文件的类型，所以要用 `link:`（真实路径在 `node_modules` 之外），
不能用 `file:`。

## 开发

```bash
vp install   # 安装依赖
vp check     # fmt + lint + typecheck（--fix 自动修）
vp test      # 单测
```

pre-commit 会对暂存文件跑 `vp check --fix`。
