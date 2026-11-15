/* =============================================================================
 * 客户汇总清单台账 · 三角色前端（官方 supabase.com）
 * channel 渠道用户 : 按「渠道」列只读
 * manager 客户经理 : 按「客户经理」列读写本人签单，客户经理/录入人锁为本人
 * admin   管理员   : 全量 + 按渠道筛选 + 新增渠道 / 客户经理 / 渠道用户
 * 纯静态，无构建；依赖同目录 vendor/supabase-js.umd.min.js
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = window.SUPABASE_CONFIG || {};

  // ---- 自动适配官方 supabase.com --------------------------------------------
  // URL 容错：可填 https://xxx.supabase.co，也可只填 xxx.supabase.co；去尾斜杠。
  function normUrl(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }
  var API_URL = normUrl(CFG.URL);
  var PROJECT_REF = (function () {
    var m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co$/i.exec(API_URL);
    return m ? m[1] : '';
  })();
  // 登录名映射用的域名：新配置 AUTH_DOMAIN，兼容旧配置 PHONE_DOMAIN
  var AUTH_DOMAIN = CFG.AUTH_DOMAIN || CFG.PHONE_DOMAIN || 'ledger.example.com';

  var db = null;        // 主客户端（当前登录会话）
  var signupDb = null;  // 开户专用客户端，独立 storage，避免顶掉管理员会话
  var me = null;        // 当前 auth user
  var profile = null;   // profiles 行
  var channels = [];    // 渠道名单（从 channels 表动态读取，管理员可新增）
  var managers = [];    // 客户经理名单
  var rows = [];        // 服务端返回的行（已应用角色/渠道/进度/结账/搜索，未应用时间）
  var viewRows = [];    // 再应用「统计区间」后的行：KPI / 明细 / 导出统一以此为准

  // 统计区间：all=全部时间 | preset=快捷区间 | months=勾选月份(可跨年多选) | range=自定义起止
  var period = { kind: 'all' };
  var draftMonths = []; // 月份面板里的临时勾选（点「应用」才生效）
  var popTab = 'months';

  // 明细排序：date = 签约时间优先（次：渠道）；channel = 渠道优先（次：时间）
  var sortMode = 'date';
  var sortTimeDesc = true;   // 签约时间方向：true 新→旧（与旧版默认一致）

  // ---- 14 个业务字段，与 Excel 除「序号」外的列一一对应（已取消贷款银行）------
  var COLUMNS = [
    { k: 'biz_no',           n: '业务编号' },
    { k: 'sign_date',        n: '签约日期' },
    { k: 'channel',          n: '渠道' },
    { k: 'customer_name',    n: '客户姓名' },
    { k: 'property_address', n: '物业地址', wide: true },
    { k: 'contract_amount',  n: '合同总价(万)', num: true },
    { k: 'loan_type',        n: '贷款类型' },
    { k: 'loan_amount',      n: '贷款金额(万)', num: true },
    { k: 'manager_name',     n: '客户经理' },
    { k: 'progress',         n: '当前进度', kind: 'progress' },
    { k: 'missing_docs',     n: '缺件清单', wide: true },
    { k: 'settle_status',    n: '结账状态', kind: 'settle' },
    { k: 'created_by',       n: '录入人' },
    { k: 'remark',           n: '备注', wide: true }
  ];

  // ---- 与 Excel「配置字典」完全一致 ----------------------------------------
  // 渠道：由 channels 表动态读取，管理员随时可新增（不写死）。
  // 客户经理：默认 4 人候选；管理员仍可在前端手填新姓名新增客户经理。
  var OPTIONS = {
    loan_type:     ['商业', '公积金', '组合贷', '全款', '其他'],
    manager_name:  ['何燕', '孔得杨', '梁雄凯', '王迎佳'],
    // 7 档按业务流程排列；原「已结案」已并入「已放款」
    progress:      ['待补充资料', '查房', '审批中', '过户中', '待放款', '已放款', '已终止'],
    settle_status: ['未结账', '已结账']
  };

  var ROLE_LABEL = { channel: '渠道用户', manager: '客户经理', admin: '管理员' };

  // ---------------------------------------------------------------- 工具函数
  function $(sel) { return document.querySelector(sel); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function phoneOk(p) { return /^1[3-9]\d{9}$/.test(String(p || '').trim()); }
  function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

  // 登录名自动适配 Supabase Auth：手机号 / 用户名 / 邮箱 都能登录
  function loginNameOk(s) {
    s = String(s || '').trim();
    if (!s) return false;
    if (isEmail(s)) return true;                              // 邮箱账号原样使用
    return phoneOk(s) || /^[A-Za-z0-9_.-]{2,32}$/.test(s);  // 手机号或用户名
  }
  function authEmail(loginName) {
    var s = String(loginName || '').trim();
    if (!s) return '';
    if (isEmail(s)) return s.toLowerCase();                  // Dashboard 手工建的账号
    return s.replace(/\s+/g, '') + '@' + AUTH_DOMAIN;        // 自动映射为伪邮箱
  }

  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'ok');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = 'toast'; }, 4200);
  }
  function netHint(err) {
    var m = (err && err.message) || String(err || '');
    if (/email_address_invalid|email address .*invalid/i.test(m)) {
      return m + ' ｜ supabase.com：到 Authentication → Sign In / Providers → Email 关闭 Confirm email；或把 config.js 的 AUTH_DOMAIN 改成有 MX 记录的域名后重建账号。';
    }
    if (/invalid login credentials/i.test(m)) {
      return m + ' ｜ 登录名需与开户时一致（手机号自动映射为 Supabase 邮箱账号）；并确认 Email Provider 已启用、Confirm email 已关闭。';
    }
    if (/records_progress_ck|check constraint/i.test(m)) {
      return m + ' ｜ 当前进度选了「过户中」或「待放款」，但数据库的 CHECK 约束还是旧 6 档：请在 Supabase → SQL Editor 整段执行一次 supabase_patch_progress.sql（幂等），执行完直接重新点「保存」即可，不用刷新页面。';
    }
    if (/admin_reset_password|could not find the function|schema cache|PGRST202/i.test(m)) {
      return m + ' ｜「重置密码」依赖数据库函数 public.admin_reset_password：请在 Supabase → SQL Editor 整段执行一次 supabase_patch_password.sql（幂等，只加函数、不动数据），执行后刷新页面再试。';
    }
    if (/weak_password|weak password|password.*(too short|at least|6 char)/i.test(m)) {
      return m + ' ｜ 新密码至少 6 位；若刚被主管重置过，初始密码是 888888。';
    }
    if (/fetch|network|timeout|failed/i.test(m)) {
      return m + ' ｜ supabase.com 排查：① 免费项目是否被自动暂停（Dashboard 里点 Restore）；② URL 应为 https://<项目ID>.supabase.co，不是控制台网页地址；③ 浏览器能否访问该域名；④ 本平台没有 IP 白名单。';
    }
    return m;
  }
  // ------------------------------------------------------- 统计区间（时间筛选）
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10)); }
  function day(s) { return String(s || '').slice(0, 10); }
  function prettyMonth(k) { var p = k.split('-'); return p[0] + '年' + Number(p[1]) + '月'; }

  // 快捷区间：本月 / 上月 / 近 3 个月（本月含在内）/ 今年
  function presetRange(p) {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth();
    if (p === 'thisMonth') return { from: ymd(new Date(y, m, 1)),     to: ymd(new Date(y, m + 1, 0)) };
    if (p === 'lastMonth') return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    if (p === 'last3')     return { from: ymd(new Date(y, m - 2, 1)), to: ymd(new Date(y, m + 1, 0)) };
    if (p === 'thisYear')  return { from: y + '-01-01',               to: y + '-12-31' };
    return null;
  }
  var PRESET_LABEL = { thisMonth: '本月', lastMonth: '上月', last3: '近 3 个月', thisYear: '今年' };

  // 单条签单是否落在当前统计区间内
  function inPeriod(dateVal) {
    if (period.kind === 'all') return true;              // 全部时间：含未填签约日期的行
    var d = day(dateVal);
    if (!isDay(d)) return false;                        // 启用筛选后，未填日期的行不计入
    if (period.kind === 'months') return period.months.indexOf(d.slice(0, 7)) >= 0;
    var rg = period.kind === 'preset' ? presetRange(period.preset) : { from: period.from, to: period.to };
    if (!rg) return true;
    return (!rg.from || d >= rg.from) && (!rg.to || d <= rg.to);   // ISO 日期字符串可直接比较
  }

  function periodLabel() {
    if (period.kind === 'all') return '全部时间';
    if (period.kind === 'preset') return PRESET_LABEL[period.preset] || '自定义';
    if (period.kind === 'months') {
      var a = (period.months || []).slice().sort();
      if (!a.length) return '全部时间';
      if (a.length === 1) return prettyMonth(a[0]);
      return prettyMonth(a[a.length - 1]) + ' 等 ' + a.length + ' 个月';
    }
    return (period.from || '最早') + ' ~ ' + (period.to || '至今');
  }

  function refreshView() {
    viewRows = sortView(rows.filter(function (x) { return inPeriod(x.sign_date); }));
    renderKpi();
    renderTable();
    renderPeriodBar();
    renderSortBar();
  }

  // ---- 明细排序 --------------------------------------------------------------
  // date    : 主「签约日期」(默认新→旧) → 次「渠道名称」(A→Z) → 业务编号 → id
  // channel : 主「渠道名称」(A→Z) → 次「签约日期」(默认新→旧) → 业务编号 → id
  // 未填签约日期的行恒排末尾（渠道优先时排在该渠道末尾）。Postgres 的
  // ORDER BY ... DESC 默认 NULLS FIRST，会把没填日期的行顶到最前面，这里统一纠正。
  var SORT_HINT = {
    dateDesc:    '当前：签约日期 新→旧，同一天按渠道名称；未填日期排最后',
    dateAsc:     '当前：签约日期 旧→新，同一天按渠道名称；未填日期排最后',
    channelDesc: '当前：渠道名称 A→Z，同一渠道内签约日期 新→旧；未填日期排最后',
    channelAsc:  '当前：渠道名称 A→Z，同一渠道内签约日期 旧→新；未填日期排最后'
  };
  function cmpStr(a, b) {
    var x = String(a === null || a === undefined ? '' : a);
    var y = String(b === null || b === undefined ? '' : b);
    try { return x.localeCompare(y, 'zh-Hans-CN'); }
    catch (e) { return x < y ? -1 : (x > y ? 1 : 0); }
  }
  function sortView(list) {
    var desc = sortTimeDesc, mode = sortMode;
    return list.slice().sort(function (a, b) {
      var ta = day(a.sign_date), tb = day(b.sign_date);
      var ha = isDay(ta), hb = isDay(tb);
      var ch = cmpStr(a.channel, b.channel);
      var tm = cmpStr(ta, tb);
      var c;
      if (mode === 'channel') {
        if (ch) return ch;                          // 主：先按渠道分组
        if (ha !== hb) return ha ? -1 : 1;          // 同渠道内：无日期排最后
        if (ha && tm) return desc ? -tm : tm;       // 次：签约时间
      } else {
        if (ha !== hb) return ha ? -1 : 1;          // 全局：无日期排最后
        if (ha && tm) return desc ? -tm : tm;       // 主：签约时间
        if (ch) return ch;                          // 次：渠道名称
      }
      c = cmpStr(a.biz_no, b.biz_no);               // 三级：编号，保证同日同渠道也稳定
      if (c) return c;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }
  function renderSortBar() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
      b.className = 'chip' + (b.getAttribute('data-sort') === sortMode ? ' on' : '');
    });
    var dir = $('#btnSortDir');
    if (dir) dir.textContent = sortTimeDesc ? '时间：新 → 旧' : '时间：旧 → 新';
    var hint = $('#sortHint');
    if (hint) hint.textContent = SORT_HINT[sortMode + (sortTimeDesc ? 'Desc' : 'Asc')];
  }

  function renderPeriodBar() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (b) {
      var p = b.getAttribute('data-preset');
      var on = (period.kind === 'all' && p === 'all') || (period.kind === 'preset' && p === period.preset);
      b.className = 'chip' + (on ? ' on' : '');
    });
    var extra = '';
    if (period.kind !== 'all') {
      var nd = rows.filter(function (x) { return !isDay(x.sign_date); }).length;
      if (nd) extra = ' · 另有 ' + nd + ' 条未填签约日期未计入';
    }
    var el = $('#periodCur');
    if (el) el.innerHTML = '当前：<b>' + esc(periodLabel()) + '</b> · 命中 ' + viewRows.length + ' 条' + esc(extra);
  }

  // 月份候选：当前条件下有数据的月份 + 最近 12 个月（保证常用月份永远在，不会越选越少）
  function monthCandidates() {
    var counts = {}, keys = [];
    rows.forEach(function (x) {
      var d = day(x.sign_date);
      if (isDay(d)) {
        var k = d.slice(0, 7);
        if (!counts[k]) { counts[k] = 0; keys.push(k); }
        counts[k]++;
      }
    });
    var base = new Date();
    for (var i = 0; i < 12; i++) {
      var k2 = monthKey(new Date(base.getFullYear(), base.getMonth() - i, 1));
      if (keys.indexOf(k2) < 0) keys.push(k2);
    }
    return { keys: keys.sort().reverse(), counts: counts };
  }

  function renderMonthPanel(sel) {
    var c = monthCandidates();
    var groups = {}, order = [];
    c.keys.forEach(function (k) {
      var y = k.slice(0, 4);
      if (!groups[y]) { groups[y] = []; order.push(y); }
      groups[y].push(k);
    });
    var h = '';
    order.forEach(function (y) {
      h += '<div class="yr">' + esc(y) + ' 年' +
           '<button data-year="' + esc(y) + '">全选本年</button>' +
           '<button data-year-clear="' + esc(y) + '">清空</button></div><div class="mgrid">';
      groups[y].forEach(function (k) {
        var n = c.counts[k] || 0;
        h += '<div class="mcell' + (sel.indexOf(k) >= 0 ? ' on' : '') + (n ? '' : ' zero') +
             '" data-mk="' + esc(k) + '">' + Number(k.slice(5)) + '月<span class="n">' + (n || '–') + '</span></div>';
      });
      h += '</div>';
    });
    var box = $('#monthGroups');
    if (!box) return;
    box.innerHTML = h || '<div class="muted small">当前条件下暂无带签约日期的数据</div>';
    var hint = $('#monthHint');
    if (hint) hint.textContent = '灰色月份表示当前条件下没有签单；点击格子勾选/取消，可跨年多选。';
    Array.prototype.forEach.call(box.querySelectorAll('.mcell'), function (el) {
      el.onclick = function () {
        var k = el.getAttribute('data-mk'), i = sel.indexOf(k);
        if (i >= 0) sel.splice(i, 1); else sel.push(k);
        renderMonthPanel(sel);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-year]'), function (el) {
      el.onclick = function () {
        var y = el.getAttribute('data-year');
        groups[y].forEach(function (k) { if (sel.indexOf(k) < 0) sel.push(k); });
        renderMonthPanel(sel);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-year-clear]'), function (el) {
      el.onclick = function () {
        var y = el.getAttribute('data-year-clear');
        for (var i = sel.length - 1; i >= 0; i--) if (sel[i].slice(0, 4) === y) sel.splice(i, 1);
        renderMonthPanel(sel);
      };
    });
  }

  function renderRangeQuick() {
    var box = $('#rangeQuick');
    if (!box) return;
    var t = new Date();
    var list = [
      ['本月', presetRange('thisMonth')],
      ['上月', presetRange('lastMonth')],
      ['近 3 个月', presetRange('last3')],
      ['今年', presetRange('thisYear')],
      ['近 30 天', { from: ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29)), to: ymd(t) }]
    ];
    box.innerHTML = '';
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'chip'; b.textContent = it[0];
      b.onclick = function () { $('#rangeFrom').value = it[1].from; $('#rangeTo').value = it[1].to; };
      box.appendChild(b);
    });
  }

  function switchPopTab(tab) {
    popTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.className = 'ptab' + (b.getAttribute('data-tab') === tab ? ' on' : '');
    });
    $('#tabMonths').style.display = tab === 'months' ? 'block' : 'none';
    $('#tabRange').style.display = tab === 'range' ? 'block' : 'none';
  }

  function openPop(tab, btn) {
    var pop = $('#periodPop');
    draftMonths = period.kind === 'months' ? period.months.slice() : [];
    if (period.kind === 'range') { $('#rangeFrom').value = period.from || ''; $('#rangeTo').value = period.to || ''; }
    else { $('#rangeFrom').value = ''; $('#rangeTo').value = ''; }
    renderMonthPanel(draftMonths);
    renderRangeQuick();
    switchPopTab(tab);
    // 面板锚在被点击的按钮下方，避免总是弹在最左边
    var bar = $('#periodBar');
    var left = btn && bar ? Math.max(0, Math.min(btn.offsetLeft || 0, (bar.clientWidth || 0) - 450)) : 0;
    pop.style.left = left + 'px';
    pop.className = 'pop show';
    $('#btnMonths').className = 'pbtn' + (tab === 'months' ? ' on' : '');
    $('#btnRange').className = 'pbtn' + (tab === 'range' ? ' on' : '');
  }
  function closePop() {
    var pop = $('#periodPop');
    if (pop) pop.className = 'pop';
    ['#btnMonths', '#btnRange'].forEach(function (s) { if ($(s)) $(s).className = 'pbtn'; });
  }
  function setAll() { period = { kind: 'all' }; closePop(); refreshView(); }
  function applyPeriod() {
    if (popTab === 'months') {
      if (!draftMonths.length) return setAll();
      period = { kind: 'months', months: draftMonths.slice() };
    } else {
      var f = $('#rangeFrom').value, t = $('#rangeTo').value;
      if (!f && !t) return setAll();
      if (f && t && f > t) return toast('起始日期不能晚于结束日期', 'err');
      period = { kind: 'range', from: f, to: t };
    }
    closePop();
    refreshView();
  }

  function opts(list, cur, placeholder) {
    var s = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
    (list || []).forEach(function (v) {
      s += '<option value="' + esc(v) + '"' + (String(cur || '') === String(v) ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    return s;
  }
  function fld(label, input, hint) {
    return '<label class="fld"><span>' + esc(label) + '</span>' + input +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  }
  function inp(id, val, type, extra) {
    return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val === undefined || val === null ? '' : val) + '" ' + (extra || '') + '>';
  }

  // ------------------------------------------------- 业务编号（系统自动生成）
  // 规则：Z + 签约日期(YYMMDD) + 当日流水（2 位起，超过 99 自动升 3 位）
  //   2026-11-14 第 1 单 = Z26111401；2026-11-10 已有 Z26111001，下一单 = Z26111002
  // 号由数据库 public.alloc_biz_no() 原子分配，前端只负责显示成只读框：
  // 客户经理受 RLS 限制看不到别人的单，前端自己算号必然重号；并发录入同理。
  // 老库没跑过补丁时退化成本地推导，并提示去执行 supabase_patch_biz_no.sql。
  var bizNoRpcFailed = false;

  function bizPrefix(dateStr) {
    var d = isDay(dateStr) ? day(dateStr) : ymd(new Date());
    return 'Z' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  }
  function padSeq(n) { return (n < 10 ? '0' : '') + n; }
  function localBizNo(dateStr) {
    var pre = bizPrefix(dateStr), mx = 0;
    rows.forEach(function (x) {
      var s = String(x.biz_no || '');
      if (s.indexOf(pre) === 0 && /^\d+$/.test(s.slice(pre.length))) {
        mx = Math.max(mx, Number(s.slice(pre.length)));
      }
    });
    return pre + padSeq(mx + 1);
  }
  async function allocBizNo(dateStr) {
    var d = isDay(dateStr) ? day(dateStr) : null;
    if (db && typeof db.rpc === 'function') {
      try {
        var r = await db.rpc('alloc_biz_no', { p_day: d });
        if (r && !r.error && typeof r.data === 'string' && /^Z\d{8,}$/.test(r.data)) return r.data;
      } catch (e) { /* 函数不存在 / 网络异常 -> 走降级 */ }
    }
    bizNoRpcFailed = true;
    return localBizNo(dateStr);
  }
  function bizNoHint() {
    return bizNoRpcFailed
      ? ' ｜ 当前库尚未启用服务端自动编号，建议在 SQL Editor 执行一次 supabase_patch_biz_no.sql'
      : '';
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    var info = $('#projInfo');
    if (!CFG.URL || !CFG.ANON_KEY) {
      $('#loginBox').innerHTML =
        '<div class="warn"><b>还没有配置 Supabase 连接</b><br>请打开 <code>frontend/config.js</code>，' +
        '填入 <b>supabase.com</b> 项目的 <code>URL</code> 与 <code>ANON_KEY</code>' +
        '（Project Settings → API Keys 里的 <b>Publishable key</b>）后刷新页面。<br>' +
        '步骤见 <code>frontend/README.md</code> 第 3 步。</div>';
      if (info) info.textContent = '未配置连接 · 官方 supabase.com';
      return;
    }
    if (/^sb_secret_/i.test(CFG.ANON_KEY) || /service_role/i.test(CFG.ANON_KEY)) {
      $('#loginBox').innerHTML =
        '<div class="warn"><b>密钥类型填错了</b><br>这里只能用 <code>sb_publishable_...</code> 或旧版 <code>anon</code> key。' +
        '<code>sb_secret_... / service_role</code> 会绕过 RLS，绝不能放进前端。</div>';
      if (info) info.textContent = '密钥类型错误';
      return;
    }
    if (/supabase\.com\/dashboard/i.test(API_URL)) {
      $('#loginBox').innerHTML =
        '<div class="warn"><b>URL 填错了</b><br>要填 <b>Project URL</b>（<code>https://&lt;项目ID&gt;.supabase.co</code>），' +
        '不是 Dashboard 网页地址。Project Settings → API 里可复制。</div>';
      if (info) info.textContent = '请改用 Project URL';
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      $('#loginBox').innerHTML = '<div class="warn"><b>supabase-js 未加载</b><br>请确认 <code>frontend/vendor/supabase-js.umd.min.js</code> 与页面在同一目录，或改用本地 HTTP 服务打开。</div>';
      return;
    }
    if (info) {
      info.textContent = PROJECT_REF
        ? '已连接 supabase.com 项目：' + PROJECT_REF
        : '已连接：' + API_URL;
    }
    var common = { auth: { detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'ledger-main' } };
    db = window.supabase.createClient(API_URL, CFG.ANON_KEY, common);
    signupDb = window.supabase.createClient(API_URL, CFG.ANON_KEY, {
      auth: { detectSessionInUrl: false, persistSession: false, autoRefreshToken: false, storageKey: 'ledger-signup-temp' }
    });

    db.auth.getSession().then(function (r) {
      if (r.data && r.data.session) return afterLogin(r.data.session.user);
      showLogin();
    }).catch(function (e) { toast(netHint(e), 'err'); showLogin(); });

    db.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT') { me = null; profile = null; showLogin(); }
    });
  }

  function showLogin() {
    $('#loginView').style.display = 'flex';
    $('#appView').style.display = 'none';
  }

  // ---------------------------------------------------------------- 登录
  // 安全：本文件不提供任何「自助注册 / 自助创建管理员」能力。
  // 公开页面不能留可自我提权的入口；首个管理员只能在 Supabase Dashboard 手工创建，
  // 之后日常开账号由管理员登录后走 createAccount()（先写 user_invites 白名单再 signUp）。
  async function doLogin() {
    var name = $('#loginPhone').value.trim();
    var pw = $('#loginPw').value;
    if (!loginNameOk(name)) return toast('请输入 11 位手机号、邮箱或用户名', 'err');
    if (!pw) return toast('请输入密码', 'err');
    $('#btnLogin').disabled = true;
    var r = await db.auth.signInWithPassword({ email: authEmail(name), password: pw });
    $('#btnLogin').disabled = false;
    if (r.error) return toast(netHint(r.error), 'err');
    await afterLogin(r.data.user);
  }

  async function afterLogin(user) {
    me = user;
    var p = await db.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (p.error) { toast('读取用户档案失败：' + netHint(p.error), 'err'); return; }
    if (!p.data) {
      toast('未找到用户档案，请确认已在 SQL Editor 执行 supabase_schema.sql', 'err');
      await db.auth.signOut();
      return;
    }
    profile = p.data;
    $('#loginView').style.display = 'none';
    $('#appView').style.display = 'block';
    renderShell();
    await Promise.all([loadChannels(), loadManagers()]);
    await loadRecords();
  }

  function renderShell() {
    var who = profile.display_name || profile.phone || '未命名';
    var bind = profile.role === 'channel' ? ('绑定渠道：' + (profile.channel || '（未绑定，看不到数据）'))
             : profile.role === 'manager' ? ('绑定经理：' + (profile.manager_name || '（未绑定，看不到数据）'))
             : '全部数据';
    $('#who').innerHTML = '<b>' + esc(who) + '</b> <span class="badge r-' + esc(profile.role) + '">' +
      esc(ROLE_LABEL[profile.role] || profile.role) + '</span> <span class="muted">' + esc(bind) + '</span>';

    var isAdmin = profile.role === 'admin';
    var isManager = profile.role === 'manager';
    $('#adminBtns').style.display = isAdmin ? 'inline' : 'none';
    // 新增节点做空值保护：只更新了 app.js、页面还是旧版时不会整段报错
    var accountsBtn = $('#btnAccounts');
    if (accountsBtn) accountsBtn.style.display = isAdmin ? 'inline-block' : 'none';
    $('#btnNewRecord').style.display = (isAdmin || isManager) ? 'inline-block' : 'none';
    $('#chanWrap').style.display = isAdmin ? 'flex' : 'none';
    $('#readOnlyTip').style.display = profile.role === 'channel' ? 'block' : 'none';
    if ($('#chanFilter') && !$('#chanFilter').value) {
      $('#chanFilter').innerHTML = opts(channels, '', '全部渠道');
    }
  }

  // ---------------------------------------------------------------- 载入数据
  async function loadChannels() {
    var r = await db.from('channels').select('name').order('id');
    if (r.error) { toast('读取渠道失败：' + netHint(r.error), 'err'); return; }
    channels = (r.data || []).map(function (x) { return x.name; });
    var sel = $('#chanFilter');
    var cur = sel.value;
    sel.innerHTML = opts(channels, cur, '全部渠道');
    var dl = $('#channelList');
    if (dl) dl.innerHTML = channels.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
  }

  async function loadManagers() {
    // 默认 4 人候选 + 数据库里管理员已新增的经理，去重后作为下拉建议
    managers = OPTIONS.manager_name.slice();
    if (profile.role === 'admin') {
      var r = await db.from('profiles').select('manager_name').eq('role', 'manager');
      if (!r.error && Array.isArray(r.data)) {
        r.data.forEach(function (x) {
          if (x.manager_name && managers.indexOf(x.manager_name) < 0) managers.push(x.manager_name);
        });
      }
    }
    var dl = $('#managerList');
    if (dl) dl.innerHTML = managers.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('');
  }

  async function loadRecords() {
    // 服务端给个稳定初始序即可；最终展示顺序由 sortView() 按「列表排序」按钮决定
    var q = db.from('records').select('*').order('sign_date', { ascending: false }).order('id', { ascending: false });

    // 前端再按字段过滤一次（纵深防御；真正的边界由数据库 RLS 保证）
    if (profile.role === 'channel') q = q.eq('channel', profile.channel || '__none__');
    if (profile.role === 'manager') q = q.eq('manager_name', profile.manager_name || '__none__');
    if (profile.role === 'admin' && $('#chanFilter').value) q = q.eq('channel', $('#chanFilter').value);
    var prog = $('#filterProgress').value;
    if (prog) q = q.eq('progress', prog);
    var settle = $('#filterSettle').value;
    if (settle) q = q.eq('settle_status', settle);
    // PostgREST 的 or() 里逗号/括号/引号是语法字符，需先剔除
    var kw = $('#filterKw').value.trim().replace(/[(),'"\\]/g, '').slice(0, 40);
    if (kw) q = q.or('biz_no.ilike.%' + kw + '%,customer_name.ilike.%' + kw + '%,property_address.ilike.%' + kw + '%');

    var r = await q.limit(2000);
    if (r.error) { toast('读取台账失败：' + netHint(r.error), 'err'); return; }
    rows = r.data || [];
    refreshView();   // KPI / 明细 / 导出统一按「统计区间」重新计算
  }

  function renderKpi() {
    var total = viewRows.length;
    var contract = viewRows.reduce(function (s, x) { return s + (Number(x.contract_amount) || 0); }, 0);
    var loan = viewRows.reduce(function (s, x) { return s + (Number(x.loan_amount) || 0); }, 0);
    var settled = viewRows.filter(function (x) { return x.settle_status === '已结账'; }).length;
    var items = [
      ['业务总数', total + ' 单'],
      ['合同总价(万)', contract.toFixed(2)],
      ['贷款金额(万)', loan.toFixed(2)],
      ['已结账', settled + ' 单'],
      ['未结账', (total - settled) + ' 单']
    ];
    $('#kpi').innerHTML = items.map(function (it) {
      return '<div class="card"><span>' + esc(it[0]) + '</span><b>' + esc(it[1]) + '</b></div>';
    }).join('');
  }

  function cellClass(col, v) {
    if (col.kind === 'progress') {
      return { '待补充资料': 'st-red', '查房': 'st-yellow', '审批中': 'st-yellow2',
               '过户中': 'st-purple', '待放款': 'st-blue',
               '已放款': 'st-green', '已终止': 'st-grey' }[v] || '';
    }
    if (col.kind === 'settle') {
      return v === '已结账' ? 'st-green' : (v === '未结账' ? 'st-red' : '');
    }
    return '';
  }

  function renderTable() {
    var canEdit = profile.role === 'admin' || profile.role === 'manager';
    var isMobile = (typeof window.matchMedia === 'function') && window.matchMedia('(max-width:768px)').matches;
    // 手机端列序：业务编号从第一列挪到操作列前；客户姓名加 pin-l 固定在左（CSS 生效）。
    // PC 端永远走 COLUMNS 原始顺序，渲染结果与旧版逐像素一致。
    var cols = COLUMNS.slice();
    if (isMobile) {
      cols = cols.filter(function (c) { return c.k !== 'biz_no'; });
      cols.push(COLUMNS[0]);   // COLUMNS[0] = 业务编号，紧挨「操作」列
    }
    var pinCls = function (c) { return isMobile && c.k === 'customer_name' ? 'pin-l ' : ''; };
    var head = cols.map(function (c) {
      return '<th class="' + pinCls(c) + '">' + esc(c.n) + '</th>';
    }).join('') +
      (canEdit ? '<th id="thAction">操作</th>' : '');
    var body = viewRows.map(function (row) {
      var tds = cols.map(function (c) {
        var v = row[c.k];
        var txt = c.num && v !== null && v !== undefined ? Number(v).toFixed(2) : (v === null || v === undefined ? '' : v);
        return '<td class="' + pinCls(c) + (c.wide ? 'wide ' : '') + (c.num ? 'num ' : '') + cellClass(c, v) + '">' + esc(txt) + '</td>';
      }).join('');
      if (canEdit) {
        tds += isMobile
          // 手机端：操作列只留 ✏️ 图标；删除入口移入编辑弹窗左下角（强确认），防误触
          ? '<td class="act"><button class="mini iconbtn" data-edit="' + row.id + '" aria-label="编辑" title="编辑">' +
            '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></td>'
          : '<td class="act">' +
            '<button class="mini" data-edit="' + row.id + '">编辑</button> ' +
            '<button class="mini danger" data-del="' + row.id + '">删除</button>' +
            '</td>';
      }
      return '<tr>' + tds + '</tr>';
    }).join('');
    $('#tblHead').innerHTML = '<tr>' + head + '</tr>';
    $('#tblBody').innerHTML = body || '<tr><td colspan="' + (COLUMNS.length + (canEdit ? 1 : 0)) + '" class="empty">暂无数据</td></tr>';
    $('#count').textContent = '共 ' + viewRows.length + ' 条';
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
      b.onclick = function () { openRecord(Number(b.getAttribute('data-edit'))); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { confirmDelete(Number(b.getAttribute('data-del'))); };
    });
  }

  // 手机 / PC 断点切换（旋转屏、拉窗口）时重绘一次，列序与固定列随视口正确切换。
  // 仅影响渲染，不触发任何数据请求。
  try {
    var _rerender = function () { if (typeof renderTable === 'function') renderTable(); };
    if (window.matchMedia) {
      var _mq = window.matchMedia('(max-width:768px)');
      if (_mq.addEventListener) _mq.addEventListener('change', _rerender);
      else if (_mq.addListener) _mq.addListener(_rerender);
    }
  } catch (e) {}

  // ---------------------------------------------------------------- 弹窗
  var modalSeq = 0;   // 弹窗序号：异步取编号回来时，避免写进已经关掉/换掉的弹窗

  // 团队账号约定：登录名一律为本人 11 位手机号；
  // 客户经理初始密码 = 该手机号，渠道用户初始密码 = 6 个八（表单已自动带出，主管仍可手动改）
  var DEFAULT_CHANNEL_PW = '888888';
  function defaultPassword(role, phone) {
    return role === 'manager' ? phone : DEFAULT_CHANNEL_PW;
  }

  // ---- 未保存内容保护 --------------------------------------------------------
  // 只比对「用户可编辑」字段。业务编号 f_biz_no 是系统自动填的只读框，
  // 取号完成 / 改日期重取号都会让它变化，绝不能算成用户改动，否则一打开就误报。
  var FORM_IDS = [
    'f_sign_date', 'f_channel', 'f_customer_name', 'f_property_address',
    'f_contract_amount', 'f_loan_type', 'f_loan_amount', 'f_manager_name',
    'f_created_by', 'f_progress', 'f_missing_docs', 'f_settle_status', 'f_remark',
    'c_name', 'c_make_account', 'c_phone', 'c_pw',
    'p_name', 'p_channel', 'p_phone', 'p_pw',
    'pw_new', 'pw_new2'
  ];
  var CHECKBOX_IDS = { c_make_account: 1 };
  var dirtyBaseline = {};      // 打开弹窗时各字段初始值
  var dirtyTouched = false;    // 浏览器 input/change 事件兜底（自动填充等场景）
  var modalSaving = false;     // 保存请求进行中，不允许中途关闭
  var activeFormKey = '';      // 当前弹窗的草稿键；空 = 不提供「保留草稿」
  var drafts = {};             // 「保留草稿并关闭」暂存的内容
  var confirmOnDiscard = null; // 确认层「不保存并继续」要执行的动作

  function modalVisible() {
    var el = $('#modal');
    return !!el && el.style.display === 'flex';
  }
  function confirmVisible() {
    var el = $('#confirmLayer');
    return !!el && el.style.display === 'flex';
  }
  function modalFieldIds() {
    var box = $('#modalBody');
    var html = box ? String(box.innerHTML) : '';
    return FORM_IDS.filter(function (id) { return html.indexOf('id="' + id + '"') >= 0; });
  }
  function fieldVal(el, id) {
    if (!el) return '';
    if (CHECKBOX_IDS[id]) return el.checked ? '1' : '0';
    return String(el.value === undefined || el.value === null ? '' : el.value);
  }
  function snapshotForm() {
    dirtyBaseline = {};
    dirtyTouched = false;
    modalFieldIds().forEach(function (id) { dirtyBaseline[id] = fieldVal($('#' + id), id); });
  }
  function readFormValues() {
    var out = {};
    modalFieldIds().forEach(function (id) {
      var el = $('#' + id);
      if (!el) return;
      out[id] = CHECKBOX_IDS[id] ? !!el.checked : fieldVal(el, id);
    });
    return out;
  }
  function applyDraft(d) {
    Object.keys(d.values || {}).forEach(function (id) {
      var el = $('#' + id);
      if (!el) return;
      if (CHECKBOX_IDS[id]) el.checked = !!d.values[id];
      else el.value = d.values[id];
    });
  }
  function formDirty() {
    if (dirtyTouched) return true;
    var keys = Object.keys(dirtyBaseline);
    for (var i = 0; i < keys.length; i++) {
      if (fieldVal($('#' + keys[i]), keys[i]) !== dirtyBaseline[keys[i]]) return true;
    }
    return false;
  }
  // 真实浏览器里 input/change 会冒泡到 modalBody；程序化赋值（自动编号、恢复草稿）不触发
  function watchDirty() {
    var box = $('#modalBody');
    if (!box || typeof box.addEventListener !== 'function') return;
    ['input', 'change'].forEach(function (ev) {
      box.addEventListener(ev, function (e) {
        var t = e && e.target;
        if (!t || !t.id || t.disabled || t.readOnly || t.id === 'f_biz_no') return;
        dirtyTouched = true;
      });
    });
  }

  function hideConfirm() {
    if ($('#confirmLayer')) $('#confirmLayer').style.display = 'none';
    confirmOnDiscard = null;
  }
  function showConfirmDiscard(onDiscard) {
    var layer = $('#confirmLayer');
    if (!layer) {
      // 只换了 app.js、index.html 还是旧版：退回浏览器原生确认，至少不静默丢数据
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' &&
          window.confirm('表单还有未保存的内容，直接关闭会全部丢失。\n\n「确定」= 不保存并关闭，「取消」= 继续编辑。')) {
        (onDiscard || closeModal)();
      }
      return;
    }
    confirmOnDiscard = onDiscard || closeModal;
    var canKeep = !!activeFormKey;
    var txt = $('#confirmText');
    if (txt) txt.innerHTML =
      '刚才填写 / 修改的内容<b>还没有保存</b>，直接关闭会全部丢失。<br>' +
      '可以选<b>继续编辑</b>' +
      (canKeep ? '、<b>保留草稿并关闭</b>（下次打开同一表单自动恢复）' : '') +
      '，或<b>不保存直接关闭</b>。<br>' +
      '<span class="muted small">误点 × / 遮罩 / Esc / 刷新页面都会先看到这个确认，不会悄悄丢数据。</span>';
    var keep = $('#confirmKeep');
    if (keep) keep.style.display = canKeep ? 'inline-block' : 'none';
    if ($('#confirmLayer')) $('#confirmLayer').style.display = 'flex';
  }
  // 所有关闭入口统一走这里：× / 取消 / 点遮罩 / Esc / 未保存时切别的弹窗
  function requestCloseModal() {
    if (!modalVisible()) return closeModal();
    if (modalSaving) return toast('正在保存，请稍候…');
    if (formDirty()) return showConfirmDiscard(closeModal);
    closeModal();
  }
  function keepDraftAndClose() {
    var key = activeFormKey;
    if (key) drafts[key] = { label: $('#modalTitle').textContent, values: readFormValues() };
    closeModal();
    toast(key ? '草稿已保留，下次打开「' + drafts[key].label + '」会自动恢复' : '已关闭');
  }

  function openModal(title, html, onSubmit, submitText, formKey, defaults) {
    // 已有弹窗没保存时，先确认再替换，避免点别的按钮把整个表单冲掉
    if (modalVisible() && formDirty()) {
      return showConfirmDiscard(function () {
        closeModal();
        openModal(title, html, onSubmit, submitText, formKey, defaults);
      });
    }
    modalSeq++;
    activeFormKey = formKey || '';
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalSubmit').textContent = submitText || '保存';
    $('#modalSubmit').className = 'btn-p';
    $('#modal').style.display = 'flex';
    hideConfirm();
    // 「删除此单」入口默认隐藏，只有手机端的编辑签单弹窗会打开它（见 openRecord）
    var delBtn0 = $('#modalDelBtn');
    if (delBtn0) delBtn0.style.display = 'none';

    // 表单默认值（如渠道账号初始密码 888888）显式赋值，不依赖 HTML value 属性解析；
    // 放在草稿恢复之前，草稿仍能覆盖默认值；两者都在 snapshotForm() 之前，不会误判为「已改动」
    if (defaults) Object.keys(defaults).forEach(function (id) {
      var el = $('#' + id);
      if (el) el.value = defaults[id];
    });

    var draft = activeFormKey && drafts[activeFormKey];
    if (draft) {
      applyDraft(draft);
      delete drafts[activeFormKey];
      toast('已恢复上次未保存的草稿（' + (draft.label || title) + '）');
    }
    snapshotForm();   // 基线要在恢复草稿之后取，否则恢复内容会被误判成「已改动」

    $('#modalSubmit').onclick = async function () {
      var btn = this;
      btn.disabled = true;
      modalSaving = true;
      try { await onSubmit(); } catch (e) { toast(netHint(e), 'err'); }
      btn.disabled = false;
      modalSaving = false;
      if (!modalVisible() && activeFormKey) delete drafts[activeFormKey];  // 保存成功 → 草稿作废
    };
  }
  function closeModal() {
    $('#modal').style.display = 'none';
    $('#modalSubmit').className = 'btn-p';
    modalSaving = false;
    dirtyTouched = false;
    dirtyBaseline = {};
    hideConfirm();
  }
  function v(id) { var e = $('#' + id); return e ? e.value.trim() : ''; }

  // ---------------------------------------------------------------- 删除签单
  // 权限：管理员可删任意行；客户经理只能删本人名下签单（数据库 RLS 同样约束）；
  //       渠道用户在 renderTable 里就没有操作列，这里再挡一道。
  function confirmDelete(id) {
    if (profile.role !== 'admin' && profile.role !== 'manager') {
      return toast('当前角色为只读，不能删除数据', 'err');
    }
    var row = viewRows.filter(function (x) { return x.id === id; })[0];
    if (!row) return toast('该签单不在当前统计区间，切回「全部时间」后再操作', 'err');

    var facts = [
      ['业务编号', row.biz_no], ['签约日期', row.sign_date], ['客户姓名', row.customer_name],
      ['渠道', row.channel], ['客户经理', row.manager_name],
      ['当前进度', row.progress], ['结账状态', row.settle_status]
    ];
    var summary = facts.map(function (p) {
      return '<div class="dline"><span>' + esc(p[0]) + '</span><b>' + esc(p[1] || '\u2014') + '</b></div>';
    }).join('');
    var html = '<p class="warn" style="margin-top:0">即将删除这条签单，<b>删除后不可恢复</b>，看板统计与 CSV 导出也会同步移除。</p>' +
      '<div class="dsum">' + summary + '</div>' +
      '<p class="muted small">若只是拒单 / 终止业务、希望保留业务痕迹，请点「取消」，改用「编辑」把「当前进度」设为「已终止」。</p>';

    openModal('删除签单确认', html, async function () {
      var r = await db.from('records').delete().eq('id', id);
      if (r.error) {
        return toast('删除失败：' + netHint(r.error) +
          (profile.role === 'manager'
            ? ' ｜ 客户经理删除需在 SQL Editor 执行 supabase_patch_delete.sql 补上 RLS 策略'
            : ''), 'err');
      }
      closeModal();
      toast('已删除签单 ' + (row.biz_no || ('#' + id)));
      await loadRecords();
    }, '确认删除');
    $('#modalSubmit').className = 'btn-p btn-danger';
  }

  // ---- 手机端删除：编辑弹窗左下角「删除此单」→ 强确认层（必须手输「删除」两字）----
  // 权限与 RLS 约束与 confirmDelete 完全一致；纯 UI 流程不同，不改任何数据逻辑。
  var delRow = null;   // 当前待删除的行；null = 强确认层未打开
  function delLayerVisible() {
    var el = $('#delLayer');
    return !!el && el.style.display === 'flex';
  }
  function closeDelConfirm() {
    var el = $('#delLayer');
    if (el) el.style.display = 'none';
    delRow = null;
  }
  function openDelConfirm(row) {
    delRow = row;
    var facts = [
      ['业务编号', row.biz_no], ['签约日期', row.sign_date], ['客户姓名', row.customer_name],
      ['渠道', row.channel], ['客户经理', row.manager_name],
      ['当前进度', row.progress], ['结账状态', row.settle_status]
    ];
    var summary = facts.map(function (p) {
      return '<div class="dline"><span>' + esc(p[0]) + '</span><b>' + esc(p[1] || '\u2014') + '</b></div>';
    }).join('');
    var box = $('#delText');
    if (box) box.innerHTML =
      '<p>即将删除这条签单，<b>删除后不可恢复</b>，看板统计与 CSV 导出也会同步移除。</p>' +
      '<div class="dsum">' + summary + '</div>' +
      '<p class="muted small">若只是拒单 / 终止业务、希望保留业务痕迹，请点「取消」，改在编辑里把「当前进度」设为「已终止」。</p>';
    var inp = $('#delInput'), btn = $('#delConfirm');
    if (!inp || !btn) return;   // 旧版页面没有强确认层时安全跳过
    inp.value = '';
    btn.disabled = true;
    $('#delLayer').style.display = 'flex';
    inp.oninput = function () { btn.disabled = this.value.trim() !== '删除'; };
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 80);
  }
  async function doDelConfirmed() {
    if (!delRow) return closeDelConfirm();
    var row = delRow;
    var btn = $('#delConfirm');
    if (btn) btn.disabled = true;
    var r = await db.from('records').delete().eq('id', row.id);
    if (r.error) {
      closeDelConfirm();
      return toast('删除失败：' + netHint(r.error) +
        (profile.role === 'manager'
          ? ' ｜ 客户经理删除需在 SQL Editor 执行 supabase_patch_delete.sql 补上 RLS 策略'
          : ''), 'err');
    }
    closeDelConfirm();
    closeModal();   // 签单已删除，编辑弹窗一并关闭
    toast('已删除签单 ' + (row.biz_no || ('#' + row.id)));
    await loadRecords();
  }

  // ---------------------------------------------------------------- 台账录入 / 编辑
  function openRecord(id) {
    var row = id ? viewRows.filter(function (x) { return x.id === id; })[0] : null;
    var isNew = !row;
    var locked = profile.role === 'manager';
    var canAddChannel = profile.role === 'admin';   // 管理员录入时可直接手输新渠道
    var managerVal = locked ? (profile.manager_name || '') : (row ? row.manager_name : '');
    var createdByVal = locked ? (profile.manager_name || '') : (row ? row.created_by : '');
    bizNoRpcFailed = false;

    var channelField = canAddChannel
      ? '<input id="f_channel" list="channelList" value="' + esc(row ? row.channel : '') + '" placeholder="选已有渠道，或直接输入新渠道名">'
      : '<select id="f_channel">' + opts(channels, row ? row.channel : '', '请选择') + '</select>';

    // 业务编号：新建 = 打开弹窗时向数据库取号并显示成只读框；编辑 = 原编号只读，不可改
    var bizField = '<input id="f_biz_no" class="auto-no" value="' +
      (isNew ? '生成中…' : esc(row.biz_no || '')) + '" readonly>';
    var bizHint = isNew
      ? '系统自动生成，无需填写：Z + 签约日期 + 当日流水；改签约日期会自动换号'
      : '编号一经生成不可修改，删除后也不会被复用';

    var h = '<div class="grid">' +
      fld('业务编号', bizField, bizHint) +
      // 新建默认填今天，避免漏填日期导致月份统计漏掉这一单
      fld('签约日期', inp('f_sign_date', row ? (row.sign_date || '') : ymd(new Date()), 'date'), '统计区间按此日期过滤，请勿留空') +
      fld('渠道 *', channelField, canAddChannel ? '输入新的渠道名并保存，会自动加入渠道名单，之后所有人下拉可选' : '') +
      fld('客户姓名', inp('f_customer_name', row ? row.customer_name : '')) +
      fld('物业地址', inp('f_property_address', row ? row.property_address : '')) +
      fld('合同总价(万)', inp('f_contract_amount', row ? row.contract_amount : '', 'number', 'step="0.01" min="0"')) +
      fld('贷款类型', '<select id="f_loan_type">' + opts(OPTIONS.loan_type, row ? row.loan_type : '', '请选择') + '</select>') +
      fld('贷款金额(万)', inp('f_loan_amount', row ? row.loan_amount : '', 'number', 'step="0.01" min="0"')) +
      fld('客户经理 *', '<input id="f_manager_name" value="' + esc(managerVal) + '"' + (locked ? ' disabled' : ' list="managerList"') + '>', locked ? '已锁定为本人，前端与数据库双重锁定' : '默认 4 人可选，也可手填新姓名') +
      fld('录入人', '<input id="f_created_by" value="' + esc(createdByVal) + '"' + (locked ? ' disabled' : '') + '>', locked ? '已锁定为本人' : '') +
      fld('当前进度', '<select id="f_progress">' + opts(OPTIONS.progress, row ? row.progress : '', '请选择') + '</select>') +
      fld('缺件清单', inp('f_missing_docs', row ? row.missing_docs : '')) +
      fld('结账状态', '<select id="f_settle_status">' + opts(OPTIONS.settle_status, row ? row.settle_status : '未结账') + '</select>') +
      fld('备注', inp('f_remark', row ? row.remark : '')) +
      '</div>';

    openModal(isNew ? '新增签单' : '编辑签单 #' + id, h, async function () {
      var payload = {
        sign_date:        v('f_sign_date') || null,
        channel:          v('f_channel'),
        customer_name:    v('f_customer_name') || null,
        property_address: v('f_property_address') || null,
        contract_amount:  v('f_contract_amount') === '' ? null : Number(v('f_contract_amount')),
        loan_type:        v('f_loan_type') || null,
        loan_amount:      v('f_loan_amount') === '' ? null : Number(v('f_loan_amount')),
        manager_name:     locked ? (profile.manager_name || '') : v('f_manager_name'),
        progress:         v('f_progress') || null,
        missing_docs:     v('f_missing_docs') || null,
        settle_status:    v('f_settle_status') || null,
        created_by:       locked ? (profile.manager_name || '') : (v('f_created_by') || null),
        remark:           v('f_remark') || null
      };
      var savedBizNo = '';
      if (isNew) {
        savedBizNo = v('f_biz_no');
        if (!/^Z\d{8,}$/.test(savedBizNo)) return toast('业务编号正在生成，请稍候再点保存', 'err');
        // 弹窗里改过签约日期：编号前缀必须跟着日期走，重新向数据库取号
        if (savedBizNo.indexOf(bizPrefix(payload.sign_date)) !== 0) {
          savedBizNo = await allocBizNo(payload.sign_date);
          if ($('#f_biz_no')) $('#f_biz_no').value = savedBizNo;
        }
        payload.biz_no = savedBizNo;
      }
      // 编辑时干脆不传 biz_no：前端只读 + 数据库 trg_keep_biz_no 双重保证编号不变
      if (!payload.channel) return toast('请选择或填写渠道', 'err');
      if (!payload.manager_name) return toast('客户经理不能为空', 'err');

      // 管理员手输了新渠道 → 自动写进 channels 表，之后所有人下拉可见
      if (canAddChannel && channels.indexOf(payload.channel) < 0) {
        var ci = await db.from('channels').insert({ name: payload.channel });
        if (ci.error) return toast('新增渠道失败：' + netHint(ci.error), 'err');
        channels.push(payload.channel);
        await loadChannels();
      }

      var r;
      if (isNew) r = await db.from('records').insert(payload);
      else r = await db.from('records').update(payload).eq('id', id);
      if (r.error) {
        var msg = netHint(r.error);
        if (/biz_no|duplicate key|unique constraint/i.test(String((r.error && r.error.message) || ''))) {
          msg += ' ｜ 业务编号重复：请在 SQL Editor 执行一次 supabase_patch_biz_no.sql 启用服务端自动编号后重试。';
        }
        return toast(msg, 'err');
      }
      closeModal();
      var tail = bizNoHint();
      if (!inPeriod(payload.sign_date)) {
        toast((isNew ? '已录入' : '已保存') + '，但该签单不在当前统计区间（' + periodLabel() + '）内，切回「全部时间」即可看到。' + tail);
      } else {
        toast((isNew ? '已录入，编号 ' + savedBizNo : '已保存') + tail);
      }
      await loadRecords();
    }, '保存', (isNew ? 'record:new' : 'record:' + id));

    // 手机端：删除入口收进编辑弹窗左下角（桌面端仍用列表行内「删除」按钮）
    var delBtn = $('#modalDelBtn');
    if (delBtn) {
      var canDel = profile.role === 'admin' || profile.role === 'manager';
      var mobileNow = (typeof window.matchMedia === 'function') && window.matchMedia('(max-width:768px)').matches;
      if (!isNew && mobileNow && canDel) {
        delBtn.style.display = '';
        delBtn.onclick = function () { openDelConfirm(row); };
      } else {
        delBtn.style.display = 'none';
      }
    }

    // 新增：一打开弹窗就向数据库取号，期间禁用「保存」，取到后填进只读框
    if (isNew) {
      var seq = modalSeq;
      var reqNo = 0;                 // 请求序号：改日期时丢弃上一次的迟到结果
      var btn = $('#modalSubmit');
      var refreshBizNo = function (dateStr) {
        var my = ++reqNo;
        var el0 = $('#f_biz_no');
        if (el0) el0.value = '生成中…';
        btn.disabled = true;
        allocBizNo(dateStr).then(function (no) {
          if (seq !== modalSeq || my !== reqNo) return;  // 弹窗已换 / 有更新的请求
          var el = $('#f_biz_no');
          if (el) el.value = no;
          btn.disabled = false;
        }).catch(function () {
          if (seq !== modalSeq || my !== reqNo) return;
          var el = $('#f_biz_no');
          if (el) el.value = localBizNo(dateStr);
          btn.disabled = false;
        });
      };
      refreshBizNo($('#f_sign_date') ? $('#f_sign_date').value : '');
      // 改「签约日期」-> 自动重取号，保证编号前缀永远等于签约日期
      $('#f_sign_date').onchange = function () {
        if (seq !== modalSeq) return;
        refreshBizNo(this.value);
      };
    }
  }

  // ---------------------------------------------------------------- 管理员：新增渠道
  function openAddChannel() {
    var h = fld('渠道名称 *', inp('c_name', '', 'text', 'placeholder="如 MOHAN / 新增渠道名"')) +
      '<hr><label class="chk"><input type="checkbox" id="c_make_account"> 同时创建该渠道的登录账号</label>' +
      '<div id="c_account" class="grid" style="display:none">' +
        fld('登录手机号 *', inp('c_phone', '', 'tel', 'placeholder="11 位手机号"')) +
        fld('初始密码', inp('c_pw', DEFAULT_CHANNEL_PW, 'password', 'placeholder="默认 888888"')) +
      '</div><p class="muted small">渠道名单存在 channels 表里，随时可加；创建账号会写入 user_invites 并自动 signUp，角色为「渠道用户」，绑定该渠道，登录后只读本渠道数据。<br>账号约定：登录名 = 该手机号，初始密码默认 <b>888888</b>（6 个八，可手动修改）。</p>';
    openModal('新增渠道', h, async function () {
      var name = v('c_name');
      if (!name) return toast('请填写渠道名称', 'err');
      if (channels.indexOf(name) >= 0) return toast('该渠道已存在', 'err');
      var makeAcc = $('#c_make_account').checked;
      var phone = v('c_phone'), pw = v('c_pw');
      if (makeAcc && !pw) pw = DEFAULT_CHANNEL_PW;   // 留空按团队约定补默认密码
      if (makeAcc && (!phoneOk(phone) || pw.length < 6)) return toast('请填写合法的手机号和至少 6 位密码', 'err');

      var r = await db.from('channels').insert({ name: name });
      if (r.error) return toast(netHint(r.error), 'err');
      if (makeAcc) {
        var ok = await createAccount(phone, pw, { role: 'channel', channel: name, display_name: name });
        if (!ok) return; // createAccount 内部已提示
      }
      closeModal();
      toast('渠道已新增' + (makeAcc ? '，账号已开通' : ''));
      await loadChannels();
      renderShell();
      await loadRecords();
    }, '保存', 'channel:new', { c_pw: DEFAULT_CHANNEL_PW });
    $('#c_make_account').onchange = function () {
      $('#c_account').style.display = this.checked ? 'grid' : 'none';
    };
  }

  // ---------------------------------------------------------------- 管理员：新增客户经理 / 渠道用户
  function openAddPerson(role) {
    var isMgr = role === 'manager';
    var h = (isMgr
      ? fld('客户经理姓名 *', '<input id="p_name" list="managerList" placeholder="如何燕 / 梁雄凯">',
            '默认候选：何燕、孔得杨、梁雄凯、王迎佳；也可手填新姓名新增')
      : fld('归属渠道 *', '<select id="p_channel">' + opts(channels, '', '请选择') + '</select>')) +
      fld('登录手机号 *', inp('p_phone', '', 'tel', 'placeholder="11 位手机号"')) +
      fld('初始密码', inp('p_pw', isMgr ? '' : DEFAULT_CHANNEL_PW, 'password',
          isMgr ? 'placeholder="默认与手机号相同，可修改"' : 'placeholder="默认 888888"')) +
      '<p class="muted small">' + (isMgr
        ? '账号约定：登录名 = 本人手机号，初始密码 = 同一手机号（填手机号后自动带出，可手动修改）。创建后只能看到/录入「客户经理 = 本人」的签单，且客户经理、录入人自动锁定为本人。'
        : '账号约定：登录名 = 本人手机号，初始密码 = <b>888888</b>（6 个八，可手动修改）。创建后只能看到「渠道 = 所绑定渠道」的数据，且为只读。') + '</p>';
    openModal(isMgr ? '新增客户经理' : '新增渠道用户', h, async function () {
      var phone = v('p_phone'), pw = v('p_pw');
      if (!phoneOk(phone)) return toast('请输入 11 位手机号', 'err');
      if (!pw) pw = defaultPassword(role, phone);   // 留空按团队约定补默认密码
      if (pw.length < 6) return toast('密码至少 6 位', 'err');
      var inv = { role: role, display_name: isMgr ? v('p_name') : v('p_channel') };
      if (isMgr) {
        if (!v('p_name')) return toast('请填写客户经理姓名', 'err');
        inv.manager_name = v('p_name');
      } else {
        if (!v('p_channel')) return toast('请选择归属渠道', 'err');
        inv.channel = v('p_channel');
      }
      var ok = await createAccount(phone, pw, inv);
      if (!ok) return;
      closeModal();
      toast('账号已开通：' + phone);
      await loadManagers();
    }, '保存', 'person:' + role, isMgr ? null : { p_pw: DEFAULT_CHANNEL_PW });

    // 客户经理：填手机号后自动把密码带成同一手机号；主管手动改过密码就不再跟随
    var phoneEl = $('#p_phone'), pwEl = $('#p_pw');
    if (isMgr && phoneEl && pwEl) {
      pwEl._pwAuto = true;
      pwEl.oninput = function () { this._pwAuto = false; };
      phoneEl.oninput = function () {
        if (pwEl._pwAuto) pwEl.value = this.value;
      };
    }
  }

  // 管理员一键开户：写邀请 -> 独立客户端 signUp -> 恢复管理员会话
  async function createAccount(phone, password, invite) {
    var email = authEmail(phone);
    var sess = await db.auth.getSession();
    var session = sess.data && sess.data.session;

    var payload = {
      email: email,
      role: invite.role,
      channel: invite.channel || null,
      manager_name: invite.manager_name || null,
      display_name: invite.display_name || null,
      created_by: me.id
    };
    var ins = await db.from('user_invites').upsert(payload, { onConflict: 'email' });
    if (ins.error) { toast('写入邀请失败：' + netHint(ins.error), 'err'); return false; }

    var su = await signupDb.auth.signUp({
      email: email, password: password,
      options: { data: { phone: phone, display_name: invite.display_name || phone } }
    });

    // 恢复管理员会话（防止 signUp 影响主客户端）
    try {
      if (session) await db.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
      await signupDb.auth.signOut();
    } catch (e) { /* 忽略 */ }

    if (su.error) {
      await db.from('user_invites').delete().eq('email', email);
      toast('开户失败：' + netHint(su.error) + ' ｜ 请确认 Authentication → Sign In / Providers → Email 已启用且关闭 Confirm email', 'err');
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- 密码管理
  // 自己改密码：GoTrue 的 auth.updateUser 只作用于当前会话用户，纯前端即可。
  // 主管重置他人：必须走数据库 SECURITY DEFINER 函数（public.admin_reset_password）。
  //   浏览器端的 auth.admin.updateUserById 需要 service_role 密钥 —— 那把钥匙
  //   绝不能放进公开前端，所以由数据库函数内二次校验 admin 后代写 auth.users。
  var accountsCache = [];
  var pendingReset = null;

  function rawV(id) { var e = $('#' + id); return e ? String(e.value || '') : ''; }

  function openChangePassword() {
    var h = '<div class="note">修改后即时生效，当前登录状态不会中断。<b>只有你自己</b>能改自己的密码，主管也看不到你设的新密码。</div>' +
      '<div class="grid" style="margin-top:16px">' +
        fld('新密码 *', inp('pw_new', '', 'password', 'autocomplete="new-password" placeholder="至少 6 位"')) +
        fld('确认新密码 *', inp('pw_new2', '', 'password', 'autocomplete="new-password" placeholder="再输一次"')) +
      '</div>';
    openModal('修改我的密码', h, async function () {
      var a = rawV('pw_new'), b = rawV('pw_new2');
      if (a.length < 6) return toast('新密码至少 6 位', 'err');
      if (a !== b) return toast('两次输入的新密码不一致', 'err');
      if (!db || !db.auth || typeof db.auth.updateUser !== 'function') {
        return toast('当前客户端不支持修改密码，请更新 vendor/supabase-js.umd.min.js', 'err');
      }
      var r = await db.auth.updateUser({ password: a });
      if (r.error) return toast(netHint(r.error), 'err');
      closeModal();
      toast('密码已修改，下次登录请用新密码');
    }, '确认修改', 'password:self');
  }

  async function openAccounts() {
    if (!profile || profile.role !== 'admin') return toast('只有主管可以管理账号', 'err');
    pendingReset = null;
    var h = '<div class="acct-tools">' +
        inp('acctKw', '', 'text', 'placeholder="搜索手机号 / 姓名 / 渠道"') +
        '<span class="muted small" id="acctCount"></span></div>' +
      '<div id="acctList" style="max-height:44vh;overflow:auto">正在读取账号列表…</div>' +
      '<div id="acctConfirm" style="display:none;margin-top:12px"></div>' +
      '<div class="note">重置后该账号密码统一变为 <b>888888</b>（6 个八），请通知本人尽快用顶部「修改密码」改成自己的。<br>' +
        '不能重置自己的密码；此操作不改角色、不改绑定范围，也不动任何台账数据。</div>';
    openModal('账号管理 · 重置密码', h, function () { closeModal(); }, '关闭', '');

    var kw = $('#acctKw');
    if (kw) kw.oninput = function () { renderAcctList(String(kw.value || '')); };

    var r;
    try {
      r = await db.from('profiles')
        .select('id,phone,display_name,role,channel,manager_name')
        .order('role').order('phone');
    } catch (e) {
      var eb = $('#acctList');
      if (eb) eb.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">读取失败：' + esc(netHint(e)) + '</div>';
      return;
    }
    if (r.error) {
      var fb = $('#acctList');
      if (fb) fb.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">读取失败：' + esc(netHint(r.error)) + '</div>';
      return;
    }
    accountsCache = Array.isArray(r.data) ? r.data : [];
    renderAcctList('');
  }

  function renderAcctList(kw) {
    var box = $('#acctList');
    if (!box) return;
    var k = String(kw || '').trim().toLowerCase();
    var shown = accountsCache.filter(function (u) {
      if (!k) return true;
      return [u.phone, u.display_name, u.role, ROLE_LABEL[u.role], u.channel, u.manager_name]
        .some(function (x) { return String(x || '').toLowerCase().indexOf(k) >= 0; });
    });
    var cnt = $('#acctCount');
    if (cnt) cnt.textContent = '共 ' + accountsCache.length + ' 个账号' +
      (k ? ' · 匹配 ' + shown.length + ' 个' : '');
    if (!shown.length) {
      box.innerHTML = '<div class="muted small" style="padding:22px;text-align:center">没有匹配的账号</div>';
      return;
    }
    var h = '<table class="acct-tb"><thead><tr><th>登录名</th><th>显示名</th><th>角色</th>' +
      '<th>绑定范围</th><th style="text-align:right">操作</th></tr></thead><tbody>';
    shown.forEach(function (u, i) {
      var self = !!(me && u.id === me.id);
      var bind = u.role === 'channel' ? (u.channel || '—')
               : u.role === 'manager' ? (u.manager_name || '—') : '全部数据';
      h += '<tr><td class="mono">' + esc(u.phone || u.id) + '</td>' +
        '<td>' + esc(u.display_name || '—') + '</td>' +
        '<td><span class="tag r-' + esc(u.role) + '">' + esc(ROLE_LABEL[u.role] || u.role) + '</span></td>' +
        '<td>' + esc(bind) + '</td>' +
        '<td style="text-align:right">' + (self
          ? '<span class="self">本人 · 请用「修改密码」</span>'
          : '<button class="mini danger" id="rst_' + i + '">重置为 888888</button>') + '</td></tr>';
    });
    h += '</tbody></table>';
    box.innerHTML = h;
    shown.forEach(function (u, i) {
      if (me && u.id === me.id) return;
      var b = $('#rst_' + i);
      if (b) b.onclick = function () { showResetConfirm(u); };
    });
  }

  function clearResetConfirm() {
    pendingReset = null;
    var box = $('#acctConfirm');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }

  function showResetConfirm(u) {
    var box = $('#acctConfirm');
    if (!box) return;
    pendingReset = u;
    box.innerHTML = '<div style="border:1px solid #E7C7BF;border-left:3px solid var(--accent);' +
      'padding:12px 14px;background:#FBF0EE">' +
      '<div style="font-weight:700;color:#8C2F21;margin-bottom:6px">确认重置这个账号的密码？</div>' +
      '<div class="small" style="line-height:1.85;color:#4A5560">登录名 <b>' + esc(u.phone || u.id) +
        '</b> · ' + esc(ROLE_LABEL[u.role] || u.role) +
        '<br>重置后密码为 <b>888888</b>，下次登录生效；角色与台账数据不变。</div>' +
      '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="mini" id="rstCancel">取消</button>' +
        '<button class="mini" id="rstGo" style="background:var(--accent);border-color:var(--accent);color:#fff">确认重置</button>' +
      '</div></div>';
    box.style.display = 'block';
    var cancel = $('#rstCancel'), go = $('#rstGo');
    if (cancel) cancel.onclick = clearResetConfirm;
    if (go) go.onclick = doResetPassword;
  }

  async function doResetPassword() {
    var u = pendingReset;
    if (!u) return;
    if (!db || typeof db.rpc !== 'function') {
      return toast('当前客户端不支持重置，请更新 vendor/supabase-js.umd.min.js', 'err');
    }
    var go = $('#rstGo');
    if (go) go.disabled = true;
    var r = await db.rpc('admin_reset_password', { p_target: u.id });
    if (r.error) {
      if (go) go.disabled = false;
      return toast(netHint(r.error), 'err');
    }
    var label = u.display_name || u.phone || u.id;
    clearResetConfirm();
    toast('已把「' + label + '」的密码重置为 888888，请通知本人尽快修改');
  }

  // ---------------------------------------------------------------- 导出 CSV
  function exportCsv() {
    // viewRows 已按当前排序排好，导出的 CSV 行序与屏幕所见完全一致
    if (!viewRows.length) return toast('当前统计区间内没有可导出的数据', 'err');
    var head = COLUMNS.map(function (c) { return c.n; });
    var lines = [head.join(',')];
    viewRows.forEach(function (r) {
      lines.push(COLUMNS.map(function (c) {
        var x = r[c.k];
        return '"' + String(x === null || x === undefined ? '' : x).replace(/"/g, '""') + '"';
      }).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var tag = periodLabel().replace(/[\\/:*?"<>|~\s]/g, '');
    a.download = '客户汇总清单台账_' + (tag || '全部时间') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------- 事件绑定
  function bind() {
    $('#btnLogin').onclick = doLogin;
    $('#loginPw').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
    // 安全兜底：无论加载的是哪一版 index.html，都不允许登录页出现自助注册入口。
    // 旧版页面残留的注册框会被清空并隐藏；新版只有三个隐藏空节点，同样处理。
    ['toggleReg', 'firstDeploy', 'btnReg'].forEach(function (id) {
      var el = $('#' + id);
      if (!el) return;
      el.style.display = 'none';
      el.innerHTML = '';
      el.onclick = null;
    });
    $('#btnLogout').onclick = async function () { await db.auth.signOut(); };
    $('#btnRefresh').onclick = loadRecords;
    $('#btnNewRecord').onclick = function () { openRecord(null); };
    $('#btnAddChannel').onclick = openAddChannel;
    $('#btnAddManager').onclick = function () { openAddPerson('manager'); };
    $('#btnAddChannelUser').onclick = function () { openAddPerson('channel'); };
    $('#btnExport').onclick = exportCsv;
    ['#chanFilter', '#filterProgress', '#filterSettle'].forEach(function (s) {
      $(s).onchange = loadRecords;
    });
    $('#filterKw').oninput = function () {
      clearTimeout(bind._t);
      bind._t = setTimeout(loadRecords, 300);
    };
    // 新增 DOM 节点做空值保护：只更新了 app.js、index.html 还是旧版时也不会整段报错
    var on = function (sel, fn) { var el = $(sel); if (el) el.onclick = fn; };
    // 密码管理（旧版 index.html 没有这两个按钮时，on() 会安全跳过）
    on('#btnChangePw', openChangePassword);
    on('#btnAccounts', openAccounts);
    // 关闭弹窗一律先过「未保存确认」；确认层三个按钮都只操作独立层，不动表单
    on('#modalClose', requestCloseModal);
    on('#modalCancel', requestCloseModal);
    on('#modal', function (e) { if (e && e.target === this) requestCloseModal(); });
    on('#confirmStay', hideConfirm);                        // 继续编辑
    on('#confirmKeep', keepDraftAndClose);                 // 保留草稿并关闭
    on('#confirmDiscard', function () {                     // 不保存直接关闭
      var fn = confirmOnDiscard;
      hideConfirm();
      if (fn) fn();
    });
    // 确认层点遮罩 = 继续编辑（最安全的默认，不会误丢数据）
    on('#confirmLayer', function (e) { if (e && e.target === this) hideConfirm(); });
    // 删除强确认层：取消 / 点遮罩 = 关闭；「确认删除」按钮本身由输入校验控制 disabled
    on('#delCancel', closeDelConfirm);
    on('#delConfirm', doDelConfirmed);
    on('#delLayer', function (e) { if (e && e.target === this) closeDelConfirm(); });
    watchDirty();
    // 刷新 / 关闭标签页时也兜一道（浏览器原生提示，文案由浏览器决定）
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', function (e) {
        if (!modalVisible() || !formDirty()) return;
        e.preventDefault();
        e.returnValue = '';
        return '';
      });
    }
    $('#filterProgress').innerHTML = opts(OPTIONS.progress, '', '全部进度');
    $('#filterSettle').innerHTML = opts(OPTIONS.settle_status, '', '全部状态');

    // ---- 列表排序：只重排本地视图，不重新查数据库 ----
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
      b.onclick = function () {
        var m = b.getAttribute('data-sort');
        if (m !== 'date' && m !== 'channel') return;
        sortMode = m;
        refreshView();
      };
    });
    on('#btnSortDir', function () { sortTimeDesc = !sortTimeDesc; refreshView(); });

    // ---- 统计区间 ----
    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (b) {
      b.onclick = function () {
        var p = b.getAttribute('data-preset');
        period = p === 'all' ? { kind: 'all' } : { kind: 'preset', preset: p };
        closePop();
        refreshView();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { switchPopTab(b.getAttribute('data-tab')); };
    });
    $('#btnMonths').onclick = function () { openPop('months', this); };
    $('#btnRange').onclick = function () { openPop('range', this); };
    $('#btnPeriodApply').onclick = applyPeriod;
    $('#btnPeriodCancel').onclick = closePop;
    $('#btnPeriodClear').onclick = setAll;
    // 点面板外关闭 / Esc 关闭（面板在 #periodBar 内，点面板本身不会误关）
    document.addEventListener('click', function (e) {
      var bar = $('#periodBar'), pop = $('#periodPop');
      if (pop && pop.className.indexOf('show') >= 0 && bar && bar.contains && !bar.contains(e.target)) closePop();
    });
    document.addEventListener('keydown', function (e) {
      if (!e || e.key !== 'Escape') return;
      if (confirmVisible()) return hideConfirm();      // Esc = 继续编辑（最安全）
      if (delLayerVisible()) return closeDelConfirm(); // 删除强确认层最上层，先关它
      if (modalVisible()) return requestCloseModal();  // 弹窗 Esc 也要过未保存确认
      closePop();
    });
  }

  document.addEventListener('DOMContentLoaded', function () { bind(); boot(); });
})();
