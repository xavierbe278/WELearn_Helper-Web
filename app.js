/* ============================================================
 * Welearn Helper · WEB 控制台（服务端版）
 * ------------------------------------------------------------
 * 执行模型：浏览器负责调度，所有跨域请求经 api.php 转发；
 *          每个浏览器独立持有自己的 Cookie，互不影响。
 * 与上游 Python 版对齐的行为：
 *   - 支持按单元 / 按小节选择（小节懒加载）
 *   - 默认只处理“未完成”章节，可关闭以覆盖已有成绩
 *   - 切换模式复用当前会话，无需重新登录
 *   - 任务结束后自动刷新课程与章节状态
 * ============================================================ */
(function () {
  'use strict';

  var BUILD = 'github';
  var VERSION = '2.0';
  var BUILD_ID = '2026.11.11-9';

  /* 给 api.php 也带版本号，避免 CDN / 反向代理返回旧的接口响应 */
  var API_ENDPOINT = 'api.php?v=' + encodeURIComponent(BUILD_ID);

  /* ==========================================================
   * 1. 基础工具
   * ========================================================== */
  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function clock() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 秒数 -> 05:12 / 1:05:12 */
  function fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
  }

  function setText(el, value) {
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function hasRet0(text) { return String(text == null ? '' : text).indexOf('"ret":0') !== -1; }

  /* 学校登录回调会返回 http://welearn.sflep.com/...，统一升级到 https，
     与 api.php 的白名单策略保持一致，避免登录链路出现 HTTP 400。 */
  function upgradeUpstreamUrl(url) {
    var text = String(url == null ? '' : url);
    try {
      var parsed = new URL(text, 'https://welearn.sflep.com');
      if (parsed.protocol === 'http:' && /(^|\.)sflep\.com$/i.test(parsed.hostname)) {
        parsed.protocol = 'https:';
        return parsed.href;
      }
      return text;
    } catch (e) {
      return text;
    }
  }

  /* 参数解析：'85' -> 固定；'70,90' -> 区间 */
  function parseParam(raw, mode) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) {
      throw new Error(mode === 'accuracy' ? '请输入正确率，例如 85 或 70,90' : '请输入时长秒数，例如 60 或 30,90');
    }
    var parts = text.split(/[,，]/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    var isAccuracy = mode === 'accuracy';

    if (parts.length === 1) {
      var v = Number(parts[0]);
      if (!isFinite(v) || Math.floor(v) !== v) throw new Error('参数需要是整数');
      if (isAccuracy) {
        if (v < 0 || v > 99) throw new Error('固定正确率需在 0–99 之间（100 已禁用）');
      } else {
        if (v < 0 || v > 7200) throw new Error('学习时长需在 0–7200 秒之间');
      }
      return { type: 'fixed', value: v, label: String(v) };
    }

    if (parts.length === 2) {
      var a = Number(parts[0]);
      var b = Number(parts[1]);
      if (!isFinite(a) || !isFinite(b) || Math.floor(a) !== a || Math.floor(b) !== b) {
        throw new Error('区间需要是两个整数，例如 70,90');
      }
      if (a > b) throw new Error('区间下限不能大于上限');
      if (isAccuracy) {
        if (a < 0 || b > 100) throw new Error('正确率区间需在 0–100 之间');
      } else {
        if (a < 0 || b > 7200) throw new Error('时长区间需在 0–7200 秒之间');
      }
      return { type: 'range', min: a, max: b, label: a + '–' + b };
    }

    throw new Error('格式不正确：单个数字，或“下限,上限”');
  }

  /* 解析 getscoinfo_v7 返回的 cmi（comment 可能是对象，也可能是 JSON 字符串） */
  function parseCmi(body) {
    var empty = { crate: '', cstatus: 'not_attempted', progress: '0', total_time: '0', session_time: '0' };
    var obj = body;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { return empty; }
    }
    if (!obj || typeof obj !== 'object') return empty;

    var comment = obj.comment;
    if (typeof comment === 'string') {
      try { comment = JSON.parse(comment); } catch (e) { return empty; }
    }
    if (!comment || typeof comment !== 'object' || !comment.cmi) return empty;

    var cmi = comment.cmi;
    var score = cmi.score || {};
    return {
      crate: score.scaled == null ? '' : String(score.scaled),
      cstatus: cmi.completion_status == null ? 'not_attempted' : String(cmi.completion_status),
      progress: cmi.progress_measure == null ? '0' : String(cmi.progress_measure),
      total_time: cmi.total_time == null ? '0' : String(cmi.total_time),
      session_time: cmi.session_time == null ? '0' : String(cmi.session_time)
    };
  }

  /* 并发闸门 */
  function Semaphore(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
  }
  Semaphore.prototype.acquire = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (self.active < self.limit) {
        self.active++;
        resolve();
      } else {
        self.queue.push(resolve);
      }
    });
  };
  Semaphore.prototype.release = function () {
    if (this.queue.length) {
      var next = this.queue.shift();
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  };

  /* ==========================================================
   * 2. 常量
   * ========================================================== */
  var API = {
    prelogin: 'https://welearn.sflep.com/user/prelogin.aspx?loginret=http://welearn.sflep.com/user/loginredirect.aspx',
    authCourse: 'https://welearn.sflep.com/ajax/authCourse.aspx?action=gmc',
    courseInfo: function (cid) {
      return 'https://welearn.sflep.com/student/course_info.aspx?cid=' + encodeURIComponent(cid);
    },
    studyStat: 'https://welearn.sflep.com/ajax/StudyStat.aspx',
    sco: 'https://welearn.sflep.com/Ajax/SCO.aspx',
    ssoLogin: 'https://sso.sflep.com/idsvr/account/login'
  };

  var SCO_DATA_TEMPLATE = '{"cmi":{"completion_status":"completed","interactions":[],"launch_data":"",' +
    '"progress_measure":"1","score":{"scaled":"{crate}","raw":"100"},' +
    '"session_time":"0","success_status":"unknown","total_time":"0","mode":"normal"},' +
    '"adl":{"data":[]},"cci":{"data":[],"service":{"dictionary":{"headword":"",' +
    '"short_cuts":""},"new_words":[],"notes":[],"writing_marking":[],"record":' +
    '{"files":[]},"play":{"offline_media_id":"9999"}},"retry_count":"0",' +
    '"submit_time":""}}[INTERACTIONINFO]';

  var PRESETS = {
    accuracy: [
      { label: '96', value: '96' },
      { label: '97', value: '97' },
      { label: '98', value: '98' },
      { label: '99', value: '99' },
      { label: '94–100', value: '94,100' }
    ],
    time: [
      { label: '480', value: '480' },
      { label: '500', value: '500' },
      { label: '520', value: '520' },
      { label: '480–520', value: '480,520' }
    ]
  };

  var KEY_THEME = 'wl_theme';
  var KEY_SESSION = 'wl_session_v2';
  var SESSION_TTL = 7 * 24 * 3600 * 1000;   // 登录状态保留 7 天，失效后自动清除

  /* 一键完成的默认参数 */
  var ONE_CLICK = {
    accuracy: { min: 96, max: 100 },
    time: { min: 480, max: 580 }
  };

  /* ==========================================================
   * 3. 状态
   * ========================================================== */
  var state = {
    mode: 'accuracy',
    loggedIn: false,
    user: '',
    courses: [],
    course: null,
    meta: null,          // { uid, classid, cid }
    units: [],
    sections: {},        // unitNo -> chapter[]
    sectionsLoading: {},
    running: false,
    loading: 0,
    runner: null,
    startedAt: 0,
    phaseLabel: '',
    queuing: false,
    queueCancelled: false,
    timePhaseVisible: false,
    stopping: false,
    ticker: null,
    restoring: false
  };

  var ui = {};

  /* ==========================================================
   * 4. 网络（经 api.php 代理）
   * ========================================================== */
  var net = {
    cookie: {},

    header: function () {
      return Object.keys(this.cookie).map(function (k) {
        return k + '=' + this.cookie[k];
      }, this).join('; ');
    },

    absorb: function (list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var pair = String(list[i] || '');
        var idx = pair.indexOf('=');
        if (idx <= 0) continue;
        var key = pair.slice(0, idx).trim();
        var val = pair.slice(idx + 1).trim();
        if (key) this.cookie[key] = val;
      }
    },

    clear: function () { this.cookie = {}; },

    call: async function (url, opts) {
      opts = opts || {};
      url = upgradeUpstreamUrl(url);
      var method = opts.method || 'GET';
      var body = opts.body == null ? '' : String(opts.body);
      var headers = opts.headers || {};
      var timeout = opts.timeout || 65000;

      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
      var res;
      try {
        res = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url, method: method, body: body, headers: headers, cookie: this.header() }),
          signal: ctrl ? ctrl.signal : undefined
        });
      } catch (e) {
        throw new Error(e && e.name === 'AbortError'
          ? '请求超时（' + Math.round(timeout / 1000) + ' 秒），请重试'
          : '无法连接代理接口 api.php，请检查部署与网络');
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) throw new Error('代理接口异常：HTTP ' + res.status);

      var data;
      try { data = await res.json(); } catch (e) { throw new Error('代理接口返回了非 JSON 数据'); }
      if (!data || typeof data !== 'object') throw new Error('代理接口返回为空');
      if (data.error) throw new Error(String(data.error));

      this.absorb(data.newCookies);
      return data;
    }
  };

  async function apiPost(payload) {
    var res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function parseCookieString(raw) {
    var out = {};
    String(raw || '').split(';').forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx <= 0) return;
      var key = pair.slice(0, idx).trim();
      var val = pair.slice(idx + 1).trim();
      if (key) out[key] = val;
    });
    return out;
  }

  async function postForm(url, fields, headers) {
    var body = new URLSearchParams();
    Object.keys(fields || {}).forEach(function (k) { body.set(k, String(fields[k])); });
    var res = await net.call(url, {
      method: 'POST',
      body: body.toString(),
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, headers || {})
    });
    return res.body;
  }

  function postSco(fields, referer) {
    return postForm(API.sco, fields, referer ? { Referer: referer } : {});
  }

  /* ==========================================================
   * 5. 通知 / 日志 / 状态
   * ========================================================== */
  function toast(message, type, ms) {
    if (!ui.toasts) return;
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');

    var icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.textContent = type === 'ok' ? '✓' : (type === 'err' ? '!' : 'i');

    var msg = document.createElement('span');
    msg.className = 'toast__msg';
    msg.textContent = String(message);

    el.appendChild(icon);
    el.appendChild(msg);
    ui.toasts.appendChild(el);

    var ttl = ms || (type === 'err' ? 6000 : 3800);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
      el.style.transition = 'opacity .18s, transform .18s';
      setTimeout(function () { el.remove(); }, 200);
    }, ttl);
  }

  var MAX_LOG_LINES = 3000;

  function appendLogLine(box, message, level) {
    if (!box) return null;
    var line = document.createElement('div');
    line.className = 'log__line' + (level && level !== 'info' ? ' is-' + level : '');

    var time = document.createElement('span');
    time.className = 'log__t';
    time.textContent = clock();

    var msg = document.createElement('span');
    msg.className = 'log__m';
    msg.textContent = String(message);

    line.appendChild(time);
    line.appendChild(msg);
    box.appendChild(line);
    return line;
  }

  function addLog(message, level) {
    var box = ui.logBox;
    if (!box) return;
    appendLogLine(box, message, level);

    while (box.childElementCount > MAX_LOG_LINES) {
      box.removeChild(box.firstElementChild);
    }
    if (!ui.autoScroll || ui.autoScroll.checked) box.scrollTop = box.scrollHeight;

    updateMobileLog(String(message), level);

    /* 手机端日志面板打开时同步追加，避免用户错过实时进度 */
    if (ui.logModal && !ui.logModal.hidden && ui.logSheet) {
      appendLogLine(ui.logSheet, message, level);
      while (ui.logSheet.childElementCount > MAX_LOG_LINES) {
        ui.logSheet.removeChild(ui.logSheet.firstElementChild);
      }
      ui.logSheet.scrollTop = ui.logSheet.scrollHeight;
      setText(ui.logModalStatus, ui.statusLine ? ui.statusLine.textContent : '');
    }
  }

  function updateMobileLog(message, level) {
    if (!ui.mobileLogLast) return;
    ui.mobileLogLast.textContent = message;
    if (!ui.mobileLog) return;
    if (level === 'err') {
      ui.mobileLog.classList.add('is-error');
      ui.mobileLog.classList.remove('is-live');
    } else if (level === 'ok') {
      ui.mobileLog.classList.remove('is-error');
    }
  }

  var topNoticeTimer = null;

  function showTopNotice(text, tone, sticky) {
    if (!ui.topNoticeWrap) return;
    ui.topNoticeWrap.hidden = false;
    if (ui.topNotice) {
      ui.topNotice.className = 'top-notice is-' + (tone || 'info');
      ui.topNotice.title = text;
    }
    setText(ui.topNoticeText, text);
    if (topNoticeTimer) {
      clearTimeout(topNoticeTimer);
      topNoticeTimer = null;
    }
    if (!sticky) {
      topNoticeTimer = setTimeout(hideTopNotice, tone === 'error' ? 9000 : 6000);
    }
  }

  function hideTopNotice() {
    if (topNoticeTimer) {
      clearTimeout(topNoticeTimer);
      topNoticeTimer = null;
    }
    if (ui.topNoticeWrap) ui.topNoticeWrap.hidden = true;
  }

  function setStatus(text, tone) {
    setText(ui.statusText, text);
    setText(ui.statusLine, text);
    if (ui.statusPill) {
      ui.statusPill.classList.toggle('is-running', tone === 'run');
      ui.statusPill.classList.toggle('is-error', tone === 'error');
    }
    if (ui.consoleEl) ui.consoleEl.classList.toggle('is-live', tone === 'run');
    if (ui.mobileLogStatus) ui.mobileLogStatus.textContent = String(text);
    if (ui.mobileLog) {
      ui.mobileLog.classList.toggle('is-live', tone === 'run');
      if (tone === 'run') ui.mobileLog.classList.remove('is-error');
      if (tone === 'error') ui.mobileLog.classList.add('is-error');
    }
  }

  function setProgress(done, total) {
    if (!ui.progressFill || !ui.progressText) return;
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
    ui.progressFill.style.width = pct + '%';
    ui.progressText.textContent = total > 0 ? done + '/' + total : '0%';
  }

  /* ==========================================================
   * 6. 主题
   * ========================================================== */
  function readTheme() {
    try {
      return localStorage.getItem(KEY_THEME) === 'dark' ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function applyTheme(theme) {
    var next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY_THEME, next); } catch (e) { /* ignore */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#070d16' : '#f3f6fa');
    if (ui.themeBtn) {
      ui.themeBtn.setAttribute('aria-label', next === 'dark' ? '切换到浅色' : '切换到深色');
      ui.themeBtn.title = next === 'dark' ? '切换到浅色' : '切换到深色';
    }
  }

  /* ==========================================================
   * 7. 登录 / 课程 / 单元 / 小节
   * ========================================================== */
  async function loginFlow(user, password) {
    addLog('正在获取登录入口…');

    var pre = await net.call(API.prelogin);
    var locationUrl = pre.headers && pre.headers.location;
    if (!locationUrl) throw new Error('未获取到登录重定向地址，请稍后重试');

    var rturl = '';
    try {
      var parsed = new URL(locationUrl, 'https://welearn.sflep.com');
      var challenge = parsed.searchParams.get('code_challenge') || '';
      var st = parsed.searchParams.get('state') || '';
      rturl = '/connect/authorize/callback?client_id=welearn_web' +
        '&redirect_uri=https%3A%2F%2Fwelearn.sflep.com%2Fsignin-sflep' +
        '&response_type=code&scope=openid%20profile%20email%20phone%20address' +
        '&code_challenge=' + encodeURIComponent(challenge) +
        '&code_challenge_method=S256&state=' + encodeURIComponent(st) +
        '&x-client-SKU=ID_NET472&x-client-ver=6.32.1.0';
    } catch (e) {
      rturl = '/connect/authorize/callback?client_id=welearn_web' +
        '&redirect_uri=https%3A%2F%2Fwelearn.sflep.com%2Fsignin-sflep' +
        '&response_type=code&scope=openid%20profile%20email%20phone%20address';
    }

    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        addLog('登录服务返回重试信号，' + (attempt + 1) + '/3 次重试…', 'warn');
        await sleep(1200);
      }

      var cipher = generateCipherText(password);
      var payload = new URLSearchParams();
      payload.set('rturl', rturl);
      payload.set('account', user);
      payload.set('pwd', cipher[0]);
      payload.set('ts', String(cipher[1]));

      var loginRes = await net.call(API.ssoLogin, {
        method: 'POST',
        body: payload.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
      });

      var loginData;
      try {
        loginData = JSON.parse(loginRes.body);
      } catch (e) {
        throw new Error('登录响应异常（可能触发风控），请稍后重试');
      }

      if (loginData.code === 1) throw new Error('账号或密码错误');
      if (loginData.code === -1) continue;   // 上游语义：服务端临时拒绝，重试
      if (loginData.code !== 0) throw new Error('登录返回异常：' + (loginData.msg || '未知错误'));
      if (!loginData.data) throw new Error('登录返回数据缺失，请稍后重试');

      addLog('登录成功，正在处理单点登录回调…');
      var nextUrl = 'https://sso.sflep.com/idsvr' + loginData.data;
      for (var hop = 0; hop < 12; hop++) {
        var rd = await net.call(nextUrl);
        var loc = rd.headers && rd.headers.location;
        if ([301, 302, 303, 307, 308].indexOf(Number(rd.status)) !== -1 && loc) {
          nextUrl = new URL(loc, nextUrl).href;
        } else {
          break;
        }
      }
      return;
    }

    throw new Error('登录失败：连续多次被服务端拒绝，可能是设备时间不准或触发风控');
  }

  async function loadCourses() {
    var res = await net.call(API.authCourse, {
      headers: { Referer: 'https://welearn.sflep.com/2019/student/index.aspx' }
    });
    var data;
    try { data = JSON.parse(res.body); } catch (e) { throw new Error('会话可能已失效，请重新登录'); }
    if (!data || !Array.isArray(data.clist)) throw new Error('课程数据格式异常');
    if (!data.clist.length) throw new Error('没有读到课程：可能无课或会话已失效');
    state.courses = data.clist;
    return data.clist;
  }

  async function loadUnits(course) {
    var info = await net.call(API.courseInfo(course.cid));
    var text = String(info.body == null ? '' : info.body);

    var uidMatch = text.match(/"uid"\s*:\s*"?([0-9A-Za-z_-]{1,40})"?/);
    var classMatch = text.match(/"classid"\s*:\s*"?([0-9A-Za-z_-]{1,40})"?/);
    if (!uidMatch || !classMatch) throw new Error('无法解析课程信息，会话可能已过期');

    var uid = uidMatch[1];
    var classid = classMatch[1];
    var url = API.studyStat + '?' + new URLSearchParams({
      action: 'courseunits', cid: String(course.cid), uid: uid
    }).toString();

    var res = await net.call(url, {
      headers: { Referer: 'https://welearn.sflep.com/2019/student/course_info.aspx' }
    });
    var data;
    try { data = JSON.parse(res.body); } catch (e) { throw new Error('获取单元列表失败'); }
    if (!data || !Array.isArray(data.info)) throw new Error('该课程没有可用的单元');

    state.meta = { uid: uid, classid: classid, cid: course.cid };
    state.units = data.info;
    state.sections = {};
    state.sectionsLoading = {};
    return data.info;
  }

  async function fetchSections(unitNo) {
    if (!state.meta || !state.course) throw new Error('课程信息未就绪');
    var url = API.studyStat + '?' + new URLSearchParams({
      action: 'scoLeaves',
      cid: String(state.course.cid),
      uid: String(state.meta.uid),
      unitidx: String(unitNo - 1),
      classid: String(state.meta.classid)
    }).toString();

    var res = await net.call(url, {
      headers: { Referer: 'https://welearn.sflep.com/2019/student/course_info.aspx?cid=' + state.course.cid }
    });
    var text = String(res.body == null ? '' : res.body);
    if (!text || text.indexOf('异常') !== -1 || text.indexOf('出错了') !== -1) {
      throw new Error('单元不存在或已到末尾');
    }

    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('小节数据解析失败'); }
    if (!data || !Array.isArray(data.info)) throw new Error('该单元没有小节');

    return data.info.map(function (ch, i) {
      var complete = String(ch.iscomplete == null ? '未' : ch.iscomplete);
      return {
        id: ch.id,
        index: i + 1,
        location: String(ch.location == null ? '未命名小节' : ch.location),
        visible: String(ch.isvisible == null ? 'true' : ch.isvisible) !== 'false',
        done: complete.indexOf('未') === -1
      };
    });
  }

  /* ==========================================================
   * 8. 任务执行引擎
   * ========================================================== */
  function Runner(opts) {
    this.mode = opts.mode;
    this.param = opts.param;
    this.targets = opts.targets;
    this.course = opts.course;
    this.meta = opts.meta;
    this.units = opts.units;
    this.skipDone = !!opts.skipDone;
    this.concurrency = Math.max(1, Math.min(50, Number(opts.concurrency) || 10));
    this.onLog = opts.onLog;
    this.onProgress = opts.onProgress;
    this.onStatus = opts.onStatus;

    this.stopped = false;
    this._stopResolve = null;
    this._stopPromise = new Promise(function (resolve) { this._stopResolve = resolve; }.bind(this));

    this.done = 0;
    this.total = 0;
    this.way1 = { ok: 0, fail: 0 };
    this.way2 = { ok: 0, fail: 0 };
    this.ok = 0;
    this.failed = 0;
    this.errors = [];
    this.creditedSeconds = 0;   // 已成功提交给服务器的有效时长（秒）
    this.startedAt = Date.now();
    this.activeDeadlines = {};   // chapterId -> 结束时间戳，用于运行中剩余时间显示
  }

  Runner.prototype.log = function (msg, level) { this.onLog(msg, level); };

  Runner.prototype.stop = function () {
    if (this.stopped) return;
    this.stopped = true;
    if (this._stopResolve) this._stopResolve();
  };

  /* 供运行条 / 手机日志条显示：已运行、当前批次最长剩余、进行中章节数
   * 估算用“并发时间线”而不是简单轮数：
   * - 启动错峰/信号量排队的章节先按并发位预约，避免被重复算进 pending；
   * - 每个待处理章节落到最早空闲的并发位，能正确处理最后一轮不满、连续补位。 */
  Runner.prototype.getRuntimeInfo = function () {
    var now = Date.now();
    var remaining = 0;
    var active = 0;
    var deadlines = [];
    Object.keys(this.activeDeadlines).forEach(function (key) {
      var left = this.activeDeadlines[key] - now;
      if (left > 0) {
        active++;
        deadlines.push(left);
        if (left > remaining) remaining = left;
      }
    }, this);

    var per;
    if (this.mode === 'time') {
      var avg = this.param.type === 'range' ? (this.param.min + this.param.max) / 2 : this.param.value;
      per = Math.max(1, Number(avg) || 0) + 4;   // 每章约 4 秒请求/收尾开销
    } else {
      per = 3.3;
    }

    var leftChapters = Math.max(0, this.total - this.done);
    var slotCount = this.mode === 'time' ? this.concurrency : 1;
    var effectiveActive = Math.min(Math.max(1, slotCount), leftChapters);
    var pending = Math.max(0, leftChapters - effectiveActive);
    var slots = [];

    // 已经在真实等待的章节，用真实 deadline
    for (var i = 0; i < deadlines.length && slots.length < effectiveActive; i++) {
      slots.push(now + deadlines[i]);
    }
    // 还没进入等待的并发位：按一个平均章节时长预约，防止重复计入 pending
    while (slots.length < effectiveActive) {
      slots.push(now + per * 1000);
    }

    // 剩余章节落到最早空闲的并发位
    for (var p = 0; p < pending; p++) {
      var minIndex = 0;
      for (var k = 1; k < slots.length; k++) {
        if (slots[k] < slots[minIndex]) minIndex = k;
      }
      slots[minIndex] += per * 1000;
    }

    var finishAt = slots.length ? Math.max.apply(null, slots) : now;
    var estimate = this.total ? Math.max(0, Math.ceil((finishAt - now) / 1000)) : 0;

    return {
      elapsed: Math.floor((now - this.startedAt) / 1000),
      remaining: Math.ceil(remaining / 1000),
      estimate: estimate,
      active: active,
      done: this.done,
      total: this.total
    };
  };

  /* 可中断等待：停止时立即返回 false */
  Runner.prototype.sleep = function (ms) {
    if (this.stopped) return Promise.resolve(false);
    if (!ms) return Promise.resolve(true);
    var timer;
    var wait = new Promise(function (resolve) { timer = setTimeout(function () { resolve(true); }, ms); });
    return Promise.race([wait, this._stopPromise.then(function () { return false; })]).then(function (value) {
      if (!value) clearTimeout(timer);
      return value;
    });
  };

  Runner.prototype.emitProgress = function () {
    if (this.onProgress) this.onProgress(this.done, this.total);
  };

  Runner.prototype.pickValue = function () {
    if (this.param.type === 'range') return randInt(this.param.min, this.param.max);
    return this.param.value;
  };

  Runner.prototype.collect = async function () {
    var plans = [];
    for (var i = 0; i < this.targets.unitNos.length; i++) {
      if (this.stopped) break;
      var no = this.targets.unitNos[i];
      var unit = this.units[no - 1];
      if (!unit) continue;

      this.onStatus('读取单元 ' + no + ' 的章节…');
      var chapters;
      try {
        // 已在小节树里加载过就直接复用，避免重复请求
        chapters = state.sections[no] || await fetchSections(no);
        state.sections[no] = chapters;
      } catch (e) {
        this.log('[!] 单元 ' + no + ' 不可用，已跳过：' + e.message, 'warn');
        continue;
      }

      var wanted = this.targets.sections && this.targets.sections[no];
      var picked = chapters;
      if (wanted && wanted.length) {
        picked = chapters.filter(function (ch) { return wanted.indexOf(ch.index) !== -1; });
      }
      if (!picked.length) {
        this.log('[!] 单元 ' + no + ' 没有匹配的小节，已跳过', 'warn');
        continue;
      }

      var name = String(unit.unitname || '') + ' ' + String(unit.name || '');
      name = name.trim() || ('单元 ' + no);
      plans.push({ no: no, name: name, chapters: picked });
      this.log('单元 ' + no + ' · ' + name + '：' + picked.length + ' 个章节');
    }
    return plans;
  };

  Runner.prototype.run = async function () {
    var plans = await this.collect();
    if (this.stopped) return this.summary();
    if (!plans.length) throw new Error('没有可处理的章节，请检查单元 / 小节选择');

    if (this.mode === 'accuracy') {
      await this.runAccuracy(plans);
    } else {
      await this.runTime(plans);
    }
    return this.summary();
  };

  Runner.prototype.summary = function () {
    if (this.mode === 'accuracy') {
      return {
        mode: 'accuracy', done: this.done, total: this.total,
        way1: this.way1, way2: this.way2, stopped: this.stopped,
        creditedSeconds: 0
      };
    }
    return {
      mode: 'time', done: this.done, total: this.total,
      ok: this.ok, failed: this.failed, errors: this.errors.slice(), stopped: this.stopped,
      creditedSeconds: Math.round(this.creditedSeconds)
    };
  };

  /* ---- 正确率 ---- */
  Runner.prototype.runAccuracy = async function (plans) {
    this.total = plans.reduce(function (n, p) { return n + p.chapters.length; }, 0);
    this.emitProgress();

    for (var i = 0; i < plans.length; i++) {
      if (this.stopped) break;
      var plan = plans[i];
      this.onStatus('正确率 · 单元 ' + plan.no + '：' + plan.name);

      for (var j = 0; j < plan.chapters.length; j++) {
        if (this.stopped) break;
        var chapter = plan.chapters[j];
        try {
          await this.stepAccuracy(plan, chapter);
        } finally {
          this.done++;
          this.emitProgress();
        }
      }
    }
    if (this.stopped) this.log('正确率流程已手动终止。', 'warn');
  };

  Runner.prototype.stepAccuracy = async function (plan, chapter) {
    if (!chapter.visible) {
      this.log('[跳过] 未开放：' + chapter.location, 'dim');
      return;
    }
    if (this.skipDone && chapter.done) {
      this.log('[跳过] 已完成：' + chapter.location, 'dim');
      return;
    }

    var crate = String(this.pickValue());
    var data = SCO_DATA_TEMPLATE.replace('{crate}', crate);
    var cid = this.course.cid;
    var scoid = chapter.id;
    var referer = 'https://welearn.sflep.com/Student/StudyCourse.aspx?cid=' + cid +
      '&classid=' + this.meta.classid + '&sco=' + scoid;

    this.log('▶ ' + chapter.location + ' → 目标 ' + crate + '%');

    try {
      if (!(await this.sleep(1000))) return;
      await postSco({ action: 'startsco160928', cid: cid, scoid: scoid, uid: this.meta.uid }, referer);

      if (!(await this.sleep(1000))) return;
      var way1 = await postSco({
        action: 'setscoinfo', cid: cid, scoid: scoid, uid: this.meta.uid,
        data: data, isend: 'False'
      }, referer);

      if (!(await this.sleep(1000))) return;
      var way2 = await postSco({
        action: 'savescoinfo160928', cid: cid, scoid: scoid, uid: this.meta.uid,
        progress: '100', crate: crate, status: 'unknown', cstatus: 'completed', trycount: '0'
      }, referer);

      var ok1 = hasRet0(way1);
      var ok2 = hasRet0(way2);
      if (ok1) this.way1.ok++; else this.way1.fail++;
      if (ok2) this.way2.ok++; else this.way2.fail++;

      if (ok1 && ok2) {
        this.log('✔ ' + chapter.location + ' 提交成功（' + crate + '%）', 'ok');
      } else {
        this.log('✘ ' + chapter.location + ' 未被服务端确认（方式1 ' + (ok1 ? '成功' : '失败') +
          ' / 方式2 ' + (ok2 ? '成功' : '失败') + '）', 'err');
      }
    } catch (e) {
      this.way1.fail++;
      this.way2.fail++;
      this.log('✘ ' + chapter.location + ' 提交异常：' + e.message, 'err');
    }
  };

  /* ---- 学习时长 ---- */
  Runner.prototype.runTime = async function (plans) {
    var self = this;
    var queue = [];
    var hidden = 0;

    plans.forEach(function (plan) {
      plan.chapters.forEach(function (ch) {
        if (ch.visible) queue.push({ plan: plan, chapter: ch });
        else hidden++;
      });
    });

    this.total = queue.length + hidden;
    this.done = hidden;
    this.emitProgress();

    if (hidden) this.log('已跳过 ' + hidden + ' 个未开放章节', 'dim');
    if (!queue.length) return;

    this.startedAt = Date.now();
    this.log('⏳ 时长任务开始：共 ' + queue.length + ' 个可见章节，单章节 ' +
      (this.param.type === 'range' ? this.param.min + '–' + this.param.max : this.param.value) +
      ' 秒；运行期间请保持页面开启，不要关闭浏览器。', 'info');

    var sem = new Semaphore(this.concurrency);
    var workers = queue.map(function (item, index) {
      return self.timeWorker(item, index, sem);
    });

    /* 每 60 秒在日志里报一次进度与剩余时间，避免长时间等待没有任何反馈 */
    var heartbeat = setInterval(function () {
      if (self.stopped) return;
      var info = self.getRuntimeInfo();
      self.log('⏳ 已运行 ' + fmtDuration(info.elapsed) + ' · 进度 ' + info.done + '/' + info.total +
        (info.active
          ? ' · 进行中 ' + info.active + ' 个章节 · 本轮剩余约 ' + fmtDuration(info.remaining)
          : '') +
        ' · 总计剩余约 ' + fmtDuration(info.estimate),
        'info');
    }, 60000);

    try {
      await Promise.all(workers);
    } finally {
      clearInterval(heartbeat);
    }
    if (this.stopped) this.log('时长流程已手动终止。', 'warn');
  };

  Runner.prototype.timeWorker = async function (item, index, sem) {
    if (this.stopped) return;

    // 起始错峰：避免同一瞬间打出大量请求
    if (index > 0) {
      var ok = await this.sleep(Math.min(index * 500, 12000));
      if (!ok) return;
    }

    await sem.acquire();
    try {
      if (this.stopped) return;
      this.onStatus('时长 · ' + item.chapter.location);
      await this.simulate(item.chapter);
      this.ok++;
    } catch (e) {
      this.failed++;
      this.errors.push(item.chapter.location);
      this.log('✘ ' + item.chapter.location + '：' + e.message, 'err');
    } finally {
      sem.release();
      this.done++;
      this.emitProgress();
    }
  };

  /* 停止时提交停止前真实等待过的时长（平台按会话真实时间结算） */
  Runner.prototype.submitPartial = async function (base, cmi, referer, waited) {
    try {
      await postSco(Object.assign({}, base, {
        action: 'keepsco_with_getticket_with_updatecmitime',
        session_time: cmi.session_time,
        total_time: cmi.total_time
      }), referer);
      var saved = await postSco(Object.assign({}, base, {
        action: 'savescoinfo160928',
        crate: cmi.crate,
        cstatus: cmi.cstatus,
        status: 'unknown',
        progress: cmi.progress,
        trycount: '0'
      }), referer);
      if (hasRet0(saved)) {
        this.creditedSeconds += Math.max(0, Math.round(waited));
        this.log('✔ ' + (waited > 0
          ? '已提交停止前等待的 ' + waited + ' 秒'
          : '已提交停止前的实际等待时长'), 'ok');
      } else {
        this.log('停止前的部分时长提交未被服务端确认', 'warn');
      }
    } catch (e) {
      this.log('停止前的部分时长提交失败：' + e.message, 'warn');
    }
  };

  Runner.prototype.simulate = async function (chapter) {
    var seconds = this.pickValue();
    var base = { uid: this.meta.uid, cid: this.course.cid, scoid: chapter.id };
    var referer = 'https://welearn.sflep.com/student/StudyCourse.aspx';

    this.log('▶ ' + chapter.location + ' · 目标 ' + seconds + ' 秒');

    var info = await postSco(Object.assign({}, base, { action: 'getscoinfo_v7' }), referer);
    if (String(info).indexOf('学习数据不正确') !== -1) {
      if (!(await this.sleep(1500))) return;
      await postSco(Object.assign({}, base, { action: 'startsco160928' }), referer);
      info = await postSco(Object.assign({}, base, { action: 'getscoinfo_v7' }), referer);
      if (String(info).indexOf('学习数据不正确') !== -1) {
        throw new Error('学习数据不正确（章节可能未开放或已被重置）');
      }
    }

    var cmi = parseCmi(info);
    var waitStartedAt = Date.now();
    var ready = await this.sleep(1200);
    if (!ready) {
      await this.submitPartial(base, cmi, referer, Math.floor((Date.now() - waitStartedAt) / 1000));
      return;
    }

    await postSco(Object.assign({}, base, {
      action: 'keepsco_with_getticket_with_updatecmitime',
      session_time: cmi.session_time,
      total_time: cmi.total_time
    }), referer);

    /* 关键：按“真实时间”结算，而不是数 1 秒的定时器。
       浏览器后台会限制定时器频率；按墙钟判断可在唤醒后立刻补齐，
       不会把 60 秒的任务拖成 60 分钟。 */
    var deadline = Date.now() + seconds * 1000;
    this.activeDeadlines[chapter.id] = deadline;

    try {
      var nextBeat = Date.now() + 60000;

      while (Date.now() < deadline) {
        var remain = deadline - Date.now();
        var alive = await this.sleep(Math.min(1000, remain));
        if (!alive) {
          var waited = Math.min(seconds, Math.max(0, Math.floor((Date.now() - waitStartedAt) / 1000)));
          this.log('[停止] ' + chapter.location + ' 已等待 ' + waited + ' 秒，正在提交这部分时长…', 'warn');
          await this.submitPartial(base, cmi, referer, waited);
          return;
        }
        if (Date.now() >= nextBeat) {
          nextBeat = Date.now() + 60000;
          await postSco(Object.assign({}, base, {
            action: 'keepsco_with_getticket_with_updatecmitime',
            session_time: cmi.session_time,
            total_time: cmi.total_time
          }), referer);
        }
      }

      await this.sleep(1200);   // 已停止也继续提交，避免丢掉已等待的时长
      var saved = await postSco(Object.assign({}, base, {
        action: 'savescoinfo160928',
        crate: cmi.crate,
        cstatus: cmi.cstatus,
        status: 'unknown',
        progress: cmi.progress,
        trycount: '0'
      }), referer);

      if (!hasRet0(saved)) throw new Error('服务端未确认保存，稍后重试该章节');
      this.creditedSeconds += seconds;
      this.log('✔ ' + chapter.location + ' 时长已计入', 'ok');
    } finally {
      delete this.activeDeadlines[chapter.id];
    }
  };

  /* ==========================================================
   * 8.1 任务编排：普通任务 = 1 个阶段；一键完成 = 正确率 + 时长
   * ========================================================== */
  function Job(phases, opts) {
    this.phases = phases;
    this.opts = opts;
    this.stopped = false;
    this.active = null;
    this.results = [];
  }

  Job.prototype.stop = function () {
    this.stopped = true;
    if (this.active) this.active.stop();
  };

  Job.prototype.getRuntimeInfo = function () {
    if (this.active) return this.active.getRuntimeInfo();
    return { elapsed: 0, remaining: 0, active: 0, done: 0, total: 0 };
  };

  Job.prototype.run = async function () {
    var self = this;
    var multi = this.phases.length > 1;
    for (var i = 0; i < this.phases.length; i++) {
      if (this.stopped) break;
      var phase = this.phases[i];

      this.opts.onProgress(0, 0);
      if (this.opts.onPhase) this.opts.onPhase(phase.label, i + 1, this.phases.length, phase.mode);
      this.opts.onStatus((multi ? '一键完成 ' + (i + 1) + '/' + this.phases.length + ' · ' : '') + phase.label);
      if (multi) {
        this.opts.onLog('—— 阶段 ' + (i + 1) + '/' + this.phases.length + '：' + phase.label + ' ——', 'info');
      }

      var runner = new Runner({
        mode: phase.mode,
        param: phase.param,
        targets: this.opts.targets,
        course: this.opts.course,
        meta: this.opts.meta,
        units: this.opts.units,
        skipDone: phase.skipDone,
        concurrency: this.opts.concurrency,
        onLog: this.opts.onLog,
        onProgress: this.opts.onProgress,
        onStatus: function (text) {
          self.opts.onStatus(phase.label + ' · ' + text);
        }
      });

      this.active = runner;

      var phaseResult;
      try {
        phaseResult = await runner.run();
      } catch (e) {
        if (phase.optional) {
          this.opts.onLog('[跳过] ' + phase.label + '：' + e.message, 'warn');
          this.active = null;
          continue;
        }
        this.active = null;
        throw e;
      }
      this.active = null;

      this.results.push({ mode: phase.mode, label: phase.label, param: phase.param, result: phaseResult });
      if (phaseResult.stopped) {
        this.stopped = true;
        break;
      }
    }

    return { mode: 'oneclick', phases: this.results.slice(), stopped: this.stopped };
  };

  /* ==========================================================
   * 9. 界面渲染
   * ========================================================== */
  function renderCourses() {
    var sel = ui.courseSelect;
    if (!sel) return;
    sel.innerHTML = '';

    if (!state.courses.length) {
      sel.appendChild(new Option(state.loggedIn ? '— 没有可用课程 —' : '— 请先登录 —', ''));
      setText(ui.courseSummary, '未加载');
      return;
    }

    state.courses.forEach(function (course) {
      var label = String(course.name || '未命名课程') + ' · 完成度 ' + (course.per == null ? '?' : course.per) + '%';
      sel.appendChild(new Option(label, String(course.cid)));
    });

    var current = state.course || state.courses[0];
    if (current) sel.value = String(current.cid);
    setText(ui.courseSummary, '共 ' + state.courses.length + ' 门');
  }

  function renderUnits() {
    var tree = ui.unitTree;
    if (!tree) return;
    tree.innerHTML = '';

    if (!state.loggedIn) {
      tree.appendChild(emptyNode('登录并选择课程后显示单元'));
      return;
    }
    if (!state.course) {
      tree.appendChild(emptyNode('请先选择课程'));
      return;
    }
    if (!state.units.length) {
      tree.appendChild(emptyNode('该课程没有单元，或加载失败'));
      return;
    }

    state.units.forEach(function (unit, i) {
      var no = i + 1;
      var visible = String(unit.visible == null ? 'true' : unit.visible) !== 'false';

      var row = document.createElement('div');
      row.className = 'unit' + (visible ? '' : ' is-off');

      var label = document.createElement('label');
      label.className = 'unit__row';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'unit-cb';
      cb.setAttribute('data-unit', String(no));
      cb.addEventListener('change', function () { onUnitToggle(no, this); });

      var noEl = document.createElement('span');
      noEl.className = 'unit__no';
      noEl.textContent = 'NO.' + no;

      var nameEl = document.createElement('span');
      nameEl.className = 'unit__name';
      var name = (String(unit.unitname || '') + ' ' + String(unit.name || '')).trim();
      nameEl.textContent = name || ('单元 ' + no);

      label.appendChild(cb);
      label.appendChild(noEl);
      if (!visible) label.appendChild(tagNode('未开放', 'off'));
      label.appendChild(nameEl);

      var box = document.createElement('div');
      box.className = 'unit__secs';
      box.setAttribute('data-unit', String(no));

      row.appendChild(label);
      row.appendChild(box);
      tree.appendChild(row);
    });

    syncTreeLocks();
  }

  function emptyNode(text) {
    var div = document.createElement('div');
    div.className = 'tree__empty';
    div.textContent = text;
    return div;
  }

  function tagNode(text, kind) {
    var span = document.createElement('span');
    span.className = 'tag tag--' + kind;
    span.textContent = text;
    return span;
  }

  function renderSections(unitNo, chapters) {
    var box = ui.unitTree ? ui.unitTree.querySelector('.unit__secs[data-unit="' + unitNo + '"]') : null;
    if (!box) return;
    box.innerHTML = '';

    if (!chapters || !chapters.length) {
      var hint = document.createElement('div');
      hint.className = 'tree__hint';
      hint.textContent = '该单元没有小节数据';
      box.appendChild(hint);
      return;
    }

    chapters.forEach(function (ch) {
      var row = document.createElement('label');
      row.className = 'sec' + (ch.visible ? '' : ' is-off');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'sec-cb';
      cb.setAttribute('data-unit', String(unitNo));
      cb.setAttribute('data-sec', String(ch.index));
      if (!ch.visible) {
        cb.setAttribute('data-off', '1');
        cb.disabled = true;
      } else if (state.running || ui.allUnits.checked) {
        cb.disabled = true;
      }
      cb.addEventListener('change', function () {
        updateTarget();
        scheduleSave();
      });

      var no = document.createElement('span');
      no.className = 'sec__no';
      no.textContent = ch.index + '.';

      var name = document.createElement('span');
      name.className = 'sec__name';
      name.textContent = ch.location;

      row.appendChild(cb);
      row.appendChild(no);
      row.appendChild(tagNode(!ch.visible ? '未开放' : (ch.done ? '已完成' : '未完成'), !ch.visible ? 'off' : (ch.done ? 'done' : 'todo')));
      row.appendChild(name);
      box.appendChild(row);
    });
  }

  async function ensureSections(unitNo) {
    if (state.sections[unitNo]) {
      renderSections(unitNo, state.sections[unitNo]);
      return state.sections[unitNo];
    }
    if (state.sectionsLoading[unitNo]) return state.sectionsLoading[unitNo];

    var box = ui.unitTree.querySelector('.unit__secs[data-unit="' + unitNo + '"]');
    if (box) {
      box.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'tree__hint';
      loading.textContent = '小节加载中…';
      box.appendChild(loading);
    }

    var promise = fetchSections(unitNo).then(function (chapters) {
      state.sections[unitNo] = chapters;
      renderSections(unitNo, chapters);
      return chapters;
    }).catch(function (err) {
      if (box) {
        box.innerHTML = '';
        var fail = document.createElement('div');
        fail.className = 'tree__hint';
        fail.textContent = '小节加载失败：' + err.message;
        box.appendChild(fail);
      }
      addLog('单元 ' + unitNo + ' 小节加载失败：' + err.message, 'err');
      throw err;
    }).finally(function () {
      delete state.sectionsLoading[unitNo];
    });

    state.sectionsLoading[unitNo] = promise;
    return promise;
  }

  function onUnitToggle(unitNo, cb) {
    var row = cb.closest ? cb.closest('.unit') : cb.parentNode.parentNode;
    if (row) row.classList.toggle('is-open', cb.checked);
    if (cb.checked) {
      ensureSections(unitNo).catch(function () { /* 已记录日志 */ });
    }
    updateTarget();
    scheduleSave();
  }

  function syncTreeLocks() {
    if (!ui.unitTree) return;
    var busy = state.running || state.loading > 0 || state.queuing;
    var all = ui.allUnits && ui.allUnits.checked;

    $$('.unit-cb', ui.unitTree).forEach(function (cb) { cb.disabled = busy || all; });
    $$('.sec-cb', ui.unitTree).forEach(function (cb) {
      cb.disabled = busy || all || cb.getAttribute('data-off') === '1';
    });
    ui.unitTree.classList.toggle('is-locked', busy || all);
  }

  function readSelection() {
    var all = !!(ui.allUnits && ui.allUnits.checked);
    var result = { all: all, units: [], sections: {} };
    if (all || !ui.unitTree) return result;

    $$('.unit-cb', ui.unitTree).forEach(function (cb) {
      if (!cb.checked) return;
      var no = Number(cb.getAttribute('data-unit'));
      result.units.push(no);

      var secs = $$('.sec-cb[data-unit="' + no + '"]', ui.unitTree).filter(function (sc) {
        return sc.checked && !sc.disabled;
      }).map(function (sc) { return Number(sc.getAttribute('data-sec')); });

      if (secs.length) result.sections[no] = secs.sort(function (a, b) { return a - b; });
    });

    result.units.sort(function (a, b) { return a - b; });
    return result;
  }

  async function applySelection(selection) {
    if (!selection) return;
    ui.allUnits.checked = !!selection.all;
    syncAllUnits();

    if (selection.all) {
      updateTarget();
      return;
    }

    var wanted = {};
    (selection.units || []).forEach(function (no) { wanted[no] = true; });

    var jobs = [];
    $$('.unit', ui.unitTree).forEach(function (row) {
      var cb = row.querySelector('.unit-cb');
      if (!cb) return;
      var no = Number(cb.getAttribute('data-unit'));
      var check = !!wanted[no];
      cb.checked = check;
      row.classList.toggle('is-open', check);
      if (check) jobs.push(ensureSections(no).catch(function () { return null; }));
    });

    await Promise.all(jobs);

    Object.keys(selection.sections || {}).forEach(function (no) {
      var set = selection.sections[no] || [];
      $$('.sec-cb[data-unit="' + no + '"]', ui.unitTree).forEach(function (cb) {
        cb.checked = set.indexOf(Number(cb.getAttribute('data-sec'))) !== -1;
      });
    });

    syncTreeLocks();
    updateTarget();
  }

  function syncAllUnits() {
    var all = !!(ui.allUnits && ui.allUnits.checked);
    $$('.unit', ui.unitTree).forEach(function (row) {
      var cb = row.querySelector('.unit-cb');
      var open = !all && cb && cb.checked;
      row.classList.toggle('is-open', !!open);
    });
    syncTreeLocks();
    updateTarget();
  }

  function updateTarget() {
    var sel = readSelection();
    var text = '未选择单元';

    if (sel.all) {
      text = '全部单元';
    } else if (sel.units.length) {
      var secCount = 0;
      Object.keys(sel.sections).forEach(function (no) { secCount += sel.sections[no].length; });
      text = sel.units.length + ' 个单元' + (secCount ? ' · ' + secCount + ' 个小节' : '');
    }

    setText(ui.targetText, text);
  }

  function renderPresets() {
    var row = ui.presetRow;
    if (!row) return;
    row.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'presets__label';
    label.textContent = '常用：';
    row.appendChild(label);

    (PRESETS[state.mode] || []).forEach(function (preset) {
      var value = typeof preset === 'string' ? preset : preset.value;
      var text = typeof preset === 'string' ? preset : preset.label;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = text;
      btn.title = '填入 ' + value;
      btn.addEventListener('click', function () {
        ui.paramInput.value = value;
        ui.paramInput.focus();
        updateTarget();
        scheduleSave();
      });
      row.appendChild(btn);
    });
  }

  function setMode(mode, silent) {
    if (state.running) return;
    var next = mode === 'time' ? 'time' : 'accuracy';
    var changed = state.mode !== next;
    state.mode = next;

    $$('.seg[data-mode]').forEach(function (btn) {
      var active = btn.getAttribute('data-mode') === next;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (next === 'accuracy') {
      setText(ui.paramLabel, '正确率（0–99，单个值或区间）');
      if (ui.paramInput) ui.paramInput.placeholder = '例如 96 或 94,100';
    } else {
      setText(ui.paramLabel, '每章节学习时长（秒，单个值或区间）');
      if (ui.paramInput) ui.paramInput.placeholder = '例如 480 或 480,520';
    }

    if (ui.concurrencyField) ui.concurrencyField.hidden = next !== 'time';
    if (ui.waitNote) ui.waitNote.hidden = next !== 'time';
    if (ui.skipDoneField) ui.skipDoneField.hidden = next !== 'accuracy';

    renderPresets();
    updateTarget();

    if (!silent && changed && state.loggedIn) {
      addLog('已切换为' + (next === 'time' ? '刷学习时长' : '刷完成度正确率') + '模式，当前会话继续复用，无需重新登录。', 'dim');
    }
    if (changed) saveSession();
  }

  function refreshControls() {
    var busy = state.running || state.loading > 0 || state.queuing;
    var logged = state.loggedIn;

    [ui.username, ui.password, ui.cookieInput, ui.loginBtn, ui.cookieBtn,
      ui.formatCookieBtn, ui.splitCookieBtn, ui.refreshBtn, ui.courseSelect].forEach(function (el) {
      if (el) el.disabled = busy;
    });

    [ui.paramInput, ui.concurrency, ui.skipDone].forEach(function (el) {
      if (el) el.disabled = state.running;
    });

    $$('.tab').forEach(function (btn) { btn.disabled = busy; });
    $$('.seg[data-mode]').forEach(function (btn) { btn.disabled = busy; });

    if (ui.allUnits) ui.allUnits.disabled = busy;
    syncTreeLocks();

    if (ui.startBtn) {
      ui.startBtn.disabled = busy || !logged || !state.course;
      ui.startBtn.hidden = state.running;
    }
    if (ui.oneClickBtn) {
      ui.oneClickBtn.disabled = busy || !logged || !state.course;
      ui.oneClickBtn.hidden = state.running;
    }
    if (ui.stopBtn) {
      ui.stopBtn.hidden = !state.running;
      ui.stopBtn.disabled = !state.running;
    }
    if (ui.runTip) ui.runTip.hidden = !state.running;
    if (ui.mobileStopBtn) {
      ui.mobileStopBtn.hidden = !state.running;
      ui.mobileStopBtn.disabled = !state.running;
    }

    if (ui.sessionBadge) ui.sessionBadge.hidden = !logged;
    if (ui.logoutBtn) ui.logoutBtn.hidden = !logged;
    if (ui.viewCookieBtn) ui.viewCookieBtn.hidden = !logged;
  }

  async function withLoading(fn, label) {
    state.loading++;
    if (label) setStatus(label, 'busy');
    refreshControls();
    try {
      return await fn();
    } finally {
      state.loading = Math.max(0, state.loading - 1);
      refreshControls();
      // 业务函数没有改写状态时，恢复一个合理的默认状态，避免状态栏停在“正在…”
      if (label && ui.statusText && ui.statusText.textContent === label) {
        setStatus(state.running ? '任务运行中…' : (state.loggedIn ? '就绪' : '待命'), state.running ? 'run' : 'idle');
      }
    }
  }

  /* ==========================================================
   * 10. 业务流程
   * ========================================================== */
  var saveTimer = null;

  function saveSession() {
    if (!state.loggedIn || state.restoring) return;
    try {
      localStorage.setItem(KEY_SESSION, JSON.stringify({
        cookie: net.header(),
        user: state.user,
        cid: state.course ? state.course.cid : null,
        mode: state.mode,
        param: ui.paramInput ? ui.paramInput.value : '',
        selection: readSelection(),
        at: Date.now()
      }));
    } catch (e) { /* 隐私模式或空间不足时忽略 */ }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveSession();
    }, 500);
  }

  function clearSessionStorage() {
    try { localStorage.removeItem(KEY_SESSION); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem(KEY_SESSION); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem('wl_session'); } catch (e) { /* ignore */ }
  }

  function readSavedSession() {
    var raw = null;
    try { raw = localStorage.getItem(KEY_SESSION); } catch (e) { raw = null; }

    // 兼容旧版 sessionStorage 会话，首次访问时迁移到 localStorage
    if (!raw) {
      try { raw = sessionStorage.getItem('wl_session') || sessionStorage.getItem(KEY_SESSION); } catch (e) { raw = null; }
      if (raw) {
        try { localStorage.setItem(KEY_SESSION, raw); } catch (e) { /* ignore */ }
      }
    }
    if (!raw) return null;

    var data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    return data && typeof data === 'object' ? data : null;
  }

  async function restoreSession() {
    var saved = readSavedSession();
    if (!saved || !saved.cookie) return;

    // 会话保留 7 天；超时或 Cookie 已失效时自动清除
    if (!saved.at || Date.now() - saved.at > SESSION_TTL) {
      clearSessionStorage();
      addLog('上次的登录状态已超过 7 天，已自动清除，请重新登录。', 'warn');
      return;
    }

    var cookies = parseCookieString(saved.cookie);
    if (!Object.keys(cookies).length) {
      clearSessionStorage();
      return;
    }

    state.restoring = true;
    net.cookie = cookies;
    state.user = saved.user || '';
    state.loggedIn = true;
    ui.cookieInput.value = saved.cookie;
    if (state.user) ui.username.value = state.user;
    if (saved.param && ui.paramInput) ui.paramInput.value = saved.param;
    setMode(saved.mode === 'time' ? 'time' : 'accuracy', true);

    addLog('检测到上次保存的登录状态，正在恢复…', 'dim');
    showTopNotice('正在恢复登录状态…', 'info', true);
    try {
      await withLoading(async function () {
        await loadCourses();
        renderCourses();

        var course = null;
        for (var i = 0; i < state.courses.length; i++) {
          if (String(state.courses[i].cid) === String(saved.cid)) { course = state.courses[i]; break; }
        }
        if (!course) course = state.courses[0];

        if (course) {
          await selectCourse(course, true);
          if (saved.selection) await applySelection(saved.selection);
        }
      }, '正在恢复会话…');

      state.restoring = false;
      saveSession();
      setStatus('就绪');
      addLog('已恢复登录状态与上次的单元选择（Cookie 最多保留 ' +
        Math.round(SESSION_TTL / 86400000) + ' 天，失效后会自动清除）。', 'ok');
      showTopNotice('登录状态已恢复 · 课程已加载', 'success');
    } catch (e) {
      state.restoring = false;
      state.loggedIn = false;
      state.user = '';
      state.courses = [];
      state.course = null;
      state.units = [];
      state.sections = {};
      net.clear();
      clearSessionStorage();
      if (ui.cookieInput) ui.cookieInput.value = '';
      renderCourses();
      renderUnits();
      setStatus('待命');
      addLog('本地会话已失效：' + e.message, 'warn');
      showTopNotice('登录状态已失效 · 请重新登录', 'error');
    } finally {
      state.restoring = false;
      refreshControls();
    }
  }

  async function afterLogin() {
    state.loggedIn = true;
    if (ui.sessionBadge) ui.sessionBadge.hidden = false;
    if (ui.logoutBtn) ui.logoutBtn.hidden = false;
    refreshControls();

    await loadCourses();
    renderCourses();

    var course = state.courses[0];
    if (course) await selectCourse(course);

    saveSession();
    setStatus('就绪');
    addLog('Cookie 已保存，可点击登录卡片右上角的「Cookie」查看。', 'dim');
  }

  async function doAccountLogin() {
    if (state.running || state.loading) return;
    var user = ui.username.value.trim();
    var password = ui.password.value;
    if (!user || !password) {
      showFormError('请输入账号和密码');
      toast('请输入账号和密码', 'err');
      showTopNotice('登录失败 · 请输入账号和密码', 'error');
      return;
    }

    clearFormError();
    net.clear();
    state.user = user;
    showTopNotice('正在登录…', 'info', true);

    await withLoading(async function () {
      try {
        await loginFlow(user, password);
        ui.cookieInput.value = net.header();
        addLog('登录成功，会话已建立。', 'ok');
        await afterLogin();
        clearFormError();
        Server.onLogin(user);
        toast('登录成功', 'ok');
        showTopNotice('登录成功 · 已获取 ' + state.courses.length + ' 门课程', 'success');
        scrollToCourses();
      } catch (e) {
        state.loggedIn = false;
        state.user = '';
        state.courses = [];
        state.course = null;
        state.units = [];
        state.sections = {};
        clearSessionStorage();
        renderCourses();
        renderUnits();
        setStatus('登录失败', 'error');
        addLog('登录失败：' + e.message, 'err');
        showFormError('登录失败：' + e.message);
        toast('登录失败：' + e.message, 'err');
        showTopNotice('登录失败 · ' + e.message, 'error');
      }
    }, '正在登录…');
  }

  async function doCookieLogin() {
    if (state.running || state.loading) return;
    var raw = ui.cookieInput.value.trim();
    if (!raw) { showFormError('请先粘贴 Cookie'); toast('请先粘贴 Cookie', 'err'); showTopNotice('登录失败 · 请先粘贴 Cookie', 'error'); return; }

    // 允许直接粘贴 JSON
    if (raw.charAt(0) === '{') {
      try {
        var obj = JSON.parse(raw.slice(raw.indexOf('{')));
        raw = Object.keys(obj).map(function (k) { return k + '=' + obj[k]; }).join('; ');
      } catch (e) { /* 保持原样 */ }
    }

    var cookies = parseCookieString(raw);
    if (!Object.keys(cookies).length) {
      showFormError('Cookie 格式无法识别');
      toast('Cookie 格式无法识别', 'err');
      showTopNotice('登录失败 · Cookie 格式无法识别', 'error');
      return;
    }

    clearFormError();
    net.cookie = cookies;
    state.user = '';   // Cookie 登录不绑定账号，避免沿用上一次登录的用户名
    ui.cookieInput.value = raw;
    showTopNotice('正在校验 Cookie…', 'info', true);

    await withLoading(async function () {
      try {
        await loadCourses();
        state.loggedIn = true;
        addLog('Cookie 校验通过，已获取课程列表。', 'ok');
        renderCourses();
        if (state.courses[0]) await selectCourse(state.courses[0]);
        saveSession();
        setStatus('就绪');
        clearFormError();
        Server.onLogin('');
        toast('Cookie 注入成功', 'ok');
        showTopNotice('登录成功 · Cookie 有效', 'success');
        scrollToCourses();
      } catch (e) {
        state.loggedIn = false;
        state.user = '';
        state.courses = [];
        state.course = null;
        state.units = [];
        state.sections = {};
        net.clear();
        clearSessionStorage();
        renderCourses();
        renderUnits();
        setStatus('Cookie 无效', 'error');
        addLog('Cookie 校验失败：' + e.message, 'err');
        showFormError('Cookie 校验失败：' + e.message);
        toast('Cookie 校验失败：' + e.message, 'err');
        showTopNotice('登录失败 · Cookie 无效：' + e.message, 'error');
      }
    }, '正在校验 Cookie…');
  }

  async function selectCourse(course, quiet) {
    if (!course) return;
    state.course = course;
    state.meta = null;
    state.units = [];
    state.sections = {};
    state.sectionsLoading = {};
    if (ui.courseSelect) ui.courseSelect.value = String(course.cid);
    renderUnits();
    updateTarget();
    refreshControls();

    try {
      await withLoading(async function () {
        await loadUnits(course);
        renderUnits();
      }, '正在加载《' + course.name + '》的单元…');
      if (!quiet) addLog('已加载《' + course.name + '》，共 ' + state.units.length + ' 个单元。', 'ok');
      saveSession();
    } catch (e) {
      addLog('加载单元失败：' + e.message, 'err');
      toast('加载单元失败：' + e.message, 'err');
      renderUnits();
    }
  }

  async function refreshAll(manual) {
    if (!state.loggedIn || state.running || state.loading) return;

    var previous = readSelection();
    var previousCid = state.course ? state.course.cid : null;

    await withLoading(async function () {
      try {
        await loadCourses();
        renderCourses();

        var course = null;
        for (var i = 0; i < state.courses.length; i++) {
          if (String(state.courses[i].cid) === String(previousCid)) { course = state.courses[i]; break; }
        }
        if (!course) course = state.courses[0];

        state.course = course;
        state.meta = null;
        state.units = [];
        state.sections = {};
        state.sectionsLoading = {};
        if (course) ui.courseSelect.value = String(course.cid);

        if (course) {
          await loadUnits(course);
          renderUnits();
          await applySelection(previous);
        } else {
          renderUnits();
        }

        if (manual) {
          addLog('课程与单元状态已刷新。', 'dim');
          toast('已刷新', 'ok');
        }
      } catch (e) {
        addLog('刷新失败：' + e.message, 'err');
        if (manual) toast('刷新失败：' + e.message, 'err');
      }
    }, '正在刷新课程…');
  }

  function logout() {
    if (state.running) { toast('任务运行中，请先停止', 'err'); return; }
    if (state.queuing) {
      state.queueCancelled = true;
      Server.releaseSlot();
    }
    net.clear();
    state.loggedIn = false;
    state.user = '';
    state.courses = [];
    state.course = null;
    state.meta = null;
    state.units = [];
    state.sections = {};
    state.sectionsLoading = {};
    clearSessionStorage();
    clearFormError();
    stopRuntimeTicker();

    ui.cookieInput.value = '';
    ui.password.value = '';
    renderCourses();
    renderUnits();
    updateTarget();
    setProgress(0, 0);
    setText(ui.etaText, '');
    setStatus('待命');
    refreshControls();
    addLog('已退出登录。', 'dim');
    showTopNotice('已退出登录', 'info');
  }

  function describeTargets(targets, param) {
    var head = targets.all
      ? '全部单元'
      : targets.unitNos.length + ' 个单元（' + targets.unitNos.join(',') + '）';
    var secCount = 0;
    if (targets.sections) {
      Object.keys(targets.sections).forEach(function (no) { secCount += targets.sections[no].length; });
    }
    return head + (secCount ? ' / ' + secCount + ' 个小节' : '') + ' · 参数 ' + param.label;
  }

  function buildTargets(selection) {
    return {
      all: selection.all,
      unitNos: selection.all ? state.units.map(function (_, i) { return i + 1; }) : selection.units,
      sections: selection.all ? null : selection.sections
    };
  }

  async function ensureCourseReady() {
    if (state.meta && String(state.meta.cid) === String(state.course.cid)) return true;
    var ready = true;
    await withLoading(async function () {
      try { await loadUnits(state.course); renderUnits(); } catch (e) { ready = false; toast('课程信息失效：' + e.message, 'err'); }
    }, '正在准备课程信息…');
    return ready;
  }

  var countdownFlip = null;

  /* 翻页时钟：逐位 3D 翻转，不是纵向滚动 */
  function renderCountdownTime(text) {
    if (!ui.countdownTime) return;
    text = String(text);

    if (!/[0-9]/.test(text)) {
      countdownFlip = null;
      ui.countdownTime.innerHTML = '';
      ui.countdownTime.textContent = text;
      ui.countdownTime.classList.add('is-calculating');
      ui.countdownTime.classList.remove('is-stopped');
      return;
    }

    ui.countdownTime.classList.remove('is-calculating', 'is-stopped');

    if (countdownFlip && countdownFlip.length === text.length) {
      for (var i = 0; i < countdownFlip.items.length; i++) {
        var item = countdownFlip.items[i];
        var ch = text.charAt(item.pos);
        if (item.value === ch) continue;
        if (item.timer) { clearTimeout(item.timer); item.timer = null; }
        item.value = ch;
        item.back.textContent = ch;
        item.card.classList.remove('is-flipping');
        void item.card.offsetWidth;
        item.card.classList.add('is-flipping');
        item.timer = setTimeout(function (node, next) {
          node.card.classList.remove('is-flipping');
          node.inner.style.transition = 'none';
          node.inner.style.transform = 'rotateX(0deg)';
          node.front.textContent = next;
          node.back.textContent = next;
          void node.inner.offsetWidth;
          node.inner.style.transition = '';
          node.timer = null;
        }, 420, item, ch);
      }
      ui.countdownTime.setAttribute('aria-label', text);
      return;
    }

    var wrap = document.createElement('span');
    wrap.className = 'flip-clock';
    var items = [];
    for (var k = 0; k < text.length; k++) {
      var c = text.charAt(k);
      if (c >= '0' && c <= '9') {
        var card = document.createElement('span');
        card.className = 'flip';
        var inner = document.createElement('span');
        inner.className = 'flip__inner';
        var front = document.createElement('span');
        front.className = 'flip__face flip__front';
        front.textContent = c;
        var back = document.createElement('span');
        back.className = 'flip__face flip__back';
        back.textContent = c;
        inner.appendChild(front);
        inner.appendChild(back);
        card.appendChild(inner);
        wrap.appendChild(card);
        items.push({ card: card, inner: inner, front: front, back: back, value: c, pos: k, timer: null });
      } else {
        var sep = document.createElement('span');
        sep.className = 'flip-sep';
        sep.textContent = c;
        wrap.appendChild(sep);
      }
    }
    ui.countdownTime.innerHTML = '';
    ui.countdownTime.appendChild(wrap);
    ui.countdownTime.setAttribute('aria-label', text);
    countdownFlip = { items: items, length: text.length };
  }

  function renderStoppedCountdown(timeFlow) {
    countdownFlip = null;
    if (!ui.countdownTime) return;
    ui.countdownTime.innerHTML = '';
    ui.countdownTime.textContent = '已停止';
    ui.countdownTime.classList.remove('is-calculating');
    ui.countdownTime.classList.add('is-stopped');
    setText(ui.countdownLabel, '任务已停止');
    setText(ui.countdownMeta, timeFlow ? '已停止，正在提交已等待时长…' : '已停止，正在安全收尾…');
    setText(ui.countdownPillTime, '已停止');
  }

  function updateCountdown(info) {
    if (!ui.countdownCard) return;
    if (ui.countdownPhase) {
      setText(ui.countdownPhase, state.stopping
        ? (state.timePhaseVisible ? '正在停止，提交已等待时长…' : '正在停止…')
        : (state.phaseLabel || '任务运行中'));
    }

    // 点击停止后固定显示“已停止”，不再让 ticker 覆盖
    if (state.stopping) return;

    // 章节信息还没收集完：明确显示“正在计算”，而不是 00:00
    if (!info || !info.total) {
      renderCountdownTime('计算中…');
      setText(ui.countdownPillTime, '--:--');
      setText(ui.countdownLabel, '正在计算预计时长');
      setText(ui.countdownMeta, '正在读取章节信息，请稍候…');
      if (ui.countdownFill) ui.countdownFill.style.width = '0%';
      return;
    }

    if (ui.countdownTime) ui.countdownTime.classList.remove('is-calculating');
    setText(ui.countdownLabel, '预计剩余时间');

    var totalLeft = info && typeof info.estimate === 'number' ? info.estimate : (info ? info.remaining : 0);
    var roundLeft = info && typeof info.remaining === 'number' ? info.remaining : 0;
    var done = info ? info.done : 0;
    var total = info ? info.total : 0;

    renderCountdownTime(fmtDuration(totalLeft));
    setText(ui.countdownPillTime, fmtDuration(totalLeft));
    if (ui.countdownPhase) setText(ui.countdownPhase, state.phaseLabel || '任务运行中');

    var pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    if (ui.countdownFill) ui.countdownFill.style.width = pct + '%';

    var meta = '进度 ' + done + '/' + total;
    if (roundLeft > 0) meta += ' · 本轮并发剩余 ' + fmtDuration(roundLeft);
    meta += ' · 总计剩余 ' + fmtDuration(totalLeft);
    setText(ui.countdownMeta, meta);
  }

  function showCountdown() {
    state.stopping = false;
    if (ui.countdownTime) ui.countdownTime.classList.remove('is-stopped');
    setText(ui.countdownLabel, '预计剩余时间');
    if (ui.countdownStopBtn) {
      ui.countdownStopBtn.disabled = false;
      ui.countdownStopBtn.textContent = '停止任务';
    }
    if (ui.countdownCard) ui.countdownCard.hidden = false;
    if (ui.countdownPill) ui.countdownPill.hidden = true;
    if (ui.countdownWait) ui.countdownWait.hidden = !state.timePhaseVisible;
    updateCountdown(state.runner && state.runner.getRuntimeInfo ? state.runner.getRuntimeInfo() : null);
  }

  function minimizeCountdown() {
    if (ui.countdownCard) ui.countdownCard.hidden = true;
    if (ui.countdownPill) ui.countdownPill.hidden = false;
  }

  function expandCountdown() {
    if (ui.countdownPill) ui.countdownPill.hidden = true;
    if (ui.countdownCard) ui.countdownCard.hidden = false;
  }

  function hideCountdown() {
    if (ui.countdownCard) ui.countdownCard.hidden = true;
    if (ui.countdownPill) ui.countdownPill.hidden = true;
  }

  /* ---------- 多用户排队提示 ---------- */
  function showQueue(info) {
    if (!ui.queueCard) return;
    ui.queueCard.hidden = false;
    setText(ui.queuePosition, info && info.position ? '第 ' + info.position + ' 位' : '排队中');
    if (info) {
      setText(ui.queueText,
        '当前有 ' + info.active + ' 个用户正在使用，服务器最多同时运行 ' + info.limit + ' 个任务。' +
        (info.position ? '你排在第 ' + info.position + ' 位。' : '') +
        '请保持页面开启，轮到你时会自动开始。');
    }
    setStatus('排队中' + (info && info.position ? ' · 第 ' + info.position + ' 位' : ''), 'busy');
    refreshControls();
  }

  function hideQueue() {
    if (ui.queueCard) ui.queueCard.hidden = true;
  }

  function cancelQueue() {
    state.queueCancelled = true;
    Server.releaseSlot();
    hideQueue();
    setStatus('已取消排队');
    refreshControls();
    addLog('已取消排队。', 'dim');
  }

  function startRuntimeTicker() {
    stopRuntimeTicker();
    state.startedAt = Date.now();
    state.ticker = setInterval(function () {
      if (!state.running) return;
      var elapsed = (Date.now() - state.startedAt) / 1000;
      var info = state.runner && state.runner.getRuntimeInfo ? state.runner.getRuntimeInfo() : null;
      var text = '已运行 ' + fmtDuration(elapsed);
      if (info && info.remaining > 0) text += ' · 本轮 ' + fmtDuration(info.remaining);
      if (info && info.estimate > 0) text += ' · 总计 ' + fmtDuration(info.estimate);
      setText(ui.etaText, text);

      if (ui.mobileLogStatus) {
        ui.mobileLogStatus.textContent = '运行中 · ' + fmtDuration(elapsed) +
          (info && info.estimate > 0 ? ' · 总余 ' + fmtDuration(info.estimate) : '');
      }

      if ((ui.countdownCard && !ui.countdownCard.hidden) || (ui.countdownPill && !ui.countdownPill.hidden)) {
        updateCountdown(info);
      }
    }, 1000);
  }

  function stopRuntimeTicker() {
    if (state.ticker) {
      clearInterval(state.ticker);
      state.ticker = null;
    }
    setText(ui.etaText, '');
  }

  /* 手机/笔记本合盖前的屏幕常亮申请；不支持时静默降级为文字提示 */
  var screenWakeLock = null;

  async function requestWakeLock() {
    try {
      if (!navigator.wakeLock || screenWakeLock) return;
      screenWakeLock = await navigator.wakeLock.request('screen');
      screenWakeLock.addEventListener('release', function () { screenWakeLock = null; });
      addLog('已请求屏幕常亮；运行期间请不要关闭页面或切到后台。', 'dim');
    } catch (e) { /* 浏览器不支持或被拒绝，忽略 */ }
  }

  function releaseWakeLock() {
    try { if (screenWakeLock) screenWakeLock.release(); } catch (e) { /* ignore */ }
    screenWakeLock = null;
  }

  async function startTask(oneClick) {
    if (state.running || state.loading || state.queuing) return;
    hideTopNotice();
    if (!state.loggedIn) { toast('请先登录', 'err'); return; }
    if (!state.course) { toast('请先选择课程', 'err'); return; }

    clearFormError();

    var phases;
    var selection = readSelection();

    if (oneClick) {
      if (!selection.all && !selection.units.length) {
        selection = { all: true, units: [], sections: {} };
        addLog('未选择单元，一键完成将处理当前课程的全部单元。', 'warn');
      }
      phases = [
        {
          mode: 'accuracy',
          label: '正确率 ' + ONE_CLICK.accuracy.min + '–' + ONE_CLICK.accuracy.max + '%',
          param: {
            type: 'range',
            min: ONE_CLICK.accuracy.min,
            max: ONE_CLICK.accuracy.max,
            label: ONE_CLICK.accuracy.min + '–' + ONE_CLICK.accuracy.max
          },
          skipDone: false,
          optional: true
        },
        {
          mode: 'time',
          label: '时长 ' + ONE_CLICK.time.min + '–' + ONE_CLICK.time.max + ' 秒',
          param: {
            type: 'range',
            min: ONE_CLICK.time.min,
            max: ONE_CLICK.time.max,
            label: ONE_CLICK.time.min + '–' + ONE_CLICK.time.max
          },
          skipDone: false,
          optional: false
        }
      ];
    } else {
      var param;
      try {
        param = parseParam(ui.paramInput.value, state.mode);
      } catch (e) {
        toast(e.message, 'err');
        ui.paramInput.focus();
        return;
      }
      if (!selection.all && !selection.units.length) {
        toast('请至少勾选一个单元，或勾选“全部单元”', 'err');
        return;
      }
      phases = [{
        mode: state.mode,
        label: state.mode === 'time' ? '刷学习时长' : '刷完成度正确率',
        param: param,
        skipDone: !!(ui.skipDone && ui.skipDone.checked),
        optional: false
      }];
    }

    if (!(await ensureCourseReady())) return;
    saveSession();

    // 服务器最多同时运行 3 个任务，满员时在这里排队
    if (Server.enabled) {
      var granted = await Server.acquireSlot(oneClick ? 'oneclick' : state.mode);
      if (!granted) {
        refreshControls();
        return;
      }
      Server.startHeartbeat(oneClick ? 'oneclick' : state.mode);
    }

    state.timePhaseVisible = oneClick || state.mode === 'time';
    var targets = buildTargets(selection);
    var concurrency = Number(ui.concurrency ? ui.concurrency.value : 10);
    if (!isFinite(concurrency)) concurrency = 10;
    state.phaseLabel = oneClick ? '一键完成' : phases[0].label;

    var job = new Job(phases, {
      targets: targets,
      course: state.course,
      meta: state.meta,
      units: state.units,
      concurrency: concurrency,
      onLog: addLog,
      onProgress: setProgress,
      onStatus: function (text) { setStatus(text, 'run'); },
      onPhase: function (label, index, total) {
        state.phaseLabel = (total > 1 ? '一键完成 ' + index + '/' + total + ' · ' : '') + label;
        if (ui.countdownPhase) setText(ui.countdownPhase, state.phaseLabel);
      }
    });

    state.runner = job;
    state.running = true;
    state.startedAt = Date.now();
    refreshControls();
    setStatus(oneClick ? '一键完成运行中…' : '任务运行中…', 'run');
    setProgress(0, 0);
    startRuntimeTicker();
    showCountdown();
    requestWakeLock();

    addLog('────────────────────────', 'dim');
    if (oneClick) {
      addLog('⚡ 一键完成：正确率 96–100%，时长 480–580 秒；耗时较长，可随时停止，期间请勿关闭浏览器。', 'info');
      setText(ui.targetText, '一键完成 · ' + (targets.all ? '全部单元' : targets.unitNos.length + ' 个单元'));
    } else {
      addLog('开始任务：' + describeTargets(targets, phases[0].param), 'info');
    }

    var result = null;
    try {
      result = await job.run();
    } catch (e) {
      addLog('任务异常终止：' + e.message, 'err');
      toast('任务异常终止：' + e.message, 'err');
    } finally {
      state.runner = null;
      state.running = false;
      state.stopping = false;
      stopRuntimeTicker();
      hideCountdown();
      releaseWakeLock();
      if (Server.enabled) Server.releaseSlot();
      refreshControls();
      setStatus(job.stopped ? '已停止' : '待命');
      saveSession();
    }

    if (!result) return;
    if (oneClick) {
      finishOneClick(result, targets);
    } else if (result.phases.length) {
      finishTask(result.phases[0].result, phases[0].param, targets);
    }
  }

  function appendDoneRow(label, value) {
    if (!ui.doneBody) return;
    var row = document.createElement('div');
    row.className = 'done-row';
    var key = document.createElement('span');
    key.textContent = label;
    var val = document.createElement('b');
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    ui.doneBody.appendChild(row);
  }

  function showDoneModal(info) {
    if (!ui.doneModal) return;
    info = info || {};
    var stopped = !!info.stopped;
    var failed = !!info.failed;
    if (ui.donePanel) {
      ui.donePanel.classList.toggle('is-stopped', stopped);
      ui.donePanel.classList.toggle('is-warn', !stopped && failed);
    }
    setText(ui.doneIcon, stopped || failed ? '!' : '✓');
    setText(ui.doneTitle, stopped ? '任务已停止' : (failed ? '任务结束（部分失败）' : '任务完成'));
    setText(ui.doneSub, '本次用时 ' + fmtDuration(info.elapsed) +
      ' · ' + (stopped ? '已手动停止' : '课程状态已自动刷新'));

    if (ui.doneBody) {
      ui.doneBody.innerHTML = '';
      (info.rows || []).forEach(function (row) { appendDoneRow(row[0], row[1]); });
    }
    openModal('doneModal');
  }

  function finishTask(result, param, targets, opts) {
    opts = opts || {};
    if (result.mode === 'accuracy') {
      addLog('结算：方式1 ' + result.way1.ok + ' 成功 / ' + result.way1.fail + ' 失败，方式2 ' +
        result.way2.ok + ' 成功 / ' + result.way2.fail + ' 失败',
        result.way2.fail ? 'warn' : 'ok');
      if (!opts.silentToast) {
        toast('正确率任务完成：' + result.way2.ok + ' 个成功' + (result.way2.fail ? '，' + result.way2.fail + ' 个失败' : ''), result.way2.fail ? 'info' : 'ok');
      }
    } else {
      addLog('结算：成功 ' + result.ok + ' 个，失败 ' + result.failed + ' 个',
        result.failed ? 'warn' : 'ok');
      result.errors.slice(0, 8).forEach(function (name, i) {
        addLog('  失败 ' + (i + 1) + '：' + name, 'dim');
      });
      if (!opts.silentToast) {
        toast('时长任务完成：' + result.ok + ' 个成功' + (result.failed ? '，' + result.failed + ' 个失败' : ''), result.failed ? 'info' : 'ok');
      }
    }

    if (result.stopped) addLog('任务已手动终止。', 'warn');
    setProgress(result.done, result.total);

    Server.recordTask(result, param, targets);

    if (!opts.skipDoneModal) {
      var rows = [['目标', describeTargets(targets, param)]];
      if (result.mode === 'accuracy') {
        rows.push(['方式1', result.way1.ok + ' 成功 / ' + result.way1.fail + ' 失败']);
        rows.push(['方式2', result.way2.ok + ' 成功 / ' + result.way2.fail + ' 失败']);
      } else {
        rows.push(['参数', param.label + ' 秒/章节']);
        rows.push(['结果', result.ok + ' 成功 / ' + result.failed + ' 失败']);
        rows.push(['有效时长（已提交）', fmtDuration(result.creditedSeconds || 0)]);
      }
      showDoneModal({
        rows: rows,
        elapsed: opts.elapsed || Math.floor((Date.now() - state.startedAt) / 1000),
        stopped: !!result.stopped,
        failed: result.mode === 'accuracy' ? result.way2.fail > 0 : result.failed > 0
      });
    }

    if (!opts.skipRefresh) {
      setTimeout(function () {
        if (!state.running && state.loggedIn) refreshAll(false);
      }, 700);
    }
  }

  function finishOneClick(result, targets) {
    if (!result.phases.length) {
      addLog('一键完成：没有可处理的章节，请检查单元 / 小节选择。', 'warn');
      toast('没有可处理的章节', 'err');
      return;
    }

    var acc = null;
    var time = null;
    result.phases.forEach(function (phase) {
      if (phase.mode === 'accuracy') acc = phase;
      else time = phase;
    });

    result.phases.forEach(function (phase) {
      finishTask(phase.result, phase.param, targets, { skipRefresh: true, silentToast: true, skipDoneModal: true });
    });

    var parts = [];
    if (acc) parts.push('正确率 ' + acc.result.way2.ok + ' 个成功');
    if (time) parts.push('时长 ' + time.result.ok + ' 个成功');
    if (result.stopped) parts.push('已手动停止');

    var summary = parts.join('，') || '没有章节';
    addLog('⚡ 一键完成结束：' + summary, result.stopped ? 'warn' : 'ok');
    toast('一键完成结束：' + summary, result.stopped ? 'info' : 'ok');

    var rows = [['目标', targets.all ? '全部单元' : targets.unitNos.length + ' 个单元']];
    var failed = false;
    var credited = 0;
    result.phases.forEach(function (phase) {
      if (phase.mode === 'accuracy') {
        failed = failed || phase.result.way2.fail > 0;
        rows.push(['正确率 ' + phase.param.label + '%',
          phase.result.way2.ok + ' 成功 / ' + phase.result.way2.fail + ' 失败']);
      } else {
        failed = failed || phase.result.failed > 0;
        credited += phase.result.creditedSeconds || 0;
        rows.push(['时长 ' + phase.param.label + ' 秒',
          phase.result.ok + ' 成功 / ' + phase.result.failed + ' 失败']);
      }
    });
    rows.push(['有效时长（已提交）', fmtDuration(credited)]);
    showDoneModal({
      rows: rows,
      elapsed: Math.floor((Date.now() - state.startedAt) / 1000),
      stopped: !!result.stopped,
      failed: failed
    });

    setTimeout(function () {
      if (!state.running && state.loggedIn) refreshAll(false);
    }, 700);
  }

  function stopTask() {
    if (!state.runner || state.stopping) return;
    state.stopping = true;
    ui.stopBtn.disabled = true;
    if (ui.mobileStopBtn) ui.mobileStopBtn.disabled = true;
    if (ui.countdownStopBtn) {
      ui.countdownStopBtn.disabled = true;
      ui.countdownStopBtn.textContent = '正在停止…';
    }
    if (ui.countdownPhase) setText(ui.countdownPhase,
      state.timePhaseVisible ? '正在停止，提交已等待时长…' : '正在停止…');
    renderStoppedCountdown(state.timePhaseVisible);
    state.runner.stop();
    addLog(state.timePhaseVisible
      ? '正在停止：正在提交停止前已等待的时长，请稍候…'
      : '正在停止：正在安全收尾…', 'warn');
    toast(state.timePhaseVisible
      ? '正在停止，正在提交已等待的时长…'
      : '正在停止…', 'info');
    setStatus('正在停止…', 'run');
  }

  /* ==========================================================
   * 11. 弹窗 / Cookie 工具
   * ========================================================== */
  var lastFocus = null;

  function openModal(id) {
    var modal = $(id);
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    var focusable = modal.querySelector('button, [href], input, select, textarea');
    if (focusable) setTimeout(function () { focusable.focus(); }, 30);
  }

  function closeModal(id) {
    var modal = $(id);
    if (!modal) return;
    modal.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- 手机端日志：底部常驻条 + 全屏面板 ---------- */
  function openLogSheet() {
    if (!ui.logModal || !ui.logSheet) return;
    ui.logSheet.innerHTML = '';
    $$('.log__line', ui.logBox).slice(-600).forEach(function (line) {
      ui.logSheet.appendChild(line.cloneNode(true));
    });
    setText(ui.logModalStatus, ui.statusLine ? ui.statusLine.textContent : '');
    openModal('logModal');
    try { ui.logSheet.scrollTop = ui.logSheet.scrollHeight; } catch (e) { /* ignore */ }
  }

  function clearLogs() {
    if (ui.logBox) ui.logBox.innerHTML = '';
    if (ui.logSheet) ui.logSheet.innerHTML = '';
    if (ui.mobileLog) ui.mobileLog.classList.remove('is-error');
    setText(ui.mobileLogLast, '日志已清空');
    addLog('日志已清空。', 'dim');
  }

  /* ---------- 表单内联错误：登录失败时直接显示在按钮下方 ---------- */
  function showFormError(message) {
    if (!ui.loginError) return;
    ui.loginError.textContent = String(message || '操作失败');
    ui.loginError.hidden = false;
  }

  function clearFormError() {
    if (!ui.loginError) return;
    ui.loginError.textContent = '';
    ui.loginError.hidden = true;
  }

  /* 手机端登录成功后，把“选择课程”滚到眼前，减少手动滑动 */
  function scrollToCourses() {
    try {
      if (!window.matchMedia || !window.matchMedia('(max-width: 720px)').matches) return;
      var card = ui.courseSelect && ui.courseSelect.closest ? ui.courseSelect.closest('.card') : null;
      if (!card || !card.scrollIntoView) return;
      setTimeout(function () {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 260);
    } catch (e) { /* ignore */ }
  }

  function formatCookieInput() {
    var raw = ui.cookieInput.value.trim();
    if (!raw) { toast('Cookie 输入框为空', 'err'); return; }

    var start = raw.indexOf('{');
    if (start === -1) {
      var pairs = parseCookieString(raw);
      if (!Object.keys(pairs).length) { toast('没有识别出有效的 Cookie', 'err'); return; }
      ui.cookieInput.value = Object.keys(pairs).map(function (k) { return k + '=' + pairs[k]; }).join('; ');
      toast('已格式化为标准 Cookie', 'ok');
      return;
    }

    try {
      var obj = JSON.parse(raw.slice(start));
      ui.cookieInput.value = Object.keys(obj).map(function (k) { return k + '=' + obj[k]; }).join('; ');
      addLog('Cookie JSON 已转换为标准格式。', 'dim');
      toast('格式化成功', 'ok');
    } catch (e) {
      toast('JSON 解析失败，请检查内容', 'err');
    }
  }

  /* 登录后查看当前会话 Cookie（只显示、不上传） */
  function viewCookie() {
    var header = net.header();
    if (!header) {
      toast('当前没有可用的 Cookie，请先登录', 'err');
      return;
    }
    if (ui.cookieInput) ui.cookieInput.value = header;
    openCookieModal('当前会话 Cookie');
  }

  function openCookieModal(title) {
    var raw = ui.cookieInput.value.trim();
    if (!raw) { toast('Cookie 输入框为空', 'err'); return; }
    if (ui.cookieTitle) setText(ui.cookieTitle, title || 'Cookie 解析');

    if (raw.charAt(0) === '{') {
      try {
        var obj = JSON.parse(raw.slice(raw.indexOf('{')));
        raw = Object.keys(obj).map(function (k) { return k + '=' + obj[k]; }).join('; ');
      } catch (e) { /* ignore */ }
    }

    var pairs = raw.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    ui.cookieList.innerHTML = '';

    pairs.forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx <= 0) return;
      var key = pair.slice(0, idx).trim();
      var val = pair.slice(idx + 1).trim();

      var row = document.createElement('div');
      row.className = 'cookie-row';

      var keyEl = document.createElement('div');
      keyEl.className = 'cookie-row__key';
      keyEl.textContent = key;

      var bar = document.createElement('div');
      bar.className = 'cookie-row__bar';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = val;
      input.readOnly = true;

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = '复制';
      copy.addEventListener('click', function () {
        var done = function () {
          copy.textContent = '已复制';
          setTimeout(function () { copy.textContent = '复制'; }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(val).then(done).catch(function () { toast('复制失败', 'err'); });
        } else {
          input.select();
          try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败', 'err'); }
        }
      });

      bar.appendChild(input);
      bar.appendChild(copy);
      row.appendChild(keyEl);
      row.appendChild(bar);
      ui.cookieList.appendChild(row);
    });

    if (!ui.cookieList.childElementCount) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '没有解析出有效的键值对。';
      ui.cookieList.appendChild(empty);
    }

    openModal('cookieModal');
  }

  function exportLog() {
    var lines = $$('.log__line', ui.logBox).map(function (line) { return line.textContent; });
    if (!lines.length) { toast('当前没有日志', 'err'); return; }
    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'welearn_log_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    addLog('日志已导出。', 'dim');
  }

  /* ==========================================================
   * 12. 服务端能力占位（GitHub 开源版不包含统计 / 公告 / 排队）
   * ========================================================== */
  var Server = {
    enabled: false,
    clientId: '',
    slotHeld: false,
    async init() {},
    ensureClientId() { return 'github'; },
    paintLoad() {},
    async refreshSlots() {},
    async acquireSlot() { return true; },
    startHeartbeat() {},
    stopHeartbeat() {},
    releaseSlot() {},
    async onLogin() {},
    async recordTask() {}
  };

  /* ==========================================================
   * 13. 事件绑定
   * ========================================================== */
  function cacheDom() {
    [
      'statusPill', 'statusText', 'helpBtn', 'themeBtn',
      'topNoticeWrap', 'topNotice', 'topNoticeText',
      'stage', 'rail', 'taskCard', 'runBar',
      'sessionBadge', 'logoutBtn', 'username', 'password', 'togglePwd', 'loginBtn',
      'cookieInput', 'formatCookieBtn', 'splitCookieBtn', 'cookieBtn',
      'courseSelect', 'refreshBtn', 'courseSummary',
      'allUnits', 'unitTree', 'paramInput', 'paramLabel', 'presetRow',
      'concurrency', 'concurrencyField', 'skipDone', 'skipDoneField', 'waitNote',
      'targetText', 'progressFill', 'progressText', 'startBtn', 'stopBtn',
      'oneClickBtn', 'etaText', 'runTip', 'viewCookieBtn', 'cookieTitle',
      'autoScroll', 'exportLogBtn', 'clearLogBtn', 'logBox', 'statusLine', 'consoleEl',
      'loginError', 'mobileLog', 'mobileLogBtn', 'mobileLogStatus', 'mobileLogLast', 'mobileStopBtn',
      'countdownCard', 'countdownPhase', 'countdownTime', 'countdownFill', 'countdownMeta',
      'countdownStopBtn', 'countdownHideBtn', 'countdownMinBtn', 'countdownPill', 'countdownPillTime', 'countdownWait', 'countdownLabel',
      'doneModal', 'donePanel', 'doneIcon', 'doneTitle', 'doneSub', 'doneBody', 'doneLogBtn',
      'logModal', 'logSheet', 'logModalStatus', 'logSheetExport', 'logSheetClear',
      'helpModal',
      'cookieModal', 'cookieList', 'toasts'
    ].forEach(function (id) { ui[id] = $(id); });
  }

  function wire() {
    if (ui.mobileLogBtn) ui.mobileLogBtn.addEventListener('click', openLogSheet);
    if (ui.logSheetExport) ui.logSheetExport.addEventListener('click', exportLog);
    if (ui.logSheetClear) ui.logSheetClear.addEventListener('click', clearLogs);
    if (ui.countdownStopBtn) ui.countdownStopBtn.addEventListener('click', stopTask);
    if (ui.countdownMinBtn) ui.countdownMinBtn.addEventListener('click', minimizeCountdown);
    if (ui.countdownHideBtn) ui.countdownHideBtn.addEventListener('click', minimizeCountdown);
    if (ui.countdownPill) ui.countdownPill.addEventListener('click', expandCountdown);
    if (ui.queueCancelBtn) ui.queueCancelBtn.addEventListener('click', cancelQueue);
    if (ui.doneLogBtn) {
      ui.doneLogBtn.addEventListener('click', function () {
        closeModal('doneModal');
        openLogSheet();
      });
    }

    if (ui.themeBtn) {
      ui.themeBtn.addEventListener('click', function () {
        applyTheme(readTheme() === 'dark' ? 'light' : 'dark');
      });
    }

    if (ui.helpBtn) ui.helpBtn.addEventListener('click', function () { openModal('helpModal'); });

    $$('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(btn.getAttribute('data-close')); });
    });

    $$('.modal').forEach(function (modal) {
      modal.addEventListener('mousedown', function (e) {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = $$('.modal').filter(function (m) { return !m.hidden; });
      var last = open[open.length - 1];
      if (last) closeModal(last.id);
    });

    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        if (tab.disabled) return;
        clearFormError();
        var name = tab.getAttribute('data-tab');
        $$('.tab').forEach(function (t) {
          var active = t === tab;
          t.classList.toggle('is-active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if ($('accountPane')) $('accountPane').hidden = name !== 'account';
        if ($('cookiePane')) $('cookiePane').hidden = name !== 'cookie';
      });
    });

    if (ui.togglePwd) {
      ui.togglePwd.addEventListener('click', function () {
        var isPassword = ui.password.type === 'password';
        ui.password.type = isPassword ? 'text' : 'password';
        ui.togglePwd.setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
        ui.password.focus();
      });
    }

    if (ui.loginBtn) ui.loginBtn.addEventListener('click', function () { doAccountLogin(); });
    if (ui.cookieBtn) ui.cookieBtn.addEventListener('click', function () { doCookieLogin(); });
    if (ui.formatCookieBtn) ui.formatCookieBtn.addEventListener('click', formatCookieInput);
    if (ui.splitCookieBtn) ui.splitCookieBtn.addEventListener('click', openCookieModal);
    if (ui.logoutBtn) ui.logoutBtn.addEventListener('click', logout);

    [ui.username, ui.password, ui.cookieInput].forEach(function (el) {
      if (el) el.addEventListener('input', clearFormError);
    });

    if (ui.password) {
      ui.password.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doAccountLogin();
      });
    }

    if (ui.refreshBtn) ui.refreshBtn.addEventListener('click', function () { refreshAll(true); });

    if (ui.courseSelect) {
      ui.courseSelect.addEventListener('change', function () {
        var cid = ui.courseSelect.value;
        var course = null;
        for (var i = 0; i < state.courses.length; i++) {
          if (String(state.courses[i].cid) === String(cid)) { course = state.courses[i]; break; }
        }
        if (course) selectCourse(course);
      });
    }

    if (ui.allUnits) {
      ui.allUnits.addEventListener('change', function () {
        syncAllUnits();
        scheduleSave();
      });
    }

    $$('.seg[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!btn.disabled) setMode(btn.getAttribute('data-mode'));
      });
    });

    if (ui.paramInput) {
      ui.paramInput.addEventListener('input', function () {
        updateTarget();
        scheduleSave();
      });
    }

    if (ui.startBtn) ui.startBtn.addEventListener('click', function () { startTask(false); });
    if (ui.oneClickBtn) ui.oneClickBtn.addEventListener('click', function () { startTask(true); });
    if (ui.stopBtn) ui.stopBtn.addEventListener('click', stopTask);
    if (ui.mobileStopBtn) ui.mobileStopBtn.addEventListener('click', stopTask);
    if (ui.viewCookieBtn) ui.viewCookieBtn.addEventListener('click', viewCookie);

    if (ui.clearLogBtn) ui.clearLogBtn.addEventListener('click', clearLogs);
    if (ui.exportLogBtn) ui.exportLogBtn.addEventListener('click', exportLog);

    if (ui.autoScroll) {
      ui.autoScroll.addEventListener('change', function () {
        if (ui.autoScroll.checked) ui.logBox.scrollTop = ui.logBox.scrollHeight;
      });
    }

    if (ui.unitTree) {
      // 展开收起后保持滚动位置由浏览器处理
      ui.unitTree.addEventListener('scroll', function () { /* 预留 */ });
    }

    window.addEventListener('unhandledrejection', function (e) {
      var reason = e && e.reason;
      addLog('未处理的异常：' + (reason && reason.message ? reason.message : String(reason)), 'err');
    });

    /* 运行中关闭页面时提示，避免用户误关导致任务中断 */
    window.addEventListener('beforeunload', function (e) {
      if (!state.running) return;
      e.preventDefault();
      e.returnValue = '任务正在运行，关闭页面会中断，确定离开吗？';
      return e.returnValue;
    });

    window.addEventListener('pagehide', function () {
      if (state.loggedIn) saveSession();
      if (Server.enabled && (state.running || state.queuing)) Server.releaseSlot(true);
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.running) requestWakeLock();
    });
  }

  /* ==========================================================
   * 14. 启动
   * ========================================================== */
  /* 桌面端：右栏高度对齐左栏，日志在控制台内部滚动，底部与单元目录齐平 */
  function syncStageHeight() {
    var stage = ui.stage;
    var rail = ui.rail;
    if (!stage || !rail) return;
    if (!window.matchMedia || !window.matchMedia('(min-width: 1081px)').matches) {
      stage.style.height = '';
      return;
    }
    var gap = 14;
    var minConsole = 360;
    var paramsH = ui.taskCard ? ui.taskCard.offsetHeight : 0;
    var runbarH = ui.runBar ? ui.runBar.offsetHeight : 0;
    var needed = paramsH + runbarH + gap * 2 + minConsole;
    stage.style.height = Math.max(rail.offsetHeight, needed) + 'px';
  }

  function setupStageSync() {
    syncStageHeight();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { syncStageHeight(); });
      [ui.rail, ui.taskCard, ui.runBar].forEach(function (el) {
        if (el) ro.observe(el);
      });
    }
    window.addEventListener('resize', syncStageHeight);
    $$('details.advanced').forEach(function (details) {
      details.addEventListener('toggle', syncStageHeight);
    });
  }

  async function boot() {
    cacheDom();
    applyTheme(readTheme());
    wire();

    setStatus('待命');
    setMode('accuracy', true);
    renderCourses();
    renderUnits();
    updateTarget();
    setProgress(0, 0);
    refreshControls();
    addLog('Welearn Helper Web 控制台 v' + VERSION + '（构建 ' + BUILD_ID + '）已就绪。', 'dim');

    // CDN / 浏览器缓存导致页面与脚本版本不一致时，给出明确提示
    var pageBuild = document.querySelector('meta[name="wl-build"]');
    if (pageBuild && pageBuild.getAttribute('content') !== BUILD_ID) {
      addLog('页面版本（' + pageBuild.getAttribute('content') + '）与脚本版本（' + BUILD_ID +
        '）不一致，若界面异常请强制刷新或清理 CDN 缓存。', 'warn');
    }

    addLog('提示：登录后选择课程与单元，设置参数即可开始。', 'dim');

    setupStageSync();
    Server.init();
    await restoreSession();
    syncStageHeight();
  }

  /* 测试钩子：仅暴露纯函数，不影响页面逻辑 */
  if (typeof globalThis !== 'undefined') {
    globalThis.__WL_DEBUG__ = {
      version: VERSION,
      build: BUILD,
      buildId: BUILD_ID,
      parseParam: parseParam,
      parseCmi: parseCmi,
      parseCookieString: parseCookieString,
      upgradeUpstreamUrl: upgradeUpstreamUrl,
      oneClickDefaults: ONE_CLICK,
      Semaphore: Semaphore,
      state: state
    };
  }

  boot();
})();
