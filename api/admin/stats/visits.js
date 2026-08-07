// ============================================================================
// api/admin/stats/visits.js — 访问数据（前端兼容路径 /api/admin/stats/visits）
// 复用 /api/admin/traffic 的实现（GET，?days=）
// ============================================================================
module.exports = require('../traffic.js');
