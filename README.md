# 客户汇总清单台账 · 多人协作 Web 版（部署到 supabase.com 官方）

把 Excel 台账搬成一套带登录、带行级权限的 Web 应用，后端用**官方托管 Supabase（supabase.com）**，免费版即可起步。

> **本次部署前提**
> - 阿里云方案已放弃，**从未部署过**，所以不用管任何阿里云相关的东西。
> - 你已经在 supabase.com 建好了一个**全新的空项目/空数据库**。
> - 因此只需执行 `supabase_schema.sql` **一次**；`supabase_upgrade.sql` 本次**用不到**（它只是为将来字段再调整留的迁移档）。
> - 官方 supabase.com **没有 IP 白名单**、不用配 VPC / 数据库密码、不存在「Dashboard 密码不可重置」这些阿里云特有问题。

> **注意｜如果库已经建好、里面已有账号和数据（当前状态）**
> 初版建库脚本只给了管理员删除权限，客户经理没有。要启用「删除」，请在 **SQL Editor 整段执行一次 `supabase_patch_delete.sql`**：幂等、不动任何数据和账号、不改表结构，只补一条 RLS 策略。全新空库直接跑 `supabase_schema.sql` 即可，该策略已内置其中，**不必**再跑补丁。
>
> **注意｜本次「当前进度」改为 7 档**
> 新增 `过户中`、`待放款`，`已结案` 并入 `已放款`。`records` 表上有 **CHECK 约束**写死旧值，`CREATE TABLE IF NOT EXISTS` **不会更新已存在表的约束**，所以重跑主脚本无效 —— 已部署的库必须再执行一次 **`supabase_patch_progress.sql`**：替换约束，并把库里所有「已结案」的历史行迁移成「已放款」。幂等，不动其它数据。全新空库直接跑主脚本即可。
>
> **注意｜本次「业务编号」改为系统自动生成（重点）**
> 已部署、有数据的库请再执行一次 **`supabase_patch_biz_no.sql`**：建每日流水计数器、`alloc_biz_no()` 分配函数、INSERT 兜底触发器与 UPDATE 保护触发器，回填存量空编号并加非空约束。幂等，**不改动任何已有编号**。全新空库直接跑 `supabase_schema.sql` 即可（已内置，不必再跑补丁）。
> 不跑补丁前端也能用（会自动降级成本地算号），但**多个客户经理同天录入会撞号**，所以建议尽快补跑。改完前端与 SQL 后，浏览器按 **Ctrl+F5 硬刷新**。

> **本次「录入防误关 + 列表排序」是纯前端改动，不用再跑任何 SQL**
> 覆盖 `frontend/index.html` 与 `frontend/app.js` 后，浏览器按 **Ctrl+F5 硬刷新** 才会加载新版（否则缓存的旧 JS 看起来像「按钮没加」）。Excel 版仅「使用说明」新增第十节（排序方法），数据与公式未变。详见第四节 4.2 / 4.3。

> **安全｜登录页已移除「创建第一个管理员账号」自助入口**
> 页面是公开可访问的，不能留任何注册 / 提权入口。现在首个管理员**只能在 Supabase Dashboard 手工创建**（见第 7 步），日常开账号由管理员登录后在工具栏操作；前端还会兜底清空旧版页面缓存里残留的注册框。

> **★ 本次「界面美化 + 密码管理」需要跑一条 SQL（当前已部署的库）**
> 界面与「自己修改密码」是纯前端，打开就能用；但**主管重置他人密码**依赖数据库函数 `public.admin_reset_password`，已部署的库必须在 SQL Editor **整段执行一次 `supabase_patch_password.sql`**（幂等，只加函数与授权，不动任何表结构和数据）。全新空库直接跑 `supabase_schema.sql`（7.2 段已内置）。不跑的话，只有点「重置为 888888」时会报 `could not find the function`，其它功能不受影响。执行后浏览器 **Ctrl+F5 硬刷新**。

---

## 一、权限模型（严格对应台账列）

| 角色 | 对应表格字段 | 可见数据 | 能力 |
|---|---|---|---|
| **渠道用户** `channel` | 「渠道」列 `records.channel` | 仅本人绑定的那个渠道 | **只读**：没有编辑 / 删除按钮，数据库 RLS 也没有任何写策略 |
| **客户经理** `manager` | 「客户经理」列 `records.manager_name` | 仅本人名下的签单 | 录入 / 修改 / **删除本人签单**；`客户经理`、`录入人` 自动锁定为本人 |
| **管理员（主管）** `admin` | — | 全部 | 按渠道筛选拉明细、**新增渠道**、**新增客户经理**、新增渠道用户、录入 / 改 / **删任意行**、导出 CSV |

> 两个角色是独立的：渠道用户按 `渠道` 过滤，客户经理按 `客户经理` 过滤，互不相干。

### 删除签单（填错 / 拒单）

明细表最右「操作」列现在有 **编辑**、**删除** 两个按钮；渠道用户**没有这一列**，只能看。

- 点「删除」会先弹**二次确认**，列出该单的业务编号、签约日期、客户姓名、渠道、客户经理、当前进度、结账状态，确认后才真正删除；点「取消」或 × 不会动数据。
- **删除不可恢复**，且 KPI、明细表、CSV 导出、看板统计都会同步移除这一单；当前选择的统计区间保持不变。
- 权限是**数据库 RLS + 前端按钮**双重约束：管理员可删任意行；客户经理只能删「客户经理 = 本人」的单；渠道用户连请求都发不出去（没有 delete 策略）。
- **拒单建议保留痕迹**：如果只是业务终止 / 拒单、不是录入错误，建议点「取消」后改用「编辑」把「当前进度」设为 `已终止`，这样历史仍可追溯；确实填错的单才删。
- 客户经理点删除报权限错 → 说明库是早期脚本建的，去执行一次 `supabase_patch_delete.sql`。

---

## 二、字段与取值（v2）

台账主表共 **14 个业务字段**（已取消「贷款银行」整个字段）；Excel 版另有一列自动「序号」，故 Excel 共 15 列：

```
业务编号 / 签约日期 / 渠道 / 客户姓名 / 物业地址 / 合同总价(万) / 贷款类型 /
贷款金额(万) / 客户经理 / 当前进度 / 缺件清单 / 结账状态 / 录入人 / 备注
```

