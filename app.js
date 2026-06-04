const API = {
  proxy: 'api.php',
  prelogin: 'https://welearn.sflep.com/user/prelogin.aspx?loginret=http://welearn.sflep.com/user/loginredirect.aspx',
  authCourse: 'https://welearn.sflep.com/ajax/authCourse.aspx?action=gmc',
  courseInfo: (cid) => `https://welearn.sflep.com/student/course_info.aspx?cid=${cid}`,
  courseUnits: 'https://welearn.sflep.com/ajax/StudyStat.aspx',
  sco: 'https://welearn.sflep.com/Ajax/SCO.aspx',
};

const state = {
  mode: 'accuracy',
  loggedIn: false,
  cookieDict: {}, 
  courses: [],
  selectedCourse: null,
  courseMeta: null,
  units: [],
  sessionReady: false,
  readySteps: 0,
  currentUsername: '',
  isRunning: false
};

const els = {
  visitorGreeting: document.getElementById('visitorGreeting'),
  statVisits: document.getElementById('statVisits'),
  statLogins: document.getElementById('statLogins'),
  statRuns: document.getElementById('statRuns'),
  statTotalUsers: document.getElementById('statTotalUsers'),
  
  logoutBtn: document.getElementById('logoutBtn'),
  announceModal: document.getElementById('announceModal'),
  announceText: document.getElementById('announceText'),
  announceBtn: document.getElementById('announceBtn'),

  statWorkflow: document.getElementById('statWorkflow'),
  statReady: document.getElementById('statReady'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('loginBtn'),
  cookieInput: document.getElementById('cookieInput'),
  cookieBtn: document.getElementById('cookieBtn'),
  formatCookieBtn: document.getElementById('formatCookieBtn'),
  splitCookieBtn: document.getElementById('splitCookieBtn'),
  
  cookieModal: document.getElementById('cookieModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  cookieList: document.getElementById('cookieList'),
  
  courseSummary: document.getElementById('courseSummary'),
  courseList: document.getElementById('courseList'),
  accuracyPanel: document.getElementById('accuracyPanel'),
  timePanel: document.getElementById('timePanel'),
  
  accuracyUnits: document.getElementById('accuracyUnits'),
  timeUnits: document.getElementById('timeUnits'),
  
  accuracyMode: document.getElementById('accuracyMode'),
  accuracyValueA: document.getElementById('accuracyValueA'),
  accuracyValueB: document.getElementById('accuracyValueB'),
  timeMode: document.getElementById('timeMode'),
  timeValueA: document.getElementById('timeValueA'),
  timeValueB: document.getElementById('timeValueB'),
  
  runAccuracyBtn: document.getElementById('runAccuracyBtn'),
  stopAccuracyBtn: document.getElementById('stopAccuracyBtn'), 
  runTimeBtn: document.getElementById('runTimeBtn'),
  stopTimeBtn: document.getElementById('stopTimeBtn'),         
  
  clearLogBtn: document.getElementById('clearLogBtn'),
  exportLogBtn: document.getElementById('exportLogBtn'),
  statusLine: document.getElementById('statusLine'),
  logBox: document.getElementById('logBox'),
  modeTabs: document.querySelectorAll('.mode-tab'),
};

function setUIState(running) {
    state.isRunning = running;
    
    if (els.runAccuracyBtn) els.runAccuracyBtn.classList.toggle('hidden', running);
    if (els.stopAccuracyBtn) {
        els.stopAccuracyBtn.classList.toggle('hidden', !running);
        els.stopAccuracyBtn.disabled = false; 
    }
    if (els.runTimeBtn) els.runTimeBtn.classList.toggle('hidden', running);
    if (els.stopTimeBtn) {
        els.stopTimeBtn.classList.toggle('hidden', !running);
        els.stopTimeBtn.disabled = false;
    }

    els.modeTabs.forEach(tab => {
        if (!tab) return;
        tab.disabled = running;
        tab.style.opacity = running ? '0.5' : '1';
        tab.style.cursor = running ? 'not-allowed' : 'pointer';
    });

    const activePanel = state.mode === 'accuracy' ? els.accuracyPanel : els.timePanel;
    if (activePanel) {
        activePanel.querySelectorAll('input, select').forEach(el => el.disabled = running);
    }
    
    document.querySelectorAll('.course-item').forEach(el => {
        el.style.pointerEvents = running ? 'none' : 'auto';
        el.style.opacity = running ? '0.6' : '1';
    });
}

function showLoading(show) { 
    const loader = document.getElementById('loadingOverlay');
    if (loader) loader.classList.toggle('hidden', !show); 
}

async function initVisitorAndStats() {
    try {
        const statRes = await fetch(API.proxy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stats', type: 'visits' }) });
        const statData = await statRes.json();
        if (statData.status === 'success') {
            if (els.statVisits) els.statVisits.textContent = statData.data.visits;
            if (els.statLogins) els.statLogins.textContent = statData.data.logins;
            if (els.statRuns) els.statRuns.textContent = statData.data.runs;
            if (els.statTotalUsers) els.statTotalUsers.textContent = statData.data.total_users;
        }

        try {
            const ipRes = await fetch('https://ipapi.co/json/'); const ipData = await ipRes.json();
            if (ipData && ipData.ip) {
                const loc = [ipData.country_name, ipData.region, ipData.city].filter(Boolean).join(' ');
                if (els.visitorGreeting) els.visitorGreeting.textContent = `欢迎您，来自 ${ipData.ip} (${loc})`;
            } else { throw new Error("Fallback"); }
        } catch(e) {
            const fallbackRes = await fetch('https://api.ip.sb/geoip'); const fallbackData = await fallbackRes.json();
            if (fallbackData && fallbackData.ip) {
                const loc = [fallbackData.country, fallbackData.region, fallbackData.city].filter(Boolean).join(' ');
                if (els.visitorGreeting) els.visitorGreeting.textContent = `欢迎您，来自 ${fallbackData.ip} (${loc})`;
            } else { if (els.visitorGreeting) els.visitorGreeting.textContent = `欢迎您，亲爱的访客`; }
        }
    } catch (e) { if (els.visitorGreeting) els.visitorGreeting.textContent = `欢迎您，亲爱的访客`; }

    try {
        const annRes = await fetch(API.proxy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_announcement' }) });
        const annData = await annRes.json();
        if (annData.status === 'success' && annData.message && annData.message.trim() !== '') {
            if (els.announceText) els.announceText.innerText = annData.message; 
            if (els.announceModal) els.announceModal.classList.remove('hidden');
            let countdown = 5;
            if (els.announceBtn) {
                els.announceBtn.textContent = `我已阅读 (${countdown}s)`; els.announceBtn.disabled = true; els.announceBtn.style.opacity = '0.5';
                const timer = setInterval(() => {
                    countdown--;
                    if (countdown > 0) { els.announceBtn.textContent = `我已阅读 (${countdown}s)`; } else {
                        clearInterval(timer); els.announceBtn.textContent = "我已阅读并知晓"; els.announceBtn.disabled = false; els.announceBtn.style.opacity = '1';
                        els.announceBtn.onclick = () => { if (els.announceModal) els.announceModal.classList.add('hidden'); };
                    }
                }, 1000);
            }
        }
    } catch (e) {}
}

async function updateStat(type) {
    try {
        const res = await fetch(API.proxy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stats', type: type }) });
        const data = await res.json();
        if (data.status === 'success') {
            if (type === 'logins' && els.statLogins) els.statLogins.textContent = data.data.logins;
            if (type === 'runs' && els.statRuns) els.statRuns.textContent = data.data.runs;
        }
    } catch (e) {}
}

function log(message) {
  if (!els.logBox) return;
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  els.logBox.textContent = `${line}\n${els.logBox.textContent}`.trim();
}

function setStatus(message) { if (els.statusLine) els.statusLine.textContent = message; }
function setReadySteps(count) { state.readySteps = count; if (els.statReady) els.statReady.textContent = String(count); }

function setMode(mode) {
  if (state.isRunning) return; 
  state.mode = mode;
  els.modeTabs.forEach((tab) => { if (tab) tab.classList.toggle('is-active', tab.dataset.mode === mode); });
  if (els.accuracyPanel) els.accuracyPanel.classList.toggle('hidden', mode !== 'accuracy');
  if (els.timePanel) els.timePanel.classList.toggle('hidden', mode !== 'time');
}

function toggleInputVisibility(prefix) {
  const modeEl = document.getElementById(`${prefix}Mode`);
  const labelB = document.getElementById(`${prefix}LabelB`);
  const textA = document.getElementById(`${prefix}TextA`);
  if (!modeEl || !labelB || !textA) return;
  const mode = modeEl.value;
  if (mode === 'fixed') { textA.textContent = '固定值'; labelB.classList.add('hidden'); } 
  else { textA.textContent = '随机下限'; labelB.classList.remove('hidden'); }
}

function escapeHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function parseNumberInput(value, label) { const number = Number(String(value).trim()); if (!Number.isFinite(number)) throw new Error(`${label} 需要是数字`); return number; }
function getRandomInRange(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function updateWorkflowStat() { if (els.statWorkflow) els.statWorkflow.textContent = '2'; }

function renderCourses() {
  if (!els.courseSummary || !els.courseList) return;
  if (!state.courses.length) {
    els.courseSummary.textContent = '尚未加载';
    els.courseList.innerHTML = '<div class="empty-state">等待登录后加载课程...</div>';
    return;
  }
  
  els.courseSummary.innerHTML = `共 <strong>${state.courses.length}</strong> 门`;
  els.courseList.innerHTML = state.courses.map((course, index) => `
    <button class="course-item ${state.selectedCourse?.cid === course.cid ? 'is-active' : ''}" data-index="${index}" type="button">
      <span class="course-item__title">${escapeHtml(course.name)}</span>
      <span class="course-item__meta">NO.${index + 1} · 完成度 ${escapeHtml(course.per)}%</span>
    </button>
  `).join('');

  els.courseList.querySelectorAll('.course-item').forEach((button) => {
    button.addEventListener('click', () => { 
        if(!state.isRunning) selectCourse(Number(button.dataset.index)); 
    });
  });

  if (!state.selectedCourse) { selectCourse(0); }
}

function renderUnits() {
    if (!els.accuracyUnits || !els.timeUnits) return;
    if (!state.units || state.units.length === 0) {
        const emptyOpt = `<option value="-1" disabled>该课程没有单元或获取失败</option>`;
        els.accuracyUnits.innerHTML = emptyOpt;
        els.timeUnits.innerHTML = emptyOpt;
        return;
    }
    let optionsHtml = `<option value="all">>>> 选择全部单元 <<<</option>`;
    state.units.forEach((u, i) => {
        const visible = u.visible === 'true' ? '[已开放]' : '[未开放]';
        optionsHtml += `<option value="${i}">${i+1}. ${visible} ${escapeHtml(u.unitname)} - ${escapeHtml(u.name)}</option>`;
    });
    els.accuracyUnits.innerHTML = optionsHtml;
    els.timeUnits.innerHTML = optionsHtml;
}

async function selectCourse(index) {
  const course = state.courses[index];
  if (!course) return;
  state.selectedCourse = course;
  
  renderCourses(); 
  setReadySteps(Math.min(state.readySteps + 1, 2));
  
  if (els.accuracyUnits) els.accuracyUnits.innerHTML = '<option value="-1" disabled>🔄 正在加载该课程单元...</option>';
  if (els.timeUnits) els.timeUnits.innerHTML = '<option value="-1" disabled>🔄 正在加载该课程单元...</option>';
  
  log(`已选择课程：${course.name}，正在获取单元...`);
  try {
      await loadCourseMeta(course);
      renderUnits();
  } catch (e) {
      log(`获取课程单元失败: ${e.message}`);
      if (els.accuracyUnits) els.accuracyUnits.innerHTML = '<option value="-1" disabled>加载失败，请重试</option>';
      if (els.timeUnits) els.timeUnits.innerHTML = '<option value="-1" disabled>加载失败，请重试</option>';
  }
}

async function requestProxy(url, method = 'GET', body = '', headers = {}) {
  const cookieStr = Object.entries(state.cookieDict).map(([k, v]) => `${k}=${v}`).join('; ');

  const response = await fetch(API.proxy, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, body, headers, cookie: cookieStr })
  });

  if (!response.ok) throw new Error(`代理请求失败 HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`服务端代理错误: ${result.error}`);

  if (result.newCookies && result.newCookies.length > 0) {
    result.newCookies.forEach(c => {
      const parts = c.split('='); const key = parts[0].trim(); const val = parts.slice(1).join('=').trim();
      if(key) state.cookieDict[key] = val;
    });
  }
  return result; 
}

async function login() {
  if (!els.username || !els.password) return;
  const user = els.username.value.trim(); const pwd = els.password.value;
  if (!user || !pwd) throw new Error('用户名和密码不能为空');
  
  setStatus('正在获取登录重定向...'); log('开始登录，所有请求将通过 PHP 代理转发');

  const preRes = await requestProxy(API.prelogin, 'GET');
  let locationUrl = preRes.headers && preRes.headers.location;
  if (!locationUrl) throw new Error('未能获取预登录重定向地址');

  let rturl = "";
  try {
      const parsed = new URL(locationUrl, 'https://welearn.sflep.com');
      const codeChallenge = parsed.searchParams.get('code_challenge') || ''; 
      const stateValue = parsed.searchParams.get('state') || '';
      rturl = `/connect/authorize/callback?client_id=welearn_web&redirect_uri=https%3A%2F%2Fwelearn.sflep.com%2Fsignin-sflep&response_type=code&scope=openid%20profile%20email%20phone%20address&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=${encodeURIComponent(stateValue)}&x-client-SKU=ID_NET472&x-client-ver=6.32.1.0`;
  } catch(e) {
      rturl = `/connect/authorize/callback?client_id=welearn_web&redirect_uri=https%3A%2F%2Fwelearn.sflep.com%2Fsignin-sflep&response_type=code&scope=openid%20profile%20email%20phone%20address`;
  }
  
  const cipher = generateCipherText(pwd);
  const payload = new URLSearchParams();
  payload.set('rturl', rturl); payload.set('account', user); payload.set('pwd', cipher[0]); payload.set('ts', String(cipher[1]));

  const loginRes = await requestProxy('https://sso.sflep.com/idsvr/account/login', 'POST', payload.toString(), { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
  let loginData; try { loginData = JSON.parse(loginRes.body); } catch(e) { throw new Error('登录解析异常，可能密码错误或触发风控。'); }
  if (loginData.code === 1) throw new Error('帐号或密码错误');
  if (loginData.code !== 0) throw new Error(`登录返回异常：${loginData.msg || '未知错误'}`);

  setStatus('处理单点登录回调...');
  let nextUrl = `https://sso.sflep.com/idsvr${loginData.data}`;
  
  while (true) {
    const rdRes = await requestProxy(nextUrl, 'GET');
    if ([301, 302, 303, 307, 308].includes(rdRes.status) && rdRes.headers.location) { nextUrl = rdRes.headers.location; } else { break; }
  }

  if (els.cookieInput) els.cookieInput.value = Object.entries(state.cookieDict).map(([k,v])=>`${k}=${v}`).join('; ');
  state.loggedIn = true; state.sessionReady = true; setReadySteps(2); setStatus('登录成功'); 
  log('登录成功，已获取会话，Cookie 已自动填写至下方。'); updateStat('logins'); 

  if (els.logoutBtn) els.logoutBtn.classList.remove('hidden');
  await loadCoursesWrap();
}

function formatCookieInput() {
    if (!els.cookieInput) return;
    let rawStr = els.cookieInput.value.trim();
    if (!rawStr) { log('格式化失败：Cookie 输入框为空'); return; }
    try {
        const jsonStart = rawStr.indexOf('{'); if (jsonStart !== -1) { rawStr = rawStr.substring(jsonStart); }
        const jsonCookie = JSON.parse(rawStr);
        const formatted = Object.entries(jsonCookie).map(([k, v]) => `${k}=${v}`).join('; ');
        els.cookieInput.value = formatted; log('Cookie 格式化成功！');
    } catch (e) { log('Cookie 格式化失败，包含无效的 JSON 结构。'); }
}

function openCookieSplitModal() {
    if (!els.cookieInput || !els.cookieList || !els.cookieModal) return;
    const rawStr = els.cookieInput.value.trim();
    if (!rawStr) { log('无法分割：Cookie 输入框为空'); return; }
    const pairs = rawStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
    if (pairs.length === 0) { log('未能识别出有效的 Cookie 键值对'); return; }

    els.cookieList.innerHTML = '';
    pairs.forEach(pair => {
        const idx = pair.indexOf('='); if (idx === -1) return; 
        const key = pair.substring(0, idx).trim(); const val = pair.substring(idx + 1).trim();
        const pairDiv = document.createElement('div'); pairDiv.className = 'cookie-pair';
        const label = document.createElement('label'); label.textContent = key;
        const wrapper = document.createElement('div'); wrapper.className = 'cookie-input-wrapper';
        const input = document.createElement('input'); input.type = 'text'; input.value = val; input.readOnly = true; 
        const copyBtn = document.createElement('button'); copyBtn.className = 'copy-btn'; copyBtn.textContent = '复制';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(val).then(() => {
                const originalText = copyBtn.textContent; copyBtn.textContent = '成功!'; copyBtn.style.color = '#fff';
                setTimeout(() => { copyBtn.textContent = originalText; copyBtn.style.color = 'var(--text)'; }, 1500);
            }).catch(() => { log('复制失败'); });
        };
        wrapper.appendChild(input); wrapper.appendChild(copyBtn); pairDiv.appendChild(label); pairDiv.appendChild(wrapper); els.cookieList.appendChild(pairDiv);
    });
    if (els.cookieList.children.length === 0) { els.cookieList.innerHTML = '<div style="color:var(--muted)">没有解析出结构。</div>'; }
    els.cookieModal.classList.remove('hidden');
}

async function cookieLogin() {
  if (!els.cookieInput) return;
  const rawCookie = els.cookieInput.value.trim(); if(!rawCookie) throw new Error('请输入Cookie内容');
  state.cookieDict = {};
  rawCookie.split(';').forEach(pair => { let parts = pair.split('='); if(parts.length >= 2) { state.cookieDict[parts[0].trim()] = parts.slice(1).join('=').trim(); } });

  setStatus('正在验证Cookie...'); log('通过Cookie进行登录测试');
  state.loggedIn = true; state.sessionReady = true; setReadySteps(2); updateStat('logins'); 
  
  if (els.logoutBtn) els.logoutBtn.classList.remove('hidden');
  await loadCoursesWrap();
}

async function loadCoursesWrap() {
  const dataRes = await requestProxy(API.authCourse, 'GET', '', { 'Referer': 'https://welearn.sflep.com/2019/student/index.aspx' });
  let data; try { data = JSON.parse(dataRes.body); } catch(e) { throw new Error('Cookie 失效或网络异常'); }
  if (!data.clist || data.clist.length === 0) { throw new Error('未加载到课程，可能是无课或Cookie失效'); }
  log(`成功加载 ${data.clist.length} 门课程`); setStatus('已就绪'); state.courses = data.clist; renderCourses();
}

async function loadCourseMeta(course) {
  const res = await requestProxy(API.courseInfo(course.cid)); 
  const text = String(res.body || ''); 
  
  const uidMatch = text.match(/"uid":(.*?),/); const classIdMatch = text.match(/"classid":"(.*?)"/);
  if (!uidMatch || !classIdMatch) throw new Error('无法解析课程信息，Cookie可能已过期。');
  
  state.courseMeta = { uid: uidMatch[1], classid: classIdMatch[1], cid: course.cid };
  const unitsUrl = `${API.courseUnits}?action=courseunits&cid=${encodeURIComponent(course.cid)}&uid=${encodeURIComponent(state.courseMeta.uid)}`;
  const unitsRes = await requestProxy(unitsUrl, 'GET', '', { 'Referer': 'https://welearn.sflep.com/2019/student/course_info.aspx' });
  let unitsResponse; try { unitsResponse = JSON.parse(unitsRes.body); } catch(e) { throw new Error('获取单元列表异常'); }
  if (!unitsResponse.info) throw new Error('没有加载到单元列表'); state.units = unitsResponse.info; return state.units;
}

function resolveSelectedUnits(selectEl) {
    if (!selectEl) throw new Error("单元选择框不存在");
    const selectedOptions = Array.from(selectEl.selectedOptions);
    if (selectedOptions.length === 0 || selectedOptions[0].value === "-1" || selectedOptions[0].disabled) {
        throw new Error("请至少正确选择一个单元");
    }
    if (selectedOptions.some(opt => opt.value === "all")) {
        return state.units.map((_, index) => index);
    }
    return selectedOptions.map(opt => parseInt(opt.value));
}

async function ensureCourseAndUnits(mode) {
  if (!state.loggedIn) throw new Error('请先登录');
  const course = state.selectedCourse;
  if (!course) throw new Error('请在第一步【我的课程】中选择一门课程');
  if (!state.courseMeta || state.courseMeta.cid !== course.cid) { await loadCourseMeta(course); }
  const unitSelectEl = mode === 'accuracy' ? els.accuracyUnits : els.timeUnits;
  const unitsToProcess = resolveSelectedUnits(unitSelectEl);
  return { course, unitsToProcess };
}

function getAccuracyValue() {
  if (!els.accuracyMode || !els.accuracyValueA || !els.accuracyValueB) throw new Error("获取参数失败");
  const mode = els.accuracyMode.value;
  if (mode === 'fixed') {
      let fixedValue = parseNumberInput(els.accuracyValueA.value, '固定值');
      let num = Number(String(fixedValue).trim());
      if (num === 100 || num >= 100) { throw new Error('为了安全起见，固定正确率禁止设置为100（心里有点数就好）'); }
      return { random: false, value: fixedValue };
  }
  const min = parseNumberInput(els.accuracyValueA.value, '下限'); const max = parseNumberInput(els.accuracyValueB.value, '上限');
  if (min > max) throw new Error('下限不能大于上限'); return { random: true, min, max };
}

function getTimeValue() {
  if (!els.timeMode || !els.timeValueA || !els.timeValueB) throw new Error("获取参数失败");
  const mode = els.timeMode.value;
  if (mode === 'fixed') return { random: false, value: parseNumberInput(els.timeValueA.value, '固定值') };
  const min = parseNumberInput(els.timeValueA.value, '下限'); const max = parseNumberInput(els.timeValueB.value, '上限');
  if (min > max) throw new Error('下限不能大于上限'); return { random: true, min, max };
}

async function postForm(url, data, headers = {}) {
  const body = new URLSearchParams(); Object.entries(data).forEach(([k, v]) => body.set(k, String(v)));
  const res = await requestProxy(url, 'POST', body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers }); return res.body;
}

async function executeTask(taskType) {
    if (state.isRunning) return; 
    try {
        await ensureCourseAndUnits(taskType);
        setUIState(true);
        if (taskType === 'accuracy') { await runAccuracyLocal(); } else { await runTimeLocal(); }
    } catch(e) {
        log(`任务启动失败: ${e.message}`); setStatus('出错或被终止'); setUIState(false);
    }
}

async function runAccuracyLocal() {
  const { course, unitsToProcess } = await ensureCourseAndUnits('accuracy');
  const accuracyConfig = getAccuracyValue();

  let totalSuccess = 0;
  let totalFail = 0;

  for (const unitIndex of unitsToProcess) {
    if (!state.isRunning) break; 
    
    const unit = state.units[unitIndex]; if (!unit) continue;
    log(`==== 正在处理单元: ${unit.unitname} ====`);
    
    const leavesUrl = `${API.courseUnits}?action=scoLeaves&cid=${encodeURIComponent(course.cid)}&uid=${encodeURIComponent(state.courseMeta.uid)}&unitidx=${unitIndex}&classid=${encodeURIComponent(state.courseMeta.classid)}`;
    const leavesRes = await requestProxy(leavesUrl, 'GET', '', { 'Referer': `https://welearn.sflep.com/2019/student/course_info.aspx?cid=${course.cid}` });
    const leaves = JSON.parse(leavesRes.body); if (!leaves.info) continue;

    let unitSuccess = 0;
    let unitFail = 0;

    for (const chapter of leaves.info) {
        if (!state.isRunning) break; 
        
        if (chapter.isvisible === 'false') {
            log(`⏭️ 跳过未开放章节: ${chapter.location}`);
            continue;
        }

        const crate = accuracyConfig.random ? String(getRandomInRange(accuracyConfig.min, accuracyConfig.max)) : String(accuracyConfig.value);
        const data = `{"cmi":{"completion_status":"completed","interactions":[],"launch_data":"","progress_measure":"1","score":{"scaled":"${crate}","raw":"100"},"session_time":"0","success_status":"unknown","total_time":"0","mode":"normal"},"adl":{"data":[]},"cci":{"data":[],"service":{"dictionary":{"headword":"","short_cuts":""},"new_words":[],"notes":[],"writing_marking":[],"record":{"files":[]},"play":{"offline_media_id":"9999"}},"retry_count":"0","submit_time":""}}[INTERACTIONINFO]`;
        const scoid = chapter.id;
        const referer = `https://welearn.sflep.com/Student/StudyCourse.aspx?cid=${course.cid}&classid=${state.courseMeta.classid}&sco=${scoid}`;

        log(`▶️ 正在提交章节: ${chapter.location} [目标:${crate}%]`);

        try {
            await new Promise(r => setTimeout(r, 1000));
            if (!state.isRunning) break;
            await postForm(API.sco, { action: 'startsco160928', cid: course.cid, scoid: scoid, uid: state.courseMeta.uid }, { Referer: referer });
            
            await new Promise(r => setTimeout(r, 1000));
            if (!state.isRunning) break;
            const way1 = await postForm(API.sco, { action: 'setscoinfo', cid: course.cid, scoid: scoid, uid: state.courseMeta.uid, data, isend: 'False' }, { Referer: referer });
            
            await new Promise(r => setTimeout(r, 1000));
            if (!state.isRunning) break;
            const way2 = await postForm(API.sco, { action: 'savescoinfo160928', cid: course.cid, scoid: scoid, uid: state.courseMeta.uid, progress: '100', crate, status: 'unknown', cstatus: 'completed', trycount: '0' }, { Referer: referer });

            if (way1.includes('"ret":0') && way2.includes('"ret":0')) {
                unitSuccess++; totalSuccess++;
                log(`✅ 提交成功`);
            } else {
                unitFail++; totalFail++;
                log(`❌ 提交失败 (服务端拒绝)`);
            }
        } catch(e) {
            unitFail++; totalFail++;
            log(`❌ 提交异常: ${e.message}`);
        }
    }

    if (!state.isRunning) break;
    log(`本单元结束！成功 : ${unitSuccess}个，错误 : ${unitFail}个`);
    log(`回到选课处！！`);
  }
  
  if (!state.isRunning) {
      log(`⚠️ 流程已手动终止！目前累计成功: ${totalSuccess} 个，错误: ${totalFail} 个`);
  } else {
      log(`运行结束!! 成功: ${totalSuccess} 个，错误: ${totalFail} 个`);
  }
  
  setStatus('流程结算结束'); updateStat('runs'); setUIState(false);
}

async function runTimeLocal() {
  const { course, unitsToProcess } = await ensureCourseAndUnits('time');
  const timeConfig = getTimeValue();
  
  let totalErrors = [];
  let totalSuccessCount = 0; 

  for (const unitIndex of unitsToProcess) {
    if (!state.isRunning) break; 
    
    const unit = state.units[unitIndex]; if (!unit) continue;
    const leavesUrl = `${API.courseUnits}?action=scoLeaves&cid=${encodeURIComponent(course.cid)}&uid=${encodeURIComponent(state.courseMeta.uid)}&unitidx=${unitIndex}&classid=${encodeURIComponent(state.courseMeta.classid)}`;
    
    const leavesRes = await requestProxy(leavesUrl, 'GET', '', { 'Referer': `https://welearn.sflep.com/2019/student/course_info.aspx?cid=${course.cid}` });
    const leaves = JSON.parse(leavesRes.body); if (!leaves.info) continue;

    let tasks = [];
    let unitErrors = [];
    let unitSuccessCount = 0;
    let maxLearningTime = 0;
    let staggerDelay = 0; // 错峰延时计时器

    for (const chapter of leaves.info) {
        if (!state.isRunning) break; 
        if (chapter.isvisible === 'false') {
            log(`⏭️ 跳过未开放章节: ${chapter.location}`);
            continue;
        }
        
        const learningTime = timeConfig.random ? getRandomInRange(timeConfig.min, timeConfig.max) : timeConfig.value;
        if (learningTime > maxLearningTime) { maxLearningTime = learningTime; }

        tasks.push((async (currentStagger) => {
            await new Promise(r => setTimeout(r, currentStagger));
            if (!state.isRunning) return;

            const referer = `https://welearn.sflep.com/student/StudyCourse.aspx`;
            const scoid = chapter.id;

            log(`▶️ 开始并发行列 : ${chapter.location} (目标: ${learningTime}秒)`);

            try {
                await new Promise(r => setTimeout(r, 2000));
                if (!state.isRunning) return;
                let infoRes = await postForm(API.sco, { action: 'getscoinfo_v7', uid: state.courseMeta.uid, cid: course.cid, scoid: scoid }, { Referer: referer });
                
                if (infoRes.includes('学习数据不正确')) {
                    await new Promise(r => setTimeout(r, 2000));
                    await postForm(API.sco, { action: 'startsco160928', cid: course.cid, scoid: scoid, uid: state.courseMeta.uid }, { Referer: referer });
                    infoRes = await postForm(API.sco, { action: 'getscoinfo_v7', uid: state.courseMeta.uid, cid: course.cid, scoid: scoid }, { Referer: referer });
                    
                    if (infoRes.includes('学习数据不正确')) {
                        unitErrors.push(chapter.location); return;
                    }
                }

                let crate = '', cstatus = 'not_attempted', progress = '0', total_time = '0', session_time = '0';
                const jsonMatch = infoRes.match(/"comment":\s*(\{.*?\})/);
                if (jsonMatch) {
                    try {
                        const cmiData = JSON.parse(jsonMatch[1]).cmi;
                        if (cmiData) {
                            crate = cmiData.score.scaled; cstatus = cmiData.completion_status;
                            progress = cmiData.progress_measure; total_time = cmiData.total_time; session_time = cmiData.session_time;
                        }
                    } catch(e) {}
                }
                
                await new Promise(r => setTimeout(r, 2000));
                if (!state.isRunning) return;
                await postForm(API.sco, { action: 'keepsco_with_getticket_with_updatecmitime', uid: state.courseMeta.uid, cid: course.cid, scoid: scoid, session_time, total_time }, { Referer: referer });
                
                if (learningTime > 0) {
                    for(let i = 1; i <= learningTime; i++){
                        if(!state.isRunning) return; 
                        await new Promise(r => setTimeout(r, 1000));
                        if (i % 60 === 0) {
                            await postForm(API.sco, { action: 'keepsco_with_getticket_with_updatecmitime', uid: state.courseMeta.uid, cid: course.cid, scoid: scoid, session_time, total_time }, { Referer: referer });
                        }
                    }
                }
                
                await new Promise(r => setTimeout(r, 2000));
                if (!state.isRunning) return;
                const saveRes = await postForm(API.sco, { action: 'savescoinfo160928', uid: state.courseMeta.uid, cid: course.cid, scoid: scoid, crate, cstatus, status: 'unknown', progress, trycount: '0' }, { Referer: referer });
                
                if (saveRes.includes('"ret":0')) {
                    unitSuccessCount++; totalSuccessCount++;
                    log(`✅ ${chapter.location} 目标达成`);
                } else {
                    unitErrors.push(chapter.location); totalErrors.push(chapter.location);
                }
            } catch(e) { 
                unitErrors.push(chapter.location); totalErrors.push(chapter.location);
            }
        })(staggerDelay));

        staggerDelay += 1500; 
    }

    let heartbeatActive = true;
    const startTime = Date.now();
    const maxWaitTime = maxLearningTime + Math.floor(staggerDelay / 1000) + 5; 

    const heartbeatTimer = setInterval(() => {
        if(!heartbeatActive) { clearInterval(heartbeatTimer); return; }
        const passed = Math.floor((Date.now() - startTime) / 1000);
        setStatus(`并发错峰执行中 | 预计总耗时 : ${maxWaitTime}秒 | 已运行 : ${passed}秒`);
    }, 1000);

    await Promise.all(tasks);
    
    heartbeatActive = false;
    clearInterval(heartbeatTimer);

    if (!state.isRunning) break;
    
    log(`本单元结束！成功 : ${unitSuccessCount}个，错误 : ${unitErrors.length}个`);
    unitErrors.forEach((err, index) => { log(`第${index+1}个错误章节 : ${err}`); });
    log(`回到选课处！！`);
  }
  
  if (!state.isRunning) log("⚠️ 流程已手动终止！");
  else log(`运行结束!! 成功: ${totalSuccessCount} 个，错误: ${totalErrors.length} 个`);

  setStatus('流程结算结束'); updateStat('runs'); setUIState(false);
}

function exportLog() {
    if (!els.logBox) return;
    const content = els.logBox.textContent;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `welearn_log_${new Date().getTime()}.txt`; link.click(); URL.revokeObjectURL(url);
    log('已导出日志文件。');
}

function wireEvents() {
  els.modeTabs?.forEach((tab) => { tab.addEventListener('click', () => setMode(tab.dataset.mode)); });
  
  els.accuracyMode?.addEventListener('change', () => toggleInputVisibility('accuracy'));
  els.timeMode?.addEventListener('change', () => toggleInputVisibility('time'));

  els.logoutBtn?.addEventListener('click', () => { localStorage.removeItem('wl_username'); location.reload(); });

  els.loginBtn?.addEventListener('click', async () => {
    try { showLoading(true); await login(); } catch (error) { log(`登录失败：${error.message}`); setStatus('登录失败'); setReadySteps(0); } finally { showLoading(false); }
  });
  
  els.formatCookieBtn?.addEventListener('click', formatCookieInput);
  els.splitCookieBtn?.addEventListener('click', openCookieSplitModal);
  els.closeModalBtn?.addEventListener('click', () => els.cookieModal?.classList.add('hidden'));

  els.cookieBtn?.addEventListener('click', async () => {
    try { showLoading(true); await cookieLogin(); } catch (error) { log(`Cookie验证失败：${error.message}`); setStatus('Cookie失效'); } finally { showLoading(false); }
  });
  
  els.runAccuracyBtn?.addEventListener('click', () => executeTask('accuracy'));
  els.runTimeBtn?.addEventListener('click', () => executeTask('time'));
  
  const stopHandler = () => { 
      log("\n🛑 收到手动终止信号，正在清理任务队列并进入安全结算环节..."); 
      state.isRunning = false; 
      if (els.stopAccuracyBtn) els.stopAccuracyBtn.disabled = true;
      if (els.stopTimeBtn) els.stopTimeBtn.disabled = true;
  };
  els.stopAccuracyBtn?.addEventListener('click', stopHandler);
  els.stopTimeBtn?.addEventListener('click', stopHandler);

  els.clearLogBtn?.addEventListener('click', () => { if (els.logBox) els.logBox.textContent = '日志已清空'; });
  els.exportLogBtn?.addEventListener('click', exportLog);
}

function init() {
  initVisitorAndStats(); updateWorkflowStat(); setMode('accuracy');
  toggleInputVisibility('accuracy'); toggleInputVisibility('time');     
  renderCourses(); wireEvents(); setReadySteps(0); log('页面已初始化。');
}

init();