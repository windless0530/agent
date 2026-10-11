import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { log } from './util.mjs';

/** 用户身份发消息所需授权 scope：offline_access 换 refresh_token（官方文档：
 *  未授予则不返回 refresh_token）；im:message + im:message.send_as_user 缺一不可 */
export const AUTH_SCOPES = ['offline_access', 'im:message', 'im:message.send_as_user'];

/** access_token 剩余寿命低于该秒数即提前刷新，避免边界失效 */
const REFRESH_MARGIN_SEC = 120;

export function authHosts(domain) {
  return domain === 'lark'
    ? { accounts: 'https://accounts.larksuite.com', open: 'https://open.larksuite.com' }
    : { accounts: 'https://accounts.feishu.cn', open: 'https://open.feishu.cn' };
}

export function authFilePath(cfg) {
  return cfg.authFile || path.join(os.homedir(), '.cc-bridge-auth.json');
}

/** OAuth 授权链接（浏览器打开 → 同意 → 跳转 redirect_uri?code=..，从地址栏复制 code） */
export function buildAuthorizeUrl({ appId, redirectUri, state, domain = 'feishu', scopes = AUTH_SCOPES }) {
  const u = new URL(`${authHosts(domain).accounts}/open-apis/authen/v1/authorize`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  if (scopes?.length) u.searchParams.set('scope', scopes.join(' '));
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

/** 读本地凭据（daemon 每次使用前重读，方便 cli `auth` 命令写入后 daemon 即时生效） */
export function loadAuth(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(authFilePath(cfg), 'utf8'));
    if (j && j.access_token) return j;
  } catch {
    // 无凭据 / 坏文件 → null
  }
  return null;
}

/** 原子落盘：先写 tmp 再 rename（refresh_token 单次有效，刷新成功后必须先保存再使用，
 *  崩溃在中间只是浪费一次刷新，不会把新旧值都弄丢）；chmod 600 防其他用户读取 */
export function saveAuth(cfg, data) {
  const file = authFilePath(cfg);
  const full = {
    ...data,
    saved_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch { /* 权限收紧失败不阻塞 */ }
  fs.renameSync(tmp, file);
  return full;
}

/** v2 OAuth token 端点（authorization_code 换取 / refresh_token 刷新共用） */
async function oauthToken(cfg, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${authHosts(cfg.domain).open}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) {
    const err = new Error(`oauth token 失败 http=${res.status} code=${j.code} ${j.error || ''} ${j.error_description || j.msg || ''}`.trim());
    err.oauthCode = j.code;
    throw err;
  }
  return j;
}

/** 授权码换 token，并顺带取用户身份（open_id/name）一并落盘 */
export async function exchangeCode({ cfg, code, redirectUri, fetchImpl = fetch }) {
  const j = await oauthToken(
    cfg,
    {
      grant_type: 'authorization_code',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      code,
      redirect_uri: redirectUri,
    },
    fetchImpl,
  );
  const info = await fetchUserInfo(cfg, j.access_token, fetchImpl).catch((e) => {
    log('auth', '获取用户信息失败（不影响 token 保存）:', e.message);
    return {};
  });
  return saveAuth(cfg, {
    access_token: j.access_token,
    access_expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
    refresh_token: j.refresh_token || '',
    refresh_expires_at: j.refresh_token
      ? Date.now() + (Number(j.refresh_token_expires_in) || 604800) * 1000
      : 0,
    scope: j.scope || '',
    open_id: info.open_id || '',
    name: info.name || '',
  });
}

/** GET /authen/v1/user_info（user_access_token 鉴权） */
export async function fetchUserInfo(cfg, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${authHosts(cfg.domain).open}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) throw new Error(`user_info 失败 http=${res.status} code=${j.code} ${j.msg || ''}`);
  return j.data || {};
}

/**
 * 取可用的 user_access_token：未过期直接用；将过期走单飞刷新（refresh_token 单次有效，
 * 并发镜像同时到期也只发一次刷新请求）。返回 { token, openId }；无凭据/刷新失败返回 null
 * （调用方降级 bot 卡片）。刷新失败按错误码提示：20037/20026/20064 → 需重新授权。
 */
export async function getUserAccessToken(cfg, { fetchImpl = fetch } = {}) {
  const auth = loadAuth(cfg);
  if (!auth) return null;
  if (Date.now() < (auth.access_expires_at || 0) - REFRESH_MARGIN_SEC * 1000) {
    return { token: auth.access_token, openId: auth.open_id || '' };
  }
  if (!auth.refresh_token) {
    log('auth', 'user_access_token 已过期且无 refresh_token（授权时未含 offline_access），需重新授权');
    return null;
  }
  // 单飞：同 refresh_token 的在途刷新直接复用
  const key = auth.refresh_token.slice(-16);
  flight[key] ??= (async () => {
    try {
      const j = await oauthToken(
        cfg,
        {
          grant_type: 'refresh_token',
          client_id: cfg.appId,
          client_secret: cfg.appSecret,
          refresh_token: auth.refresh_token,
        },
        fetchImpl,
      );
      const saved = saveAuth(cfg, {
        ...auth,
        access_token: j.access_token,
        access_expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
        refresh_token: j.refresh_token || auth.refresh_token,
        refresh_expires_at: j.refresh_token
          ? Date.now() + (Number(j.refresh_token_expires_in) || 604800) * 1000
          : auth.refresh_expires_at,
      });
      log('auth', `user_access_token 已刷新（${saved.name || saved.open_id || '未知用户'}）`);
      return { token: saved.access_token, openId: saved.open_id || '' };
    } catch (e) {
      if ([20037, 20026, 20064, 20073].includes(e.oauthCode)) {
        log('auth', `刷新失败（code=${e.oauthCode}）：refresh_token 已过期/无效，镜像将降级为 bot 卡片；重新授权：node cli.mjs auth-url`);
      } else {
        log('auth', '刷新失败，本次镜像降级为 bot 卡片:', e.message);
      }
      return null;
    } finally {
      delete flight[key];
    }
  })();
  return flight[key];
}

const flight = new Map(); // refresh_token 尾串 -> 在途刷新 Promise

export function randomState() {
  return crypto.randomBytes(12).toString('hex');
}