| 字段 | 取值 |
|---|---|
| **渠道** | 初始 `21世纪庄庆`、`顾总`、`牛总`、`MOHAN` —— **可随时新增，见第三节** |
| **客户经理** | 初始 `何燕`、`孔得杨`、`梁雄凯`、`王迎佳`（也可由管理员手填新增） |
| 贷款类型 | 商业 / 公积金 / 组合贷 / 全款 / 其他 |
| 当前进度 | **7 档，按业务流程排列**：待补充资料 → 查房 → 审批中 → **过户中** → **待放款** → 已放款 → 已终止。原「已结案」与「已放款」合并为 `已放款`（完成态，绿色） |
| 结账状态 | 未结账 / 已结账 |

### 业务编号：系统自动生成，不用手输

沿用现有编号 `Z26111001` / `Z26110805` 的形态，规则定为：

```
Z + 签约日期(YYMMDD) + 当日流水号（至少 2 位，从 01 起；超过 99 自动升 3 位）
```

| 场景 | 生成结果 |
|---|---|
| 2026-11-14 第 1 单 | `Z26111401` |
| 2026-11-14 第 2 单 | `Z26111402` |
| 2026-11-10 已有 `Z26111001`，再补一单 | `Z26111002` |
| 2026-11-08 已有 `Z26110805`，再补一单 | `Z26110806` |
| 未填签约日期 | 按录入当天生成，如 `Z26111401` |

- **历史编号一律保留**：样例里 05 / 12 / 30 / 18 这类不规则尾号不重编，新号自动取「该日已有最大尾号 + 1」，因此绝不会撞号。
- **新增签单**：一点开弹窗就向数据库取号，编号框是**灰底只读**，取号期间「保存」按钮短暂禁用；改「签约日期」会自动重新取号，前缀永远与日期一致。保存后提示里会带上最终编号。
- **编辑签单**：编号只读且**保存时不提交这个字段**，数据库 `trg_keep_biz_no` 再挡一道，编号永久不变。确需修正历史编号时，由管理员在 SQL Editor 手工 UPDATE（该处不受触发器限制）。
- **编号不回收复用**：删除某单后该号不再分配；取消新增 / 反复改签约日期会消耗掉几个号，所以流水号**允许跳号、不保证连续**，这是刻意设计，避免同一编号先后指向两笔业务。
- **为什么放数据库算**：客户经理受 RLS 限制只看得到本人签单，两个经理同天第一单用前端算都会得到 `01`；多人并发录入同理。数据库在计数器行上加行锁原子分配，从根上杜绝重号；Table Editor 直接插行、旧版前端不传编号，也会被 `trg_fill_biz_no` 自动补号。
- **Excel / WPS 版同规则**：`客户汇总清单台账.xlsx` 的 B 列从第 8 行起是自动编号公式（样例 6 行为历史静态值），先填签约日期编号即出现；详见表内「使用说明」第九节。

---

## 三、渠道随时可新增（重点）

渠道**不是写死的 4 个**，它们只是初始化数据，存在 `channels` 表里，数据库没有加 CHECK 约束。管理员有三种方式加新渠道：

1. **工具栏「＋ 新增渠道」**：填渠道名 → 保存；可勾选「同时创建该渠道的登录账号」，一键开出绑定该渠道的只读账号。
2. **录入签单时直接手输**：管理员在「＋ 新增签单 / 编辑签单」的「渠道」框里直接输入一个下拉里没有的新名字，保存时前端会**自动把它写进 `channels` 表**并刷新所有下拉，下次全员可选。不必先去点「新增渠道」。
3. **Database 里加**：supabase.com → Table Editor → `channels` → Insert row。

权限边界：RLS 规定 `channels` 表**只有管理员能增删改**，其他人只读；所以客户经理的录入表单里渠道仍是「只能从已有渠道中选」的下拉，不能自己造渠道。

> Excel / WPS 在线版同样支持：在「配置字典」A 列（渠道）下方预留的空白槽位填入新渠道即可，主表 D 列允许直接手输，「数据看板」的渠道分布与图表会**自动跟随统计**（已预置 20 个槽位）。

---

## 四、看板与列表交互（时间筛选 / 排序 / 防误关）

### 4.1 时间筛选（按月份 / 区间）

看板指标、明细表、CSV 导出**共用同一个统计区间**，改一次三处同步变；筛选依据「签约日期」列。

| 入口 | 怎么用 | 适合场景 |
|---|---|---|
| **快捷标签** | 顶部常驻：`全部时间 / 本月 / 上月 / 近 3 个月 / 今年`，**点一下即生效** | 日常绝大多数场景 |
| **▦ 选月份** | 弹出按年份分组的月份格子，**可跨年多选勾选**，格内数字为该月签单数；另有「全选本年 / 清空」 | 只看某几个月、跨年对比 |
| **▧ 自定义区间** | 两个原生日期框（点开就是日历）填起止；附 `本月 / 上月 / 近 3 个月 / 今年 / 近 30 天` 一键填入 | 按任意起止结算、季度复盘 |

设计说明（避免踩坑）：

- **默认「全部时间」**，刷新页面也回到全部，不会出现「数据怎么少了」的困惑。
- 月份候选 = 当前条件下有数据的月份 + 最近 12 个月，**切换月份后其它月份不会消失**，可反复改选；灰色格子表示当前条件下没有签单。
- 启用筛选后，**未填「签约日期」的行不计入**，右侧会提示「另有 N 条未填签约日期未计入」；选「全部时间」则全部计入。
- 新增签单的签约日期**默认填今天**；若刚保存的单子不在当前区间，会提示切回「全部时间」查看。
- 面板点外部 / `Esc` / 「取消」关闭；「清除（全部时间）」一键复位。**有录入弹窗打开时 `Esc` 优先作用于弹窗**（见 4.3）。
- 时间筛选与渠道 / 进度 / 结账 / 搜索**叠加生效**，且始终在数据库 RLS 的权限边界内（前端筛选只是辅助，不能越权）。
- 导出 CSV 文件名会带上当前区间，如 `客户汇总清单台账_2026年11月_2026-11-14.csv`。

> **Excel / WPS 版同样有**：打开 `客户汇总清单台账.xlsx` →「数据看板」→ `B2` 下拉选月份（第一项即本月）；或在 `D2`/`E2` 填起止日期（优先于月份）。所有 KPI、进度分布、渠道分布与图表按该区间重算。

### 4.2 列表排序（两种主排序 + 时间方向）

明细表上方新增一条「列表排序」工具条：两个互斥的主排序按钮 + 一个时间方向按钮。

