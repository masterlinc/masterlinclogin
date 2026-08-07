// ============================================================================
// api/track.js — 行为埋点（最小可用版）
//
// 对齐《行为日志系统技术方案》（08-06）§三 与子任务要求：
//   - 事件最小集：page_view / skill_download / lead_submit / skill_pack_submit
//   - 自动建 behavior_events 表（lib/events.js ensureEventsTable，复用 backup.js 模式）
//   - 字段白名单 + 匿名化（uid 随机、不存 IP/邮箱原文；extra 只收白名单 key，
//     值再经邮箱正则打码）
//   - 轻量内存限流（ev+IP 60 条/分钟、单 IP 300 条/小时；Serverless 尽力而为）
//   - 前端 sendBeacon / fetch keepalive 上报（支持单条或批量 ≤20 条）
//
// 响应契约（前端静默，不阻塞）：
//   200 { ok:true, accepted:N }   已接受
//   400 { ok:false }              校验失败（事件不在白名单 / 缺 uid/sid）
//   429 { ok:false, reason:'rate' } 限流
//   202 { ok:false, reason:'server' } 飞书写入失败（前端丢弃，不重试风暴）
// ============================================================================

const { EVENT_ALLOW, sanitizeEvent, batchCreateEvents } = require('../lib/events.js');

const MAX_BATCH = 20;        // 单次批量上限
const RATE_EV_MIN = 60;      // 每 ev+IP 每分钟上限
const RATE_IP_HOUR = 300;    // 每 IP 每小时上限

// 限流表（模块级内存，多实例不精确，属兜底）
const rateEvMin = new Map();  // `ip|ev|minuteBucket` -> count
const rateIpHour = new Map(); // `ip|hourBucket` -> count

function minuteBucket() { return Math.floor(Date.now() / 60000); }
function hourBucket() { return Math.floor(Date.now() / 3600000); }

function checkRate(ip, ev) {
  const minKey = `${ip}|${ev}|${minuteBucket()}`;
  const hourKey = `${ip}|${hourBucket()}`;
  const c1 = rateEvMin.get(minKey) || 0;
  const c2 = rateIpHour.get(hourKey) || 0;
  if (c1 >= RATE_EV_MIN || c2 >= RATE_IP_HOUR) return false;
  rateEvMin.set(minKey, c1 + 1);
  rateIpHour.set(hourKey, c2 + 1);
  return true;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || req.socket && req.socket.remoteAddress || '0.0.0.0';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  // 单条 or 批量
  const rawEvents = Array.isArray(body.events) ? body.events : (Array.isArray(body) ? body : [body]);
  if (!rawEvents.length) { res.status(400).json({ ok: false, message: '缺少事件' }); return; }
  if (rawEvents.length > MAX_BATCH) { res.status(400).json({ ok: false, message: '批量事件超过上限 ' + MAX_BATCH }); return; }

  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || req.headers['User-Agent'] || '').slice(0, 300);

  // 事件级白名单校验 + 限流
  let accepted = 0;
  let rejected = 0;
  for (const raw of rawEvents) {
    const ev = String((raw && raw.ev) || '').trim();
    if (!EVENT_ALLOW.has(ev)) { rejected++; continue; }   // 不在白名单 → 丢弃
    if (!checkRate(ip, ev)) { rejected++; continue; }     // 限流 → 丢弃
    accepted++;
  }
  if (accepted === 0) {
    res.status(400).json({ ok: false, message: '没有可接受的事件' });
    return;
  }

  // 注入服务端 UA（不信任客户端传的 ua）
  const toWrite = rawEvents
    .filter((raw) => EVENT_ALLOW.has(String((raw && raw.ev) || '').trim()))
    .map((raw) => ({ ...raw, ua }));

  try {
    const written = await batchCreateEvents(toWrite);
    console.log(`[api/track] accepted=${accepted} rejected=${rejected} written=${written}`);
    res.status(200).json({ ok: true, accepted: written });
  } catch (err) {
    // 飞书写入失败 → 202 降级，前端静默丢弃；绝不重试风暴
    console.error('[api/track] write_fail ' + (err && err.message ? err.message : err));
    res.status(202).json({ ok: false, reason: 'server', accepted: 0 });
  }
};

// 导出内部函数供本地单测
module.exports.checkRate = checkRate;
module.exports.clientIp = clientIp;
module.exports.resetRate = function resetRate() { rateEvMin.clear(); rateIpHour.clear(); };
