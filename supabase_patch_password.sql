-- =============================================================================
-- 客户汇总清单台账 · 密码管理补丁（已部署的库执行一次，幂等）
-- 目标平台：官方 supabase.com → SQL Editor → New query → 整段粘贴 → Run
--
-- 作用：
--   1) 启用 pgcrypto（用于生成 GoTrue 认识的 bcrypt 密码散列）
--   2) 建 public.admin_reset_password(uuid)：主管把「其他任何人」的密码重置为 888888
--   3) 收紧 EXECUTE 权限，只有已登录的 authenticated 角色能调用
--
-- 为什么不是前端直接调 supabase.auth.admin.updateUserById()：
--   那个 API 需要 service_role / sb_secret_ 密钥。公开网页里放这类密钥会绕过
--   全部 RLS，等于把整库送出去。因此改由数据库 SECURITY DEFINER 函数代写，
--   函数内再独立校验一次 admin 身份 —— 前端按钮只是入口，不是权限依据。
--
-- 函数只改密码，不改 role / channel / manager_name，也不碰任何台账数据。
-- 全新空库不需要执行本文件：supabase_schema.sql 已内置同一段（7.2）。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. pgcrypto：Supabase 默认装在 extensions schema；已装过则什么都不做
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 2. 主管重置他人密码
-- -----------------------------------------------------------------------------
create or replace function public.admin_reset_password(p_target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_crypto   text;
  v_target   public.profiles%rowtype;
  v_updated  integer;
begin
  -- ① 必须是通过 PostgREST 带 JWT 的登录用户；SQL Editor 里 auth.uid() 为空，
  --    因此即便拿到函数签名也无法在匿名环境调用
  if auth.uid() is null then
    raise exception '未登录，不能重置密码';
  end if;

  -- ② 只有主管。auth_role() 本身是 SECURITY DEFINER，不会触发 RLS 递归
  if coalesce(public.auth_role(), '') <> 'admin' then
    raise exception '只有主管（admin）可以重置他人密码';
  end if;

  if p_target is null then
    raise exception '缺少目标账号';
  end if;

  -- ③ 自己的密码用 GoTrue 的 auth.updateUser（前端「修改密码」），不走这里
  if p_target = auth.uid() then
    raise exception '不能重置自己的密码，请使用顶部「修改密码」';
  end if;

  -- ④ 目标必须是本台账里真实存在的账号，不接受任意 uuid
  select * into v_target from public.profiles where id = p_target;
  if not found then
    raise exception '目标账号不存在';
  end if;

  -- pgcrypto 在不同项目可能装在 extensions 或 public，动态定位后全限定调用，
  -- 避免写死 schema 导致 function does not exist
  select n.nspname into v_crypto
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'gen_salt'
   order by (n.nspname = 'extensions') desc
   limit 1;
  if v_crypto is null then
    raise exception '缺少 pgcrypto 扩展：请执行 create extension if not exists pgcrypto with schema extensions; 后重试';
  end if;

  -- GoTrue 用 bcrypt 校验 encrypted_password，crypt(..., gen_salt('bf',10)) 与之兼容。
  -- 密码写死 888888，不作为入参：这个函数永远不能被拿来设置任意密码。
  execute format(
    'update auth.users set encrypted_password = %I.crypt($1, %I.gen_salt(''bf'', 10)), updated_at = now() where id = $2',
    v_crypto, v_crypto
  ) using '888888', p_target;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception '目标账号不存在于 auth.users';
  end if;

  -- 让被重置账号现有的登录会话立刻失效（换密码 / 人员离场场景）。
  -- 不同 Supabase 版本表名 / 列名不同：缺表跳过，清理失败也不影响密码重置本身。
  begin
    if to_regclass('auth.sessions') is not null then
      execute 'delete from auth.sessions where user_id = $1' using p_target;
    end if;
    if to_regclass('auth.refresh_tokens') is not null then
      execute 'delete from auth.refresh_tokens where user_id = $1' using p_target;
    end if;
  exception when others then
    null;
  end;

  return '已将 ' || coalesce(v_target.phone, p_target::text) || ' 的密码重置为 888888';
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. 权限：只给已登录角色，且函数内还有 admin 校验（双保险）
-- -----------------------------------------------------------------------------
revoke all on function public.admin_reset_password(uuid) from PUBLIC, anon, authenticated;
grant  execute on function public.admin_reset_password(uuid) to authenticated;

comment on function public.admin_reset_password(uuid) is
  '主管重置他人登录密码为 888888；SECURITY DEFINER，函数内校验 admin / 非本人 / 账号存在';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- 验收（单独执行）
-- -----------------------------------------------------------------------------
-- select p.proname, p.prosecdef as security_definer,
--        pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'admin_reset_password';
--    → 1 行，security_definer = true，args = p_target uuid
--
-- select has_function_privilege('authenticated',
--        'public.admin_reset_password(uuid)', 'EXECUTE') as authenticated_can_call,
--        has_function_privilege('anon',
--        'public.admin_reset_password(uuid)', 'EXECUTE') as anon_can_call;
--    → true / false
--
-- 实际功能请在页面用主管账号点「账号管理 → 重置为 888888」验收：
-- SQL Editor 里 auth.uid() 为空，直调函数会被第 ① 道校验拒绝（这是安全设计）。
-- =============================================================================