| 按钮 | 主排序 | 第二排序要素 | 第三（稳定兜底） |
|---|---|---|---|
| **按签约时间（同日按渠道）**（默认） | 签约日期，默认 **新→旧** | 渠道名称 A→Z | 业务编号 → id |
| **按渠道（同渠道按时间）** | 渠道名称 A→Z | 签约日期，默认 **新→旧** | 业务编号 → id |

- **「时间：新 → 旧 / 旧 → 新」** 只切换「签约日期」的升降序；渠道名称**始终 A→Z**，避免「按渠道排序却把渠道倒过来」这种反直觉结果。
- **未填签约日期的行恒排最后**：按签约时间时排全表最后，按渠道时排在该渠道最后。此前数据库 `ORDER BY sign_date DESC` 会把 NULL 排到最前面，是「排序看着凌乱」的根因。
- 排序**只重排本地视图**，不重新查库、不增减数据，KPI 条数不变；与渠道 / 进度 / 结账 / 搜索 / 统计区间**叠加生效**，切换筛选后仍按当前排序展示。
- **CSV 导出的行序与屏幕完全一致**（所见即所得），可直接粘回表格。
- 右侧灰字实时显示当前生效规则，例如「当前：渠道名称 A→Z，同一渠道内签约日期 新→旧；未填日期排最后」。
- 刷新页面回到默认「按签约时间 · 新→旧」，和统计区间一样**不做持久化**，避免「数据怎么换顺序了」的困惑。

> **Excel / WPS 版**：主表第 1 行已开自动筛选，点列箭头排序即可；C 列 = 签约日期、D 列 = 渠道，两级排序按「使用说明」第十节操作。Web 版的排序按钮只影响网页当前视图，不会写回 Excel。

### 4.3 录入表单防误关（未保存确认 + 草稿）

以前点 × / 取消 / 弹窗外遮罩 / Esc 会**直接关掉弹窗，填了一半的内容全丢**。现在所有关闭入口统一先检测「有没有未保存改动」：

- **没改任何内容** → 直接关闭，不打扰。
- **改过内容** → 弹出独立的确认层（盖在弹窗之上，**不覆盖、不清空表单**），三个按钮：
  - **继续编辑**（最安全）：只关确认层，输入原样保留；点确认层遮罩、按 Esc 同样是「继续编辑」。
  - **保留草稿并关闭**：内容暂存，下次打开**同一个表单**自动恢复并提示；编辑单按记录 `id` 单独存草稿，不会串单。保存成功后草稿自动作废。
  - **不保存，直接关闭**：明确放弃，两层一起关掉。
- **覆盖范围**：新增签单、编辑签单、新增渠道、新增客户经理 / 渠道用户。删除确认弹窗没有可填字段，点「取消」仍直接关闭。
- **未保存时点别的弹窗按钮**（填到一半去点「新增渠道」之类）也会先确认，不会把当前表单悄悄替换掉。
- **刷新 / 关闭标签页**由浏览器 `beforeunload` 再兜一道（原生「离开此页？」提示）。
- **保存请求进行中**不允许关闭，避免半途而废。
- 自动生成的「业务编号」是只读框，取号 / 改日期重取号**不算用户改动**，所以一打开弹窗不会误报「有未保存内容」。
- 草稿只存在**当前页面内存**，不写数据库、不跨浏览器、刷新页面即清空；重要内容还是建议及时保存。

### 4.4 密码管理（自己改 / 主管重置）

顶部右侧新增两个入口：

| 入口 | 谁能用 | 做法 | 结果 |
|---|---|---|---|
| **修改密码** | 所有已登录用户 | 填「新密码 + 确认」→ 确认修改 | 走 GoTrue `auth.updateUser`，只改**当前会话本人**；即时生效，不掉线，主管也看不到新密码 |
| **账号管理** | 仅主管（管理员） | 打开账号列表（可搜索手机号 / 姓名 / 渠道），点某人「重置为 888888」→ 行内二次确认 | 走数据库 `public.admin_reset_password(uuid)`，把该账号密码置为 **`888888`**；其现有登录会话立即失效 |

规则与边界：

- 重置后**下一次登录**必须用 `888888`，请当面/电话通知本人，并让对方尽快用「修改密码」改成自己的。
- **不能重置自己**：账号列表里本人那行显示「本人 · 请用『修改密码』」，函数内也再挡一道。
- 只改密码，**不改角色、不改绑定渠道/经理、不动任何台账数据**；可重复重置。
- 「账号管理」列表读 `profiles`，受 RLS 约束只有管理员能读到全部账号；客户经理和渠道用户连按钮都看不到。
- 前端点「重置」报 `could not find the function public.admin_reset_password` → 就是没跑 `supabase_patch_password.sql`，执行后刷新即可。

> **安全设计**：浏览器端的 `auth.admin.updateUserById()` 需要 `service_role` / `sb_secret_` 密钥，那把钥匙放进公开网页会绕过全部 RLS，等于把整库交出去。因此改用数据库 `SECURITY DEFINER` 函数代写 `auth.users`，函数内独立校验 ① 已登录 ② 调用者是 admin ③ 不是本人 ④ 目标账号存在，并固定密码为 `888888`（不接受任意密码参数）；`EXECUTE` 只授予 `authenticated`，`anon` 无权调用。SQL Editor 里 `auth.uid()` 为空，匿名直调会被第 ① 道拒绝。

### 4.6 Apple 风格改版（2026-11-15，评审通过稿）

界面整体换为苹果「简约高级」设计语言，**HTML 结构与全部 id/事件零改动、app.js 零改动**，仅重写 CSS：

- **令牌**：页面底 #F5F5F7、纯白面板、发丝线 rgba(0,0,0,.08)、主文字 #1D1D1F / 次 #6E6E73；唯一强调色为系统蓝 #0071E3（沿用 `--navy` 变量名），警示红 #FF3B30（`--accent`）、提醒橙 #FF9500（`--gold`）。旧衬线"账簿风"全部并入系统字体栈（SF Pro / 苹方，0 字节字体下载）。
- **按钮**：全站胶囊形（980px 圆角）+ 44px 触控高度 + 按压缩放回弹（cubic-bezier 弹性曲线，可被打断）；层级只由"蓝色填充 / 浅灰填充 / 纯文字"三档表达，无描边按钮；行内编辑/删除改为蓝/红文字按钮。
- **组件**：排序/区间 chips 改胶囊分段；月份格、状态底色（7 档进度 + 结账状态）映射到苹果系统色浅底；弹窗圆角 18、iOS Alert 式删除强确认；手机端顶栏与 PC 顶栏毛玻璃（`backdrop-filter:saturate(180%) blur(20px)`，`@supports` 兜底半透明纯色）。
- **性能**：零新依赖、动效仅 transform/opacity、CSS 增量 gzip 后约 1KB；保留 prefers-reduced-motion 全局减动效。

