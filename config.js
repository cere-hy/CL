// =============================================================================
// 客户汇总清单台账 · 连接配置（官方 supabase.com）
// 只需改这里。变量名保持 window.SUPABASE_CONFIG.URL / ANON_KEY
//
// 获取路径：登录 https://supabase.com/dashboard → 选中你的项目
//   1) Project URL：左下角「Project Settings（齿轮）」→「API」或顶部「Connect」
//      → Project URL，形如 https://abcdefghijklmno.supabase.co
//   2) Key：Project Settings →「API Keys」
//        · 新项目：「Publishable key」→ sb_publishable_xxxxx   ← 推荐
//        · 旧项目：「Legacy API keys」标签 → anon key (eyJhbGciOi...)
//      两种都可用，前端会自动兼容。
//
// ⚠️ 绝对不要填 sb_secret_... / service_role key：它会绕过 RLS，前端会拒绝启动。
// ⚠️ supabase.com 没有 IP 白名单，也不需要配 VPC / 数据库密码（那是阿里云的）。
// =============================================================================
window.SUPABASE_CONFIG = {
  URL: 'https://iksdnbkqfcmktdewfcyz.supabase.co',        // https://xxxxxxxxxxxx.supabase.co
  ANON_KEY: 'sb_publishable__GSONn0sT3I6SQLbnDmt9A_Ny1wBQ3r',   // sb_publishable_... 或旧版 eyJ... anon key

  // 登录名 → Supabase Auth 邮箱账号 的域名。
  // 留空 = 自动使用默认域 ledger.example.com。例如登录时输入 13800138000，
  // 前端自动映射为 13800138000@ledger.example.com 走邮箱密码认证，无需短信服务商。
  // 若 supabase.com 报 email_address_invalid，把它改成你有 MX 记录的域名
  // （如 yourcompany.com），或先关闭 Authentication 里的 Confirm email。
  // 全站必须一致；改动后已建账号需重建。
  AUTH_DOMAIN: ''
};