### 4.7 双业务线（一手房 / 二手房）并存（2026-11-16）

配套数据库补丁 `supabase_patch_business_line.sql`（在仓库外、需先到 Supabase SQL Editor 执行）。前端按最终口径实现：

- **权限口径**：admin（唯一主管）与 manager（客户经理）双线通用、不做数据隔离，靠切换器「分开浏览统计」；**只有 channel 渠道用户被隔离**（本渠道 + 本业务线，由 RLS 保证）。`allowed_lines` 数组只用于决定切换器显隐：多线显示、单线隐藏。
- **切换器**：放在顶栏 `.navmenu`（PC 直接显示、手机进 ≡ 菜单），选项 100% 来自 `profile.allowed_lines`，绝不硬编码；切换只换数据上下文（清空渠道筛选 → loadChannels/loadManagers → loadRecords），KPI / 明细 / 排序 / 导出自动跟随；标题同步显示当前业务线；导出 CSV 文件名带业务线。
- **编号分线**：二手房 `Z+YYMMDD+流水`、一手房 `X+YYMMDD+流水`，两条线流水独立。`allocBizNo(date, line)` 调用双参 RPC，校验与降级算号都按线前缀；编辑签单不传 `business_line`，保持原线。
- **开户口径**：客户经理账号固定双线；渠道用户归属当前业务线（要开另一条线的渠道用户先用切换器切过去）；渠道新增/账号邀请都带业务线字段。
- **账号管理**：列表新增「业务线」列，搜索也匹配业务线。

### 4.7 双业务线（一手房 / 二手房）并存（2026-11-16）

配套数据库补丁 `supabase_patch_business_line.sql`（在仓库外、需先到 Supabase SQL Editor 执行）。前端按最终口径实现：

- **权限口径**：admin（唯一主管）与 manager（客户经理）双线通用、不做数据隔离，靠切换器「分开浏览统计」；**只有 channel 渠道用户被隔离**（本渠道 + 本业务线，由 RLS 保证）。`allowed_lines` 数组只用于决定切换器显隐：多线显示、单线隐藏。
- **切换器**：放在顶栏 `.navmenu`（PC 直接显示、手机进 ≡ 菜单），选项 100% 来自 `profile.allowed_lines`，绝不硬编码；切换只换数据上下文（清空渠道筛选 → loadChannels/loadManagers → loadRecords），KPI / 明细 / 排序 / 导出自动跟随；标题同步显示当前业务线；导出 CSV 文件名带业务线。
- **编号分线**：二手房 `Z+YYMMDD+流水`、一手房 `X+YYMMDD+流水`，两条线流水独立。`allocBizNo(date, line)` 调用双参 RPC，校验与降级算号都按线前缀；编辑签单不传 `business_line`，保持原线。
- **开户口径**：客户经理账号固定双线；渠道用户归属当前业务线（要开另一条线的渠道用户先用切换器切过去）；渠道新增/账号邀请都带业务线字段。
- **账号管理**：列表新增「业务线」列，搜索也匹配业务线。

### 4.5 手机端适配（≤768px，纯 CSS + 顶栏结构微调）

`app.js` 与业务逻辑零改动；全部移动端样式收在 `@media (max-width:768px)` 内，PC（>768px）渲染与旧版逐像素一致。

| 变化 | 说明 |
|---|---|
| ＋ 新增签单 → 右下角悬浮球 | 同一个按钮换摆放（fixed 定位），id/事件不变；渠道角色 JS 隐藏时悬浮球一并消失；弹窗打开时被遮罩盖住，不挡「保存」 |
| 顶栏 | 一行 ≤56px；刷新/导出 CSV/修改密码/退出（主管另有账号管理）收进右上 ≡ 下拉菜单，「退出」标红；PC 端按钮组用 `display:contents` 原样保留在顶栏 |
| 统计区间 | 一行横向滑动的胶囊；月份/区间面板变为底部抽屉 |
| KPI | 紧凑网格（`minmax(76px,1fr)`），金额过长省略号截断 |
| 表格 | 表头吸顶、首列（业务编号）固定、操作列固定（渠道只读角色无操作列则不固定）；正文 13px、编号/日期/金额不换行、地址单行省略 |
| 弹窗 | 近全屏、内容区内部滚动、取消/保存吸底（适配 iPhone 底部安全区），输入 16px 防 iOS 聚焦放大 |

> **实现口径（重要）**：表头吸顶与首末列固定相对于 `.tablebox` 滚动容器生效（容器纵横双向滚动）。任务书预设的「外层容器只横向滚动 + 页面纵向滚动」结构经无头浏览器实测会让表头吸顶失效（`overflow-x:auto` 使容器同时成为纵向滚动容器，sticky 被其截获）；容器内滚动方案与 PC 版 `.tablebox` 同构，Chromium / iOS Safari 实测两方向 sticky 同时生效。容器底部预留 88px、页面底部预留 96px，列表滚到底时最后一行操作按钮不会被悬浮球遮挡。

> **横向滚动归位（2026-11-15 补）**：手机浏览器刷新时会恢复 `.tablebox` 上次的横向滚动位置，导致首屏表格停在"半截列"状态（如签约日期滑进固定首列下面，只剩 `1-13`）。`index.html` 末尾新增一段纯观感脚本：`history.scrollRestoration='manual'` + 监听表格重绘（MutationObserver）与 `pageshow`，在 ≤768px 时把 `scrollLeft` 归零；PC 与业务逻辑均不受影响。注意：滑动过程中中间列从固定列下方穿过、文字被"切"是横向滚动的正常中间态，非故障。

> **表格布局 v2（2026-11-15 二次优化，`app.js?v=20261115a`）**：首尾双固定挤压中间数据的改进——
> 1. 手机端「业务编号」列由第一列挪到「操作」列前（`renderTable` 按 `matchMedia(768px)` 切换列序，断点变化自动重绘；PC 恒为原始列序）；
> 2. 左固定列改为「客户姓名」（`th/td.pin-l`），滑动时始终知道是谁的单子；右固定列只留 ✏️ 图标按钮（`td.act` 宽度压到 52px），删除入口移入编辑弹窗左下角红色「删除此单」文字按钮；
> 3. 删除强确认：点「删除此单」弹出独立确认层（z-index 90，盖在弹窗上），必须手动输入「删除」两字，「确认删除」按钮才解锁；Esc/取消/点遮罩均安全关闭，删除后弹窗一并关闭并刷新列表；
> 4. 两固定列内侧新增 12px 渐变阴影（`::after` 伪元素），暗示中间区域可横向滑动；
> 5. 表头吸顶、表单吸底按钮、右下角 FAB 均保留。PC 端列表仍为「编辑 + 删除」双按钮 + 原列序，渲染结果与旧版一致。
>
> 唯一新增的 JS 是 `index.html` 末尾约 10 行的 ≡ 菜单开合脚本（纯展示，不读写任何业务数据）。

---

## 五、文件清单

```
客户汇总清单台账.xlsx              Excel / WPS 在线版台账（字段来源）
supabase_schema.sql               ★ 全新空库执行：5 张表 + 触发器 + 三角色 RLS（含删除策略）+ 自动编号 + 密码重置函数 + 6 行样例
supabase_patch_delete.sql         ★ 已部署过、有数据的库执行一次：补客户经理 delete 策略（幂等）
supabase_patch_progress.sql       ★ 已部署过、有数据的库执行一次：换 7 档进度约束 + 合并「已结案」历史数据（幂等）
supabase_patch_biz_no.sql         ★ 已部署过、有数据的库执行一次：自动编号函数 + 触发器 + 回填存量空编号（幂等）
supabase_patch_password.sql       ★ 本次新增：主管重置他人密码的函数 + 授权（幂等，只加函数不动数据）
supabase_upgrade.sql              仅旧库字段迁移用，本次【不要执行】
frontend/
  ├─ index.html                   三角色前端页面（账簿式视觉 + 密码管理入口）
  ├─ app.js                       业务脚本
  ├─ config.js                   ★ 只需填 URL / ANON_KEY
  ├─ vendor/supabase-js.umd.min.js  已内置，离线可用（缺失时自动回退 CDN）
  └─ README.md                   本文件
```

---

## 六、部署步骤（全新官方空项目）

### 第 1 步｜确认项目可用

登录 `https://supabase.com/dashboard` → 选中项目。
⚠️ **免费版项目约 7 天无活动会自动暂停**，暂停后前端一律 `Failed to fetch`；若看到 paused 提示，点 **Restore project** 恢复。

### 第 2 步｜配置 Authentication（不做这步账号登不进来）

左侧 **Authentication → Sign In / Providers → Email**：

| 项 | 设置 |
|---|---|
| Email Provider | **启用** |
| **Confirm email** | **关闭**（关掉邮箱确认，一键开的账号才能立刻用登录名+密码登录） |
| Allow new users to sign up | **开启**（前端 `signUp` 靠它一键开户） |

可选：同区域 **URL Configuration → Site URL** 填 `http://localhost:8000`，Redirect URLs 加 `http://localhost:8000/**`。

> `Confirm email` 不关还会顺带踩一个坑：supabase.com 发确认邮件时会校验邮箱域名，`@example.com` 这类域名会被判 `email_address_invalid`。关掉后不发信，伪邮箱方案即可正常工作。

### 第 3 步｜执行建库 SQL

**SQL Editor → New query → 整段粘贴 `supabase_schema.sql` → Run**。

脚本幂等，可重复执行。会创建：

| 表 | 作用 |
|---|---|
| `records` | 台账主表，14 个业务字段（无「贷款银行」） |
| `channels` | **渠道名单，管理员可随时新增** |
| `profiles` | 用户档案（角色 + 绑定的渠道/经理姓名） |
| `user_invites` | 开户邀请，防注册提权 |
| `biz_no_seq` | **业务编号每日流水计数器**，只由 `alloc_biz_no()` 读写（前端不直接访问） |

以及注册触发器、`SECURITY DEFINER` 取角色函数、三角色 RLS 策略、**业务编号自动分配函数与两个触发器**、6 行样例数据。

验收：Table Editor 里 `records` 有 6 行，`channels` 有 4 个初始渠道。

> 本次**不要**执行 `supabase_upgrade.sql` —— 它是给「已经跑过旧版脚本、需要保留旧数据」的场景用的，你是全新空库。
>
> **如果你已经跑过早期版本的 `supabase_schema.sql`（库里有数据）**：不用重跑主脚本（`CREATE TABLE IF NOT EXISTS` 不会更新已存在表的约束和策略）。改为在 SQL Editor **各执行一次**这四个幂等补丁：
> - `supabase_patch_delete.sql` —— 补客户经理的 delete 策略；
> - `supabase_patch_progress.sql` —— 换 7 档 CHECK 约束，并把「已结案」历史行迁移为「已放款」；
> - `supabase_patch_biz_no.sql` —— 业务编号自动分配函数 + 触发器 + 回填存量空编号；
> - `supabase_patch_password.sql` —— 主管重置他人密码的函数（本次新增）。
>
> 四个补丁彼此独立、都幂等，顺序随意；**全新空库一个都不用跑**。
>
> 跑没跑齐，用下面一条 SQL 自查（`progress_ck` 含「过户中」「待放款」、`delete_policy` = 1、`alloc_fn` ≥ 1、`reset_fn` ≥ 1）：
> ```sql
> select
>   (select pg_get_constraintdef(oid) from pg_constraint
>     where conname = 'records_progress_ck' and conrelid = 'public.records'::regclass) as progress_ck,
>   (select count(*) from pg_policies where schemaname = 'public' and tablename = 'records'
>     and policyname = 'records_manager_delete') as delete_policy,
>   (select count(*) from pg_proc where proname = 'alloc_biz_no') as alloc_fn,
>   (select count(*) from pg_proc where proname = 'admin_reset_password') as reset_fn;
> ```
>
> 典型症状：选「过户中 / 待放款」保存时报 `violates check constraint "records_progress_ck"`，就是 `progress` 补丁没跑；点「重置为 888888」报 `could not find the function`，就是 `password` 补丁没跑。

### 第 4 步｜取 Project URL 与 Key

左下角 **Project Settings（齿轮）→ API Keys**（或顶部 **Connect** 弹窗）：

| 要复制的 | 位置 | 长相 |
|---|---|---|
| **Project URL** | 同页 / Connect | `https://abcdefghijklmno.supabase.co` |
| **Publishable key**（推荐） | API Keys → Publishable key | `sb_publishable_xxxxx` |
| 或旧版 **anon key** | API Keys → **Legacy API keys** 标签 | `eyJhbGciOi...` |

两种 key 前端都自动兼容。🔴 **绝不能填 `sb_secret_...` / `service_role`**：它会绕过 RLS，前端会直接拒绝启动并给出提示。

> 官方计划在 2026 年底弃用旧 anon/service_role key，新项目建议直接用 Publishable key。

### 第 5 步｜填前端配置

打开 `frontend/config.js`：

```js
window.SUPABASE_CONFIG = {
  URL: 'https://abcdefghijklmno.supabase.co',  // 第 4 步的 Project URL
  ANON_KEY: 'sb_publishable_xxxxx',            // 第 4 步的 Publishable key
  AUTH_DOMAIN: ''                              // 留空 = 自动适配，别改
};
```

URL 少写 `https://`、多写尾斜杠都能自动纠正；但**不要填 Dashboard 网页地址**（`supabase.com/dashboard/...`），前端会提示填错。

### 第 6 步｜打开前端

```bash
cd frontend
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

登录页底部会显示「已连接 supabase.com 项目：xxxx」，说明配置生效。

### 第 7 步｜创建第一个管理员（仅部署时做一次）

登录页**没有任何自助注册入口** —— 页面是公开的，不能留这种后门。首个管理员在 Supabase 后台手工创建：

1. **Authentication → Users → Add user**：邮箱填 `手机号@ledger.example.com`（域名换成你 `config.js` 里 `AUTH_DOMAIN` 的值），设好密码，勾选 **Auto Confirm User**（或已关闭 Confirm email）。
2. **SQL Editor** 执行下面这句，把它提升为管理员：

   ```sql
   update public.profiles
      set role = 'admin', phone = '13800138000', display_name = '管理员'
    where id = (select id from auth.users where email = '13800138000@ledger.example.com');
   ```

   如果 `profiles` 里还没有这一行（注册触发器未建），先执行主脚本 `supabase_schema.sql` 再重试；仍没有就手工插一行：

   ```sql
   insert into public.profiles (id, phone, display_name, role)
   select id, '13800138000', '管理员', 'admin' from auth.users
    where email = '13800138000@ledger.example.com';
   ```

3. 回到登录页，用该**手机号**（不用带 `@` 后缀）+ 密码登录，即拥有全部权限。

> 故意做成手工 SQL，而不是可调用的 `promote_admin()` 函数 —— 否则任何人都能调用它给自己提权。
> 之后日常开账号一律用管理员登录后工具栏的「＋ 新增客户经理 / ＋ 新增渠道用户」，**不要再走这一步**。

### 第 8 步｜管理员一键开人、开渠道

登录后顶部工具栏：

- **＋ 新增渠道**：填渠道名即可；可勾选「同时创建该渠道的登录账号」。
- **＋ 新增客户经理**：从默认 4 人选或手填新姓名 + 手机号 → 自动建账号并绑定角色。
- **＋ 新增渠道用户**：选渠道 + 手机号 → 建只读账号。
- **＋ 新增签单**：渠道框可直接手输新渠道名，保存即自动入库。
- **按渠道筛选**：拉指定渠道的全部明细。

### 团队账号约定（已内置进开户表单）

| 角色 | 登录名 | 初始密码 | 表单表现 |
|---|---|---|---|
| 客户经理 | 本人 11 位手机号 | **同一个手机号** | 填手机号后密码框自动带出相同号码；手改过就不再跟随 |
| 渠道用户 | 本人 11 位手机号 | **`888888`**（6 个八） | 密码框预填 888888（「新增渠道」里同时开户也一样） |
| 管理员（主管） | 部署时设定的手机号 / 邮箱 | 部署时自设 | 首个管理员在 Supabase Dashboard 手工创建（登录页无注册入口） |

密码框留空提交时，前端会按上表自动补齐，不会因漏填而开户失败；两个默认密码都 ≥ 6 位，满足 Supabase Auth 的最小长度。把 `手机号 + 密码` 发给同事即可协作；登录页直接填手机号，不用带 `@` 后缀。渠道账号是统一初始密码但**只能读自己渠道**，建议只发给对应渠道本人。

**同事忘了密码**：主管点顶部「账号管理」→ 找到该账号 → 「重置为 888888」→ 行内二次确认，然后通知对方用 `888888` 登录并自行修改密码。任何人都可以用顶部「修改密码」改自己的密码，见 4.4 节。

---

## 七、登录名自动适配 Supabase

前端把「人看的登录名」自动翻译成 **Supabase Auth 的邮箱账号**，无需短信服务商：

| 你输入 | 前端自动处理 |
|---|---|
| `13800138000` | → `13800138000@ledger.example.com` |
| `zhangsan` | → `zhangsan@ledger.example.com` |
| `boss@yourcompany.com` | → 原样使用（支持你在 Dashboard 手工建的邮箱账号） |

其它自动适配点：

- **URL**：自动补 `https://`、去尾斜杠、识别项目 ID 并显示在登录页；误填控制台地址会被拦下提示。
- **Key**：自动兼容新 `sb_publishable_...` 与旧 `eyJ...` anon；误填 `sb_secret_...` / `service_role` 会拒绝启动。
- **域名**：`config.js` 的 `AUTH_DOMAIN` 留空即自动用默认值；若 supabase.com 报 `email_address_invalid`，改成你有 MX 记录的域名（如 `yourcompany.com`），**改完已建账号要重建**，全站必须一致。
- **报错**：`Invalid login credentials` / `email_address_invalid` / `Failed to fetch` 都会附上针对 supabase.com 的具体排查提示。

管理员开户弹窗仍要求 11 位手机号（要写进 `profiles.phone`），同事登录后可用手机号、邮箱或用户名登录。初始密码按第 8 步的「团队账号约定」由表单自动带出，主管可手动改。

---

## 八、关键实现点

1. **渠道用户按 `渠道` 列、客户经理按 `客户经理` 列分别做行级过滤**，两个角色彻底拆开。
2. **客户经理/录入人双重锁定**：表单 disabled + 数据库 `BEFORE INSERT/UPDATE` 触发器 `force_record_owner()` 强制写成本人。
3. **规避 RLS 递归**：`auth_role()` / `auth_channel()` / `auth_manager()` 用 `SECURITY DEFINER` + 固定 `search_path`。
4. **防注册提权**：登录页**没有任何自助注册入口**，前端还会兜底清空旧版缓存页面里残留的注册框。Supabase 公开注册之所以仍开着，是为了让管理员能一键开户，但 `user_invites` 只允许管理员写、注册触发器按邀请授角色；绕过前端自行注册的人只会拿到 `channel = null` 的空账号，看不到任何数据、也无法提权。
5. **开户不顶掉管理员会话**：`signUp` 用独立客户端（`persistSession:false`、独立 `storageKey`），结束再 `setSession` 恢复。
6. **渠道动态化**：`channels` 表 + 仅管理员可写的 RLS；前端下拉、筛选、录入候选全部由该表实时读取。
7. **删除三段式**：管理员 `records_admin_all`（`for all` 含 delete）、客户经理 `records_manager_delete`（仅本人）、渠道用户无写策略；前端只对前两种角色渲染操作列，删除前还要过一次带单据摘要的确认弹窗。
8. **进度档位三处同源**：数据库 `records_progress_ck` CHECK 约束、前端 `OPTIONS.progress`、Excel「配置字典」都是同一组 7 档；改动必须同时跑增量补丁（已部署库）。Excel 看板进度分布行号按 `len(PROGRESS)` 推导，再增删档位也不会挤占渠道分布区。
9. **业务编号服务端原子分配**：`alloc_biz_no()` 以 `SECURITY DEFINER` 扫描该日已有编号最大尾号，对 `biz_no_seq` 的当日行加行锁 +1；前端 `rpc` 取号后把同一个号显式写进 `records`，所见即所得；`trg_fill_biz_no`（INSERT 兜底）、`trg_keep_biz_no`（UPDATE 保护）覆盖其它入口。老库未跑补丁时前端降级本地算号并明确提示。
10. **Excel 看板口径跟着改**：B 列变成公式后，业务总数不再用 `COUNTIFS(B,"<>")`（公式返回空串也算非空，会把 1000 行全算进去），改用必填的 D 列「渠道」判空。
11. **排序在客户端统一收敛**：服务端查询只给稳定初始序，`sortView()` 按 `sortMode` / `sortTimeDesc` 对 `viewRows` 重排（KPI、明细、CSV 共用同一份已排序数组）。无签约日期的行单独兜底排末尾，修正 Postgres `DESC` 默认 `NULLS FIRST` 的问题；三级排序键保证同日同渠道也不会跳来跳去。
12. **未保存保护不依赖 DOM 解析**：打开弹窗时对所有「用户可编辑字段」取基线快照，关闭时比对；同时用 `input` / `change` 事件做兜底。只读的业务编号、disabled 字段被排除，程序化赋值（自动取号、草稿恢复）不会触发误报。确认层是独立 DOM 节点，三个动作只操作确认层本身，表单始终不被重写。
13. **密码管理分两条通道**：自己改走 `auth.updateUser`（GoTrue 只作用于当前会话用户）；主管重置他人走 `rpc('admin_reset_password')`，由 `SECURITY DEFINER` 函数在库内校验 admin 后用 pgcrypto 生成 bcrypt 写入 `auth.users`，并删除该账号的 `auth.sessions` / `auth.refresh_tokens` 使其立即掉线。前端永远拿不到 `service_role`。pgcrypto 所在 schema 由 `pg_proc` 动态定位，避免不同项目装在 `extensions` / `public` 的差异。
14. **视觉是纯 CSS 层替换**：账簿风样式只改颜色、字体、间距、分隔方式、微动效与登录页布局；所有既有 `id`、class、`data-*` 属性和 JS 绑定点保持不变，新增节点在 `app.js` 里一律做空值保护（只换其中一个文件也不会白屏）。`prefers-reduced-motion` 下关闭全部动画，动效只用 `opacity` / `transform`，不触发布局重排。

---

## 九、排错

| 现象 | 原因 / 处理 |
|---|---|
| `Failed to fetch` / 超时 | ① **免费项目被自动暂停** → Dashboard 点 Restore；② `URL` 不是 `https://<项目ID>.supabase.co`；③ 浏览器网络无法访问 supabase.co。④ 本平台**没有 IP 白名单** |
| 提示「URL 填错了」 | 填成了 `supabase.com/dashboard/...` 控制台地址，改成 Project Settings 里的 Project URL |
| 提示「密钥类型填错了」 | 误填 `sb_secret_...` / `service_role`，换成 Publishable key 或 anon key |
| `Invalid login credentials` | ① Confirm email 没关；② Email Provider 未启用；③ 登录名与开户时不一致；④ 密码不足 6 位 |
| `email_address_invalid` | supabase.com 发验证邮件时校验了伪邮箱域名 → 关闭 Confirm email；或把 `AUTH_DOMAIN` 改成有 MX 记录的域名后重建账号 |
| 提示「未找到用户档案」 | 第 3 步 SQL 没执行 → 重跑 `supabase_schema.sql` |
| 选「过户中 / 待放款」保存报 `violates check constraint "records_progress_ck"` | 库的 CHECK 约束还是旧 6 档 → 执行一次 `supabase_patch_progress.sql`；**重跑主脚本无效**（`IF NOT EXISTS` 不改已有表约束） |
| 客户经理点「删除」报 `permission denied` / `row-level security` / 删了没变化 | 早期建库脚本没有 `records_manager_delete` 策略 → SQL Editor 执行一次 `supabase_patch_delete.sql`；可先 `select policyname, cmd from pg_policies where tablename='records';` 核对 |
| 新增渠道报 `permission denied` / `new row violates row-level security` | 当前登录账号不是管理员；`channels` 表 RLS 只允许 admin 写入 |
| 渠道用户 / 客户经理看不到数据 | `profiles.channel` 与 `records.channel`、`profiles.manager_name` 与 `records.manager_name` 必须**完全一致**（含空格/全角）；SQL Editor 查 `select * from public.profiles;` |
| `User already registered` | 该手机号已注册过；换号，或到 Authentication → Users 删掉旧用户后重试 |
| 点「新增签单 / 新增渠道 / 新增客户经理 / 新增渠道用户」**没反应、不弹窗** | ① 浏览器缓存了旧 JS → **Ctrl+F5 硬刷新**；② 切到 DevTools **Console** 看红色报错（Elements 面板看不到 JS 错误）；③ 确认页面顶部有「统计区间」条（说明加载的是最新 `app.js`）；④ 早期版本有弹窗 `display` 回落 bug，已修复，重新取最新文件即可 |
| 看不到「列表排序」条 / 点排序按钮没反应 | 浏览器缓存了旧 `index.html` / `app.js` → **Ctrl+F5 硬刷新**；排序条应紧跟在筛选工具条下方，右侧有当前规则灰字 |
| 没填签约日期的单子跑到列表最前面 | 早期版本直接用了数据库 `ORDER BY sign_date DESC`（Postgres 默认 NULLS FIRST）。新版已在客户端把空日期恒排末尾 → Ctrl+F5 硬刷新 |
| 点 × / 取消 / 弹窗外遮罩，填的内容还是直接没了、没有确认框 | 加载的还是旧 `app.js` → **Ctrl+F5 硬刷新**；确认层是独立弹层，标题为「⚠ 还有未保存的内容」 |
| 一打开新增签单，什么都没填，点取消却弹「未保存」 | 说明基线快照被污染（旧版 JS 或浏览器插件自动填充）。Ctrl+F5 后用无痕窗口复核；只读的「业务编号」自动取号按设计不算改动 |
| 草稿恢复不了 / 串到别的单子 | 草稿只存在当前页面内存，**刷新页面就没了**，这是设计如此；新增签单与每条编辑单各用独立键，不会串单 |
| 弹窗能打开但点「保存」报 `signup is disabled` / `email_address_invalid` | Authentication → Sign In / Providers → Email：`Allow new users to sign up` 要**开启**、`Confirm email` 要**关闭** |
| 管理员点完开户后自己掉线 | 已用独立客户端 + `setSession` 恢复；若仍发生，重新登录一次即可 |
| 数据全部人都能看 | RLS 没启用 → 重跑 `supabase_schema.sql` 第 8 段；`select relname, relrowsecurity from pg_class where relname='records';` 检查 |
| 新增签单里「业务编号」是灰的、显示「生成中…」 | 正常，编号由系统生成**不用手输**；取号时「保存」会短暂禁用，通常不到 1 秒 |
| 提示「当前库尚未启用服务端自动编号」 | 还没执行 `supabase_patch_biz_no.sql`。前端已降级可用，但多人同天录入易重号 → SQL Editor 执行一次补丁后 Ctrl+F5 |
| 保存报 `duplicate key ... records_biz_no_uq` / 编号重复 | 同上：本地降级算号撞车。执行 `supabase_patch_biz_no.sql`，再重新打开新增弹窗取号 |
| 新增弹窗一直「生成中…」、保存按钮一直灰 | ① 免费项目被暂停 → Dashboard 点 Restore；② 网络异常 → 刷新页面；③ 执行 `supabase_patch_biz_no.sql` 后 Ctrl+F5 硬刷新 |
| 点「重置为 888888」报 `could not find the function public.admin_reset_password` / `schema cache` | 没执行 `supabase_patch_password.sql` → SQL Editor 整段跑一次（幂等），然后刷新页面。全新空库跑主脚本即可 |
| 重置密码报 `permission denied for function` / `只有主管可以重置他人密码` | 当前登录账号不是 `admin`；或函数权限被改过 → 重跑 `supabase_patch_password.sql` 恢复 `grant execute to authenticated` |
| 重置密码报 `缺少 pgcrypto 扩展` | 执行 `create extension if not exists pgcrypto with schema extensions;` 后重试（函数会自动定位所在 schema） |
| 自己想改密码但列表里没有「重置」按钮 | 设计如此：本人请用顶部「修改密码」，函数也会拒绝重置自己 |
| 界面还是旧样子 / 「修改密码」「账号管理」按钮不出现 | 浏览器缓存 → **Ctrl+F5 硬刷新**；`index.html` 里脚本已带 `app.js?v=20261114c` 强制拉新脚本，两个文件要一起覆盖 |
| 想把业务编号改成自己编的号 | 不支持。编号是一笔业务的身份且要防重号，编辑时只读；确需修正历史编号，由管理员在 SQL Editor 手工 `update public.records set biz_no='...' where id=...`（别改成与其它行重复的号） |
| Excel 版改了「签约日期」后编号变了 / 感觉重号 | 表格版 B 列是公式，会按新日期重新取号；请核对是否与其他行重号。Web 版编号入库后固定不变，无此问题 |

---

## 十、与 Excel / WPS 在线台账的关系

- `客户汇总清单台账.xlsx` 是**表格版**（数据看板 + 主表 + 配置字典 + 使用说明），可直接挂 WPS 在线表格；
- 本目录是**自建 Web 版**，字段、下拉选项、样例数据与 xlsx 完全一致；
- 前端「导出 CSV」可把**当前统计区间内**的数据导回 Excel；两边靠 `业务编号` 对齐。
- 两边都支持按月份 / 日期区间看数据：Web 版用顶部「统计区间」条，xlsx 版用「数据看板」`B2` 月份下拉或 `D2`/`E2` 起止日期。
- 两边都能按「签约时间优先 / 渠道优先」排序：Web 版用明细表上方的「列表排序」按钮（含第二排序要素与方向切换），xlsx 版用主表列箭头或「数据 → 排序」两级条件（见「使用说明」第十节）。两边排序互不写回。
- 两边**业务编号规则一致**（`Z + 签约日期YYMMDD + 当日流水`，历史尾号不重编）：Web 版由数据库原子分配后写入，xlsx 版 B 列第 8 行起为自动公式，都不用手输。差异：Web 版编号生成后固定不变，表格版改签约日期会重算，需留意重号。

---

## 十一、安全须知

- `Publishable key` / `anon key` 可以放前端，但**所有表必须开 RLS**（脚本已开），密钥本身不是权限边界。
- `sb_secret_...` / `service_role` 只在服务端使用，绝不写入 `config.js`。主管重置密码刻意不用 `auth.admin.*`，就是为了不把这把钥匙放进公开网页（见 4.4 节）。
- `admin_reset_password()` 是 `SECURITY DEFINER`，所以额外做了四道校验并只授予 `authenticated`；`anon` 无权调用，SQL Editor 里匿名直调也会被 `auth.uid() is null` 拒绝。不要给它加 `security invoker`，也不要改成接受任意密码参数。
- 初始密码 `888888` 是弱密码，只适合「重置后由本人立刻改掉」的短时状态；账号列表请只对主管开放。
- 免费版项目长期不访问会暂停，正式使用建议升级套餐或保持定期访问。
- 全员开户完成后，如需进一步收紧，可在 Authentication 关闭公开注册，之后由管理员用服务端密钥建号。**注意**：关闭后前端工具栏的「＋ 新增客户经理 / ＋ 新增渠道用户」会一并失效（它们依赖 `signUp`），只适合人员固定、不再开新号的情况。
