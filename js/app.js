// ========== CONFIG ==========
var FOOD_TSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQp-Ak-Q3KuiANDXbA0QsC_AVdIdmidoorrQEzOUBORjDJvVfWSn1pB2qhCKNYjPeA8yTFpiHY6hGa-/pub?gid=0&single=true&output=tsv';
var DISH_TSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQp-Ak-Q3KuiANDXbA0QsC_AVdIdmidoorrQEzOUBORjDJvVfWSn1pB2qhCKNYjPeA8yTFpiHY6hGa-/pub?gid=303617623&single=true&output=tsv';
var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwvQV7U8dBareulZcDAQNkysAxhK4z8cmnWpF3WZvFxuPv5VcNh7X172FjrMlejx6FH5Q/exec';
var CLOUD_URL = 'https://calories-calc.nitanaredleaf.workers.dev';

// ========== CRYPTO ==========
async function deriveKey(password, salt) {
  var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

function genSalt() { return crypto.getRandomValues(new Uint8Array(16)); }
function toB64(u8) { return btoa(String.fromCharCode.apply(null, u8)); }
function fromB64(str) { return Uint8Array.from(atob(str), function(c) { return c.charCodeAt(0); }); }

async function encrypt(obj, key) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return toB64(iv) + ':' + toB64(new Uint8Array(ct));
}

async function decrypt(str, key) {
  var p = str.split(':');
  var dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p[0]) }, key, fromB64(p[1]));
  return JSON.parse(new TextDecoder().decode(dec));
}

async function sha256str(str) {
  var data = new TextEncoder().encode(str);
  var hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// ========== AUTH STATE ==========
var _key = null;
var _profile = null;
var _diary = null;
var _cloudNick = localStorage.getItem('foodlook_cloud_nick') || '';
var _syncTimeout = null;

function hasSalt() { return localStorage.getItem('foodlook_salt') !== null; }

async function login(pass) {
  if (!hasSalt()) {
    var salt = genSalt();
    localStorage.setItem('foodlook_salt', toB64(salt));
    _key = await deriveKey(pass, salt);
    _profile = { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
    _diary = {};
    await saveLocal();
    return true;
  }
  var salt = fromB64(localStorage.getItem('foodlook_salt'));
  _key = await deriveKey(pass, salt);
  try {
    var pStr = localStorage.getItem('foodlook_profile');
    _profile = pStr ? await decrypt(pStr, _key) : { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
    var dStr = localStorage.getItem('foodlook_diary');
    _diary = dStr ? await decrypt(dStr, _key) : {};
    return true;
  } catch (e) { _key = null; return false; }
}

async function saveLocal() {
  if (!_key) return;
  localStorage.setItem('foodlook_profile', await encrypt(_profile, _key));
  localStorage.setItem('foodlook_diary', await encrypt(_diary, _key));
  syncDebounced();
}

function showProfileScreen() {
  if (!_profile) _profile = { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
  var el = document.getElementById('createPassScreen');
  if (el) el.style.display = 'none';
  el = document.getElementById('loginScreen');
  if (el) el.style.display = 'none';
  el = document.getElementById('profileScreen');
  if (el) el.style.display = 'block';
  renderProfile();
}

function showPasswordScreen() {
  var el = document.getElementById('profileScreen');
  if (el) el.style.display = 'none';
  if (hasSalt()) {
    el = document.getElementById('createPassScreen');
    if (el) el.style.display = 'none';
    el = document.getElementById('loginScreen');
    if (el) {
      el.style.display = 'block';
      document.getElementById('loginPass').value = '';
      document.getElementById('loginNick').value = _cloudNick || '';
      document.getElementById('loginNick').focus();
    }
  } else {
    el = document.getElementById('loginScreen');
    if (el) el.style.display = 'none';
    el = document.getElementById('createPassScreen');
    if (el) {
      el.style.display = 'block';
      document.getElementById('createPass').value = '';
      document.getElementById('createPassConfirm').value = '';
      document.getElementById('createNick').value = '';
      document.getElementById('createNick').focus();
    }
  }
}

async function clearAllData() {
  var cloudMsg = isCloudLoggedIn() ? ' та запис з хмари' : '';
  if (!confirm('Видалити всі локальні дані' + cloudMsg + ' (профіль, щоденник, пароль)? Це не можна скасувати.')) return;

  if (isCloudLoggedIn()) {
    var pass = sessionStorage.getItem('foodlook_pass');
    if (pass) {
      try {
        await fetch(CLOUD_URL + '/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick: _cloudNick, password: pass }),
        });
      } catch (e) { /* offline — just clear locally */ }
    }
  }

  localStorage.removeItem('foodlook_salt');
  localStorage.removeItem('foodlook_profile');
  localStorage.removeItem('foodlook_diary');
  localStorage.removeItem('foodlook_backup');
  localStorage.removeItem('foodlook_cloud_nick');
  localStorage.removeItem('foodlook_cloud_hash');
  sessionStorage.removeItem('foodlook_nick');
  sessionStorage.removeItem('foodlook_pass');
  _key = null; _profile = null; _diary = null; _cloudNick = '';
  showToast('Дані очищено');
  showPasswordScreen();
}

async function handleCreatePass() {
  var nick = document.getElementById('createNick').value.trim();
  var pass = document.getElementById('createPass').value;
  var confirm = document.getElementById('createPassConfirm').value;
  if (!nick) { showToast('Введіть нік'); return; }
  if (!pass) { showToast('Придумайте пароль'); return; }
  if (pass.length < 4) { showToast('Пароль має бути хоча б 4 символи'); return; }
  if (pass !== confirm) { showToast('Паролі не співпадають'); return; }
  var ok = await login(pass);
  if (ok) {
    sessionStorage.setItem('foodlook_nick', nick);
    sessionStorage.setItem('foodlook_pass', pass);
    var cloudOk = await cloudRegister(nick, pass);
    if (cloudOk) {
      showToast('Профіль створено та синхронізовано!');
    } else {
      showToast('Профіль створено (офлайн)');
    }
    showProfileScreen();
    loadTodayDiary();
    document.getElementById('createPass').value = '';
    document.getElementById('createPassConfirm').value = '';
    document.getElementById('createNick').value = '';
  } else {
    showToast('Помилка створення профілю');
  }
}

async function handleLogin() {
  var nick = document.getElementById('loginNick').value.trim();
  var pass = document.getElementById('loginPass').value;
  if (!nick) { showToast('Введіть нік'); return; }
  if (!pass) { showToast('Введи пароль'); return; }

  var cloudData = await cloudLoginFetch(nick, pass);
  if (cloudData) {
    localStorage.setItem('foodlook_salt', cloudData.salt);
    var salt = fromB64(cloudData.salt);
    _key = await deriveKey(pass, salt);
    try {
      _profile = cloudData.profile_enc ? await decrypt(cloudData.profile_enc, _key) : { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
      _diary = cloudData.diary_enc ? await decrypt(cloudData.diary_enc, _key) : {};
    } catch (e) {
      showToast('Невірний пароль');
      _key = null;
      return;
    }
    await saveLocal();
    _cloudNick = nick;
    localStorage.setItem('foodlook_cloud_nick', nick);
    var passHash = await sha256str(pass);
    localStorage.setItem('foodlook_cloud_hash', passHash);
    sessionStorage.setItem('foodlook_nick', nick);
    sessionStorage.setItem('foodlook_pass', pass);
    showToast('Ввійшли та синхронізовано');
    showProfileScreen();
    loadTodayDiary();
    document.getElementById('loginPass').value = '';
    document.getElementById('loginNick').value = '';
  } else {
    var ok = await login(pass);
    if (ok) {
      sessionStorage.setItem('foodlook_nick', nick);
      sessionStorage.setItem('foodlook_pass', pass);
      showToast('Увійшов (офлайн)');
      showProfileScreen();
      loadTodayDiary();
      document.getElementById('loginPass').value = '';
      document.getElementById('loginNick').value = '';
    } else {
      showToast('Невірний пароль');
    }
  }
}

async function autoLogin() {
  var nick = sessionStorage.getItem('foodlook_nick');
  var pass = sessionStorage.getItem('foodlook_pass');
  if (!nick || !pass) return;
  if (!hasSalt()) return;

  var salt = fromB64(localStorage.getItem('foodlook_salt'));
  _key = await deriveKey(pass, salt);
  try {
    var pStr = localStorage.getItem('foodlook_profile');
    _profile = pStr ? await decrypt(pStr, _key) : { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
    var dStr = localStorage.getItem('foodlook_diary');
    _diary = dStr ? await decrypt(dStr, _key) : {};
  } catch (e) {
    _key = null;
    sessionStorage.removeItem('foodlook_nick');
    sessionStorage.removeItem('foodlook_pass');
    return;
  }

  _cloudNick = localStorage.getItem('foodlook_cloud_nick') || '';
  showToast('Автовхід: ' + nick);
  showProfileScreen();
  loadTodayDiary();
  renderDashboard();
}

// ========== CLOUD SYNC ==========
function isCloudLoggedIn() { return !!_cloudNick; }

function updateCloudUI() {
  var statusEl = document.getElementById('cloudStatus');
  var actionsEl = document.getElementById('cloudActions');
  if (!statusEl) return;

  if (isCloudLoggedIn()) {
    statusEl.innerHTML = '● Синхронізовано як <strong>' + esc(_cloudNick) + '</strong>';
    statusEl.style.color = '#2D7D5F';
    if (actionsEl) actionsEl.style.display = 'block';
  } else {
    statusEl.innerHTML = '○ Офлайн';
    statusEl.style.color = '#A89888';
    if (actionsEl) actionsEl.style.display = 'none';
  }
}

async function cloudRegister(nick, pass) {
  if (!_key) return;
  var profileEnc = await encrypt(_profile, _key);
  var diaryEnc = await encrypt(_diary, _key);

  try {
    var res = await fetch(CLOUD_URL + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: nick, password: pass, salt: localStorage.getItem('foodlook_salt'), profile_enc: profileEnc, diary_enc: diaryEnc }),
    });
    var data = await res.json();
    if (data.error) { showToast(data.error); return false; }
    _cloudNick = nick;
    localStorage.setItem('foodlook_cloud_nick', nick);
    var passHash = await sha256str(pass);
    localStorage.setItem('foodlook_cloud_hash', passHash);
    return true;
  } catch (e) {
    showToast('Помилка реєстрації в хмарі');
    return false;
  }
}

async function cloudLoginFetch(nick, pass) {
  try {
    var res = await fetch(CLOUD_URL + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: nick, password: pass }),
    });
    var data = await res.json();
    if (data.error) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function cloudLogout() {
  _cloudNick = '';
  localStorage.removeItem('foodlook_cloud_nick');
  localStorage.removeItem('foodlook_cloud_hash');
  sessionStorage.removeItem('foodlook_nick');
  sessionStorage.removeItem('foodlook_pass');
  showToast('Вийшли з хмари');
  updateCloudUI();
}

async function syncToCloud() {
  if (!isCloudLoggedIn() || !_key) {
    console.log('[sync] skipped: cloudNick=' + _cloudNick + ' key=' + !!_key);
    return;
  }
  var passHash = localStorage.getItem('foodlook_cloud_hash');
  if (!passHash) {
    console.log('[sync] skipped: no passHash');
    return;
  }
  var profileEnc = await encrypt(_profile, _key);
  var diaryEnc = await encrypt(_diary, _key);
  console.log('[sync] sending:', { nick: _cloudNick, profileLen: profileEnc.length, diaryLen: diaryEnc.length });

  try {
    var res = await fetch(CLOUD_URL + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: _cloudNick, password: passHash, profile_enc: profileEnc, diary_enc: diaryEnc }),
    });
    var data = await res.json();
    console.log('[sync] response:', res.status, data);
    if (data.ok) {
      var statusEl = document.getElementById('cloudStatus');
      if (statusEl) statusEl.innerHTML = '● Синхронізовано ' + new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    } else {
      showToast('Синхронізація: ' + (data.error || 'помилка'));
    }
  } catch (e) {
    console.error('[sync] error:', e);
    var statusEl = document.getElementById('cloudStatus');
    if (statusEl) statusEl.innerHTML = '⚠ Помилка синхронізації';
  }
}

function syncDebounced() {
  if (!isCloudLoggedIn()) return;
  clearTimeout(_syncTimeout);
  _syncTimeout = setTimeout(syncToCloud, 2000);
}

async function syncFromCloud() {
  if (!isCloudLoggedIn() || !_key) {
    console.log('[syncFrom] skipped: cloudNick=' + _cloudNick + ' key=' + !!_key);
    return;
  }
  var passHash = localStorage.getItem('foodlook_cloud_hash');
  if (!passHash) {
    console.log('[syncFrom] skipped: no passHash');
    return;
  }

  try {
    var url = CLOUD_URL + '/sync?nick=' + encodeURIComponent(_cloudNick) + '&password=' + encodeURIComponent(passHash);
    console.log('[syncFrom] fetching...');
    var res = await fetch(url);
    var data = await res.json();
    console.log('[syncFrom] response:', res.status, data);
    if (data.error) return;

    var cloudProfile = data.profile_enc ? await decrypt(data.profile_enc, _key) : null;
    var cloudDiary = data.diary_enc ? await decrypt(data.diary_enc, _key) : null;
    console.log('[syncFrom] decrypted:', { profile: !!cloudProfile, diary: !!cloudDiary });

    if (cloudProfile && cloudProfile.name) _profile = cloudProfile;
    if (cloudDiary && Object.keys(cloudDiary).length > 0) _diary = cloudDiary;

    await saveLocal();
    var statusEl = document.getElementById('cloudStatus');
    if (statusEl) statusEl.innerHTML = '● Синхронізовано ' + new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    console.error('[syncFrom] error:', e);
  }
}

// ========== PROFILE ==========
function renderProfile() {
  if (!_profile) return;
  var el;
  el = document.getElementById('pWeight'); if (el) el.textContent = _profile.weight || '—';
  el = document.getElementById('pHeight'); if (el) el.textContent = _profile.height || '—';
  el = document.getElementById('pAge'); if (el) el.textContent = _profile.age || '—';
  el = document.getElementById('pNorm'); if (el) el.textContent = _profile.kcalNorm || '—';
  el = document.getElementById('editName'); if (el) el.value = _profile.name || '';
  el = document.getElementById('editAge'); if (el) el.value = _profile.age || '';
  el = document.getElementById('editGender'); if (el) el.value = _profile.gender || 'male';
  el = document.getElementById('editWeight'); if (el) el.value = _profile.weight || '';
  el = document.getElementById('editHeight'); if (el) el.value = _profile.height || '';
  el = document.getElementById('editNorm'); if (el) el.value = _profile.kcalNorm || '';
  el = document.getElementById('editDeficit'); if (el) el.value = _profile.deficit || 0;
  var photo = document.getElementById('profilePhoto');
  if (photo) {
    if (_profile.photo) { photo.src = _profile.photo; photo.style.background = ''; }
    else if (_profile.photoUrl) { photo.src = _profile.photoUrl; photo.style.background = ''; }
    else { photo.src = ''; photo.style.background = 'linear-gradient(135deg, #F0E8DE, #E8DDD0)'; }
  }
  el = document.getElementById('bmrResult'); if (el) el.textContent = '';
}

function pickPhoto() { document.getElementById('photoFileInput').click(); }

function handlePhotoFile(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement('canvas');
      var maxSize = 200;
      var w = img.width, h = img.height;
      if (w > h) { if (w > maxSize) { h = h * maxSize / w; w = maxSize; } }
      else { if (h > maxSize) { w = w * maxSize / h; h = maxSize; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      _profile.photo = canvas.toDataURL('image/jpeg', 0.7);
      _profile.photoUrl = '';
      renderProfile();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function setPhotoUrl() {
  var url = prompt('Введіть URL фото:', _profile.photoUrl || '');
  if (url === null) return;
  if (url) { _profile.photoUrl = url; _profile.photo = ''; }
  else { _profile.photoUrl = ''; }
  renderProfile();
}

function removePhoto() { _profile.photo = ''; _profile.photoUrl = ''; renderProfile(); }

async function saveProfile() {
  if (!_key) { showToast('Спочатку увійди'); return; }
  _profile.name = document.getElementById('editName').value || '';
  _profile.age = parseInt(document.getElementById('editAge').value) || 0;
  _profile.gender = document.getElementById('editGender').value || 'male';
  _profile.weight = parseFloat(document.getElementById('editWeight').value) || 0;
  _profile.height = parseFloat(document.getElementById('editHeight').value) || 0;
  _profile.kcalNorm = parseFloat(document.getElementById('editNorm').value) || 0;
  _profile.deficit = parseInt(document.getElementById('editDeficit').value) || 0;
  await saveLocal();
  showToast('Профіль збережено');
  renderProfile();
}

function calcBMR() {
  var weight = parseFloat(document.getElementById('editWeight').value) || 0;
  var height = parseFloat(document.getElementById('editHeight').value) || 0;
  var age = parseFloat(document.getElementById('editAge').value) || 0;
  var gender = document.getElementById('editGender').value;
  if (!weight || !height || !age) {
    document.getElementById('bmrResult').textContent = 'Заповніть вагу, зріст та вік';
    return;
  }
  var bmr = gender === 'male'
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;
  var deficit = parseInt(document.getElementById('editDeficit').value) || 0;
  var adjusted = Math.round(bmr * (1 + deficit / 100));
  document.getElementById('bmrResult').innerHTML = 'BMR: <strong>' + Math.round(bmr) + '</strong> ккал' +
    (deficit !== 0 ? ' → ' + (deficit > 0 ? '+' : '') + deficit + '%: <strong>' + adjusted + '</strong> ккал' : '');
  document.getElementById('editNorm').value = adjusted;
}

// ========== DASHBOARD ==========
function calcDailyNeeds() {
  if (!_profile || !_profile.weight || !_profile.height || !_profile.age) return null;

  var weight = _profile.weight;
  var height = _profile.height;
  var age = _profile.age;
  var gender = _profile.gender || 'male';

  var bmr = gender === 'male'
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;

  var tdee = Math.round(bmr * 1.4);
  var deficit = _profile.deficit || 0;
  var kcalTarget = Math.round(tdee * (1 + deficit / 100));

  var protPerKg = gender === 'male' ? 1.8 : 1.6;
  var fatPerKg = 0.9;
  var protTarget = Math.round(weight * protPerKg);
  var fatTarget = Math.round(weight * fatPerKg);

  var protCal = protTarget * 4;
  var fatCal = fatTarget * 9;
  var carbsCal = Math.max(0, kcalTarget - protCal - fatCal);
  var carbsTarget = Math.round(carbsCal / 4);

  return {
    bmr: Math.round(bmr),
    tdee: tdee,
    kcalTarget: kcalTarget,
    protTarget: protTarget,
    fatTarget: fatTarget,
    carbsTarget: carbsTarget,
    protPerKg: protPerKg,
    fatPerKg: fatPerKg
  };
}

function generateAdvice(todayData, needs) {
  if (!todayData || !needs) return { level: 'info', title: 'Недостатньо даних', text: 'Заповніть профіль та додайте продукти в щоденник.' };

  var tKkal = 0, tProt = 0, tFat = 0, tCarbs = 0;
  todayData.forEach(function(item) {
    tKkal += item.kkal;
    tProt += item.prot;
    tFat += item.fat;
    tCarbs += item.carbs;
  });

  var issues = [];
  var protPct = needs.protTarget > 0 ? (tProt / needs.protTarget * 100) : 0;
  var fatPct = needs.fatTarget > 0 ? (tFat / needs.fatTarget * 100) : 0;
  var carbsPct = needs.carbsTarget > 0 ? (tCarbs / needs.carbsTarget * 100) : 0;
  var kcalPct = needs.kcalTarget > 0 ? (tKkal / needs.kcalTarget * 100) : 0;

  if (tKkal === 0) {
    return { level: 'info', title: 'Почніть день!', text: 'Сьогодні ви ще нічого не з\'їли. Додайте перший продукт в щоденник.' };
  }

  if (protPct < 70) {
    issues.push('Білка недостатньо (' + Math.round(protPct) + '% від норми). Додайте курку, рибу, яйця, бобові або молочні продукти.');
  } else if (protPct > 150) {
    issues.push('Забагато білка (' + Math.round(protPct) + '%). Це може бути важко для нирок.');
  }

  if (fatPct > 130) {
    issues.push('Забагато жирів (' + Math.round(fatPct) + '%). Зменшіть кількість олії, масла та жирних продуктів.');
  } else if (fatPct < 60 && tKkal > 0) {
    issues.push('Мало жирів (' + Math.round(fatPct) + '%). Додайте горіхи, авокадо або оливкову олію.');
  }

  if (kcalPct > 120) {
    issues.push('Калорії перевищують норму на ' + Math.round(kcalPct - 100) + '%. Спробуйте меншу порцію або легший перекус.');
  } else if (kcalPct < 60 && tKkal > 0) {
    issues.push('Сьогодні ви з\'їли лише ' + Math.round(kcalPct) + '% від норми. Не забудьте поїсти!');
  }

  if (carbsPct > 140) {
    issues.push('Забагато вуглеводів (' + Math.round(carbsPct) + '%). Обмежте солодощі та білий хліб.');
  }

  if (issues.length === 0) {
    return {
      level: 'success',
      title: 'Чудово! Все в нормі',
      text: 'Ви дотримуєтесь своєї норми. Продовжуйте в тому ж дусі!'
    };
  }

  var level = issues.length >= 3 ? 'danger' : 'warning';
  return {
    level: level,
    title: 'Є зауваження',
    text: issues.join(' ')
  };
}

function renderDashboard() {
  var needs = calcDailyNeeds();
  var today = new Date().toISOString().slice(0, 10);
  var items = getDiaryItems(today);

  var tKkal = 0, tProt = 0, tFat = 0, tCarbs = 0;
  items.forEach(function(item) {
    tKkal += item.kkal;
    tProt += item.prot;
    tFat += item.fat;
    tCarbs += item.carbs;
  });

  var el = document.getElementById('dashContent');
  if (!el) return;

  if (!needs) {
    el.innerHTML = '<div class="empty-state">Заповніть профіль (вага, зріст, вік), щоб побачити дашборд.</div>';
    return;
  }

  var protPct = Math.min(100, needs.protTarget > 0 ? (tProt / needs.protTarget * 100) : 0);
  var fatPct = Math.min(100, needs.fatTarget > 0 ? (tFat / needs.fatTarget * 100) : 0);
  var carbsPct = Math.min(100, needs.carbsTarget > 0 ? (tCarbs / needs.carbsTarget * 100) : 0);
  var kcalPct = Math.min(100, needs.kcalTarget > 0 ? (tKkal / needs.kcalTarget * 100) : 0);

  function pctColor(pct) {
    if (pct > 110) return 'red';
    if (pct >= 70) return 'green';
    return 'orange';
  }

  var html = '';

  html += '<div class="dash-summary">';
  html += '<div class="dash-stat"><span class="num">' + Math.round(tKkal) + '</span><span class="lbl">Калорії сьогодні</span></div>';
  html += '<div class="dash-stat"><span class="num">' + needs.kcalTarget + '</span><span class="lbl">Норма</span></div>';
  html += '<div class="dash-stat"><span class="num">' + (_profile.weight || '—') + ' кг</span><span class="lbl">Поточна вага</span></div>';
  html += '<div class="dash-stat"><span class="num">' + needs.bmr + '</span><span class="lbl">BMR</span></div>';
  html += '</div>';

  html += '<div class="progress-wrap">';
  html += '<div class="progress-header"><span class="progress-label">🔥 Калорії</span><span class="progress-value">' + Math.round(tKkal) + ' / ' + needs.kcalTarget + ' ккал</span></div>';
  html += '<div class="progress-bar"><div class="progress-fill ' + pctColor(kcalPct) + '" style="width:' + kcalPct + '%"></div></div>';
  html += '</div>';

  html += '<div class="progress-wrap">';
  html += '<div class="progress-header"><span class="progress-label">🥩 Білки</span><span class="progress-value">' + Math.round(tProt) + ' / ' + needs.protTarget + ' г</span></div>';
  html += '<div class="progress-bar"><div class="progress-fill ' + pctColor(protPct) + '" style="width:' + protPct + '%"></div></div>';
  html += '</div>';

  html += '<div class="progress-wrap">';
  html += '<div class="progress-header"><span class="progress-label">🧈 Жири</span><span class="progress-value">' + Math.round(tFat) + ' / ' + needs.fatTarget + ' г</span></div>';
  html += '<div class="progress-bar"><div class="progress-fill ' + pctColor(fatPct) + '" style="width:' + fatPct + '%"></div></div>';
  html += '</div>';

  html += '<div class="progress-wrap">';
  html += '<div class="progress-header"><span class="progress-label">🍞 Вуглеводи</span><span class="progress-value">' + Math.round(tCarbs) + ' / ' + needs.carbsTarget + ' г</span></div>';
  html += '<div class="progress-bar"><div class="progress-fill ' + pctColor(carbsPct) + '" style="width:' + carbsPct + '%"></div></div>';
  html += '</div>';

  var advice = generateAdvice(items, needs);
  var adviceClass = advice.level === 'success' ? 'success' : (advice.level === 'danger' ? 'danger' : (advice.level === 'warning' ? 'warning' : ''));
  html += '<div class="advice-card ' + adviceClass + '">';
  html += '<div class="advice-title">' + advice.title + '</div>';
  html += '<div class="advice-text">' + advice.text + '</div>';
  html += '</div>';

  el.innerHTML = html;
}

// ========== EXPORT / IMPORT ==========
function showExport() {
  var pass = prompt('Введіть ваш пароль профілю для шифрування бекапу:');
  if (!pass) return;
  doExport(pass);
}

async function doExport(pass) {
  var salt = genSalt();
  var expKey = await deriveKey(pass, salt);
  var data = { profile: _profile || {}, diary: _diary || {} };
  var encrypted = await encrypt(data, expKey);
  var json = JSON.stringify({ v: 1, salt: toB64(salt), data: encrypted });
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'foodlook-backup.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Бекап створено');
  localStorage.setItem('foodlook_backup', Date.now().toString());
}

function showImport() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      var pass = prompt('Введіть ваш пароль профілю для розшифрування:');
      if (!pass) return;
      doImport(ev.target.result, pass);
    };
    reader.readAsText(file);
  };
  input.click();
}

async function doImport(jsonStr, pass) {
  try {
    var pkg = JSON.parse(jsonStr);
    var salt = fromB64(pkg.salt);
    var impKey = await deriveKey(pass, salt);
    var data = await decrypt(pkg.data, impKey);
    var wasLoggedIn = !!_key;
    if (!_key) {
      localStorage.setItem('foodlook_salt', toB64(salt));
      _key = impKey;
    }
    _profile = data.profile || { name: '', age: 0, gender: 'male', weight: 0, height: 0, kcalNorm: 0, deficit: 0, photo: '', photoUrl: '' };
    _diary = data.diary || {};
    await saveLocal();
    if (!wasLoggedIn) {
      showToast('Дані відновлено!');
      showProfileScreen();
      loadTodayDiary();
    } else {
      showToast('Дані імпортовано');
      renderProfile();
      loadTodayDiary();
    }
  } catch (e) {
    showToast('Невірний пароль або пошкоджений файл');
  }
}

// ========== DIARY ==========
function loadTodayDiary() {
  if (!_key) return;
  var today = new Date().toISOString().slice(0, 10);
  var dateEl = document.getElementById('diaryDate');
  if (dateEl) dateEl.value = today;
  renderDiary(today);
}

function getDiaryItems(date) { return (_diary && _diary[date]) || []; }

function renderDiary(date) {
  var el = document.getElementById('diaryItems');
  var summary = document.getElementById('diarySummary');
  if (!el) return;
  el.innerHTML = '';
  var items = getDiaryItems(date);
  if (items.length === 0) {
    if (summary) summary.style.display = 'none';
    el.innerHTML = '<div class="empty-state">🍽️ Записів немає</div>';
    renderInfographics([]);
    return;
  }

  var tKkal = 0, tProt = 0, tFat = 0, tCarbs = 0;
  items.forEach(function(item, idx) {
    tKkal += item.kkal; tProt += item.prot; tFat += item.fat; tCarbs += item.carbs;
    var d = document.createElement('div');
    d.className = 'diary-item';
    d.innerHTML = '<span class="diary-name">' + esc(item.name) + ' (' + item.weight + 'г)</span>' +
      '<span class="diary-kkal">' + Math.round(item.kkal) + ' ккал</span>' +
      '<span class="diary-del" onclick="deleteDiaryItem(' + idx + ')">✕</span>';
    el.appendChild(d);
  });

  var norm = (_profile && _profile.kcalNorm) || 2000;
  var e;
  e = document.getElementById('dTotalKkal'); if (e) e.textContent = Math.round(tKkal);
  e = document.getElementById('dTotalProt'); if (e) e.textContent = Math.round(tProt) + 'г';
  e = document.getElementById('dTotalFat'); if (e) e.textContent = Math.round(tFat) + 'г';
  e = document.getElementById('dTotalCarbs'); if (e) e.textContent = Math.round(tCarbs) + 'г';
  e = document.getElementById('dPercent'); if (e) e.textContent = Math.round(tKkal / norm * 100) + '%';
  if (summary) summary.style.display = 'block';
  renderInfographics(items);
}

var _diarySelected = null;

async function addDiaryEntry() {
  var p = _diarySelected;
  var w = parseFloat(document.getElementById('diaryWeight').value) || 0;
  if (!p || w <= 0) { showToast('Виберіть продукт та вагу'); return; }
  if (!_key) { showToast('Спочатку увійдіть в профіль'); return; }
  var date = document.getElementById('diaryDate').value || new Date().toISOString().slice(0, 10);
  var factor = w / 100;
  var entry = { name: p.name, weight: w, kkal: p.kkal * factor, prot: p.prot * factor, fat: p.fat * factor, carbs: p.carbs * factor };
  if (!_diary[date]) _diary[date] = [];
  _diary[date].push(entry);
  await saveLocal();
  showToast('Додано');
  document.getElementById('diarySearch').value = '';
  document.getElementById('diaryWeight').value = '';
  _diarySelected = null;
  document.getElementById('addDiaryBtn').disabled = true;
  renderDiary(date);
}

async function deleteDiaryItem(idx) {
  var date = document.getElementById('diaryDate').value;
  if (!_diary[date] || idx < 0 || idx >= _diary[date].length) return;
  _diary[date].splice(idx, 1);
  await saveLocal();
  renderDiary(date);
}

// ========== INFOGRAPHICS ==========
function renderInfographics(items) {
  var card = document.getElementById('infocard');
  if (!card) return;
  if (!items || items.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  var tProt = 0, tFat = 0, tCarbs = 0;
  items.forEach(function(i) { tProt += i.prot; tFat += i.fat; tCarbs += i.carbs; });
  var total = tProt + tFat + tCarbs;
  var ring = document.getElementById('ringChart');
  if (ring) {
    ring.innerHTML = '';
    if (total > 0) {
      ring.appendChild(makeRing(tProt / total * 100, '#2D7D5F', '🥩 Білки'));
      ring.appendChild(makeRing(tFat / total * 100, '#E8A849', '🧈 Жири'));
      ring.appendChild(makeRing(tCarbs / total * 100, '#D44239', '🍞 Вуглеводи'));
    }
  }
  var weekEl = document.getElementById('weekChart');
  if (weekEl) {
    if (_profile && _profile.kcalNorm) { renderWeekChart(weekEl); }
    else { weekEl.innerHTML = '<div class="empty-state">Встановіть норму ккал в профілі</div>'; }
  }
}

function makeRing(pct, color, label) {
  var wrap = document.createElement('div');
  wrap.style.textAlign = 'center';
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '90'); svg.setAttribute('height', '90'); svg.setAttribute('viewBox', '0 0 36 36');
  var r = 15.9, circ = 2 * Math.PI * r;
  ['#E8DDD0', color].forEach(function(stroke, i) {
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '18'); circle.setAttribute('cy', '18'); circle.setAttribute('r', '' + r);
    circle.setAttribute('fill', 'none'); circle.setAttribute('stroke', stroke); circle.setAttribute('stroke-width', '3.5');
    circle.setAttribute('stroke-linecap', 'round');
    if (i === 1) {
      circle.setAttribute('stroke-dasharray', '' + circ);
      circle.setAttribute('stroke-dashoffset', '' + (circ - pct / 100 * circ));
      circle.setAttribute('transform', 'rotate(-90 18 18)');
    }
    svg.appendChild(circle);
  });
  wrap.appendChild(svg);
  var lbl = document.createElement('div');
  lbl.className = 'ring-label';
  lbl.textContent = Math.round(pct) + '% ' + label;
  wrap.appendChild(lbl);
  return wrap;
}

function renderWeekChart(el) {
  var norm = (_profile && _profile.kcalNorm) || 2000;
  var dates = [];
  var today = new Date();
  for (var i = 6; i >= 0; i--) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  el.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:10px;text-align:center;font-family:var(--font-heading);color:var(--text);">Останні 7 днів</div>';
  var dayNames = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  dates.forEach(function(d) {
    var items = getDiaryItems(d);
    var kkal = 0;
    items.forEach(function(it) { kkal += it.kkal; });
    var pct = Math.min(100, kkal / norm * 100);
    var row = document.createElement('div');
    row.className = 'chart-row';
    var color = pct > 100 ? '#E06050' : (pct > 80 ? '#2D7D5F' : '#E8A849');
    row.innerHTML = '<span style="min-width:32px;font-weight:600;">' + dayNames[new Date(d).getDay()] + '</span>' +
      '<div class="bar" style="width:' + Math.max(3, pct) + '%;background:' + color + ';"></div>' +
      '<span class="bar-label">' + Math.round(kkal) + '</span>';
    el.appendChild(row);
  });
}

// ========== CALCULATOR ==========
var html5QrCode = null, scannerRunning = false, items = [], currentItem = null;

function initCalculator() {
  var searchInput = document.getElementById('searchInput');
  var productSelect = document.getElementById('productSelect');
  var productList = document.getElementById('productList');
  var notFoundMsg = document.getElementById('notFoundMsg');
  var barcodeInput = document.getElementById('barcodeInput');
  var weightInput = document.getElementById('weightInput');

  if (!searchInput) return;

  var searchTimeout;
  searchInput.addEventListener('input', function() { clearTimeout(searchTimeout); searchTimeout = setTimeout(doSearch, 200); });
  searchInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  if (barcodeInput) {
    barcodeInput.addEventListener('input', function() { lookupBarcode(barcodeInput.value.trim()); });
    barcodeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); lookupBarcode(barcodeInput.value.trim()); } });
  }

  if (productSelect) {
    productSelect.addEventListener('change', function() {
      var p = items.find(function(x) { return x.name === productSelect.value; });
      if (p) selectItem(p);
      productList.style.display = 'none';
    });
  }

  if (weightInput) {
    weightInput.addEventListener('input', updateResult);
  }

  function doSearch() {
    var q = searchInput.value.toLowerCase().trim();
    notFoundMsg.style.display = 'none';
    if (!q) { productList.style.display = 'none'; currentItem = null; document.getElementById('resultCard').style.display = 'none'; return; }
    if (barcodeInput) barcodeInput.value = '';
    var filtered = items.filter(function(p) { return p.name.toLowerCase().includes(q) || (p.code && p.code.includes(q)); });
    if (filtered.length === 0) {
      productList.style.display = 'none';
      notFoundMsg.innerHTML = 'Немає в базі. <a href="javascript:void(0)" onclick="window.open(WEB_APP_URL,\'_blank\')" style="color:var(--primary);font-weight:600;">Додати</a>';
      notFoundMsg.style.display = 'block'; currentItem = null; document.getElementById('resultCard').style.display = 'none'; return;
    }
    if (filtered.length > 20) { productList.style.display = 'none'; notFoundMsg.style.display = 'none'; return; }
    notFoundMsg.style.display = 'none';
    productSelect.innerHTML = '';
    filtered.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = (p.type === 'dish' ? '[🍲] ' : (p.category ? catEmoji(p.category) : '')) + p.name + (p.code ? ' [' + p.code + ']' : '');
      productSelect.appendChild(opt);
    });
    productList.style.display = 'block';
  }

  function selectItem(p) {
    currentItem = p;
    searchInput.value = (p.type === 'dish' ? '🍲 ' : (p.category ? catEmoji(p.category) : '')) + p.name;
    productList.style.display = 'none'; notFoundMsg.style.display = 'none';
    if (barcodeInput) barcodeInput.value = p.code || '';
    updateResult();
  }

  function lookupBarcode(code) {
    productList.style.display = 'none'; notFoundMsg.style.display = 'none'; searchInput.value = '';
    if (!code) { currentItem = null; document.getElementById('resultCard').style.display = 'none'; return; }
    var p = items.find(function(x) { return x.code === code; });
    if (p) { selectItem(p); showToast(p.name, 2000); }
    else {
      currentItem = null; document.getElementById('resultCard').style.display = 'none';
      notFoundMsg.innerHTML = 'Код: ' + code + '<br><a href="javascript:void(0)" onclick="window.open(WEB_APP_URL,\'_blank\')" style="color:var(--primary);font-weight:600;">Додати</a>';
      notFoundMsg.style.display = 'block';
    }
  }

  function updateResult() {
    var w = parseFloat(weightInput.value) || 0;
    if (!currentItem || w <= 0) { document.getElementById('resultCard').style.display = 'none'; return; }
    var factor = w / 100;
    var tag = currentItem.type === 'dish' ? '🍲 ' : (currentItem.category ? catEmoji(currentItem.category) : '');
    document.getElementById('productName').textContent = tag + currentItem.name;
    document.getElementById('resKkal').textContent = Math.round(currentItem.kkal * factor * 10) / 10;
    document.getElementById('resProt').textContent = Math.round(currentItem.prot * factor * 10) / 10;
    document.getElementById('resFat').textContent = Math.round(currentItem.fat * factor * 10) / 10;
    document.getElementById('resCarbs').textContent = Math.round(currentItem.carbs * factor * 10) / 10;
    var badge = document.getElementById('codeBadge');
    if (currentItem.code) { badge.textContent = currentItem.code; badge.style.display = 'inline-flex'; }
    else if (currentItem.type === 'dish') { badge.textContent = '🍲 Страва'; badge.style.display = 'inline-flex'; }
    else { badge.style.display = 'none'; }
    document.getElementById('resultCard').style.display = 'block';
  }

  window.toggleScanner = function() {
    if (scannerRunning) { stopScanner(); return; }
    document.getElementById('scanner').style.display = 'block';
    if (!html5QrCode) html5QrCode = new Html5Qrcode("scanner");
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 150 } }, onScanSuccess)
      .then(function() { scannerRunning = true; }).catch(function(err) { showToast('Камера: ' + err); });
  };

  function stopScanner() {
    if (html5QrCode) html5QrCode.stop().then(function() { scannerRunning = false; document.getElementById('scanner').style.display = 'none'; });
  }

  function onScanSuccess(decodedText) { stopScanner(); barcodeInput.value = decodedText; lookupBarcode(decodedText); }
}

// ========== DIARY SEARCH ==========
function initDiarySearch() {
  var diarySearch = document.getElementById('diarySearch');
  var diarySuggest = document.getElementById('diarySuggest');
  var diaryWeight = document.getElementById('diaryWeight');
  var addDiaryBtn = document.getElementById('addDiaryBtn');
  var diaryDate = document.getElementById('diaryDate');

  if (!diarySearch) return;

  diarySearch.addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    diarySuggest.innerHTML = '';
    _diarySelected = null;
    addDiaryBtn.disabled = true;
    if (!q) return;
    var filtered = items.filter(function(p) { return p.name.toLowerCase().includes(q); }).slice(0, 10);
    filtered.forEach(function(p) {
      var d = document.createElement('div');
      d.textContent = p.name;
      d.onclick = function() {
        diarySearch.value = p.name;
        diarySuggest.innerHTML = '';
        _diarySelected = p;
        addDiaryBtn.disabled = !diaryWeight.value;
      };
      diarySuggest.appendChild(d);
    });
  });

  diaryWeight.addEventListener('input', function() {
    addDiaryBtn.disabled = !this.value || !_diarySelected;
  });

  diaryWeight.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !addDiaryBtn.disabled) addDiaryEntry();
  });

  if (diaryDate) {
    diaryDate.addEventListener('change', function() { if (this.value) renderDiary(this.value); });
  }
}

// ========== TABS ==========
function switchTab(tab) {
  document.querySelectorAll('.tab-bar button, .sidebar-nav a[data-tab], .header-nav a[data-tab]').forEach(function(b) { b.classList.remove('active'); });
  var selector1 = '.tab-bar button[data-tab="' + tab + '"]';
  var selector2 = '.sidebar-nav a[data-tab="' + tab + '"]';
  var selector3 = '.header-nav a[data-tab="' + tab + '"]';
  var activeBtn = document.querySelector(selector1) || document.querySelector(selector2) || document.querySelector(selector3);
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
  var tabEl = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (tabEl) tabEl.classList.add('active');

  if (tab === 'profile') { if (_key) { showProfileScreen(); updateCloudUI(); } else showPasswordScreen(); }
  if (tab === 'diary' && _key) loadTodayDiary();
  if (tab === 'dashboard') renderDashboard();
}

// ========== UTILITIES ==========
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function showToast(msg, d) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, d || 3000);
}

var CATEGORY_EMOJI = {
  'Овочі': '🥬', 'Фрукти': '🍎', 'Ягоди': '🫐', 'Горіхи та сухофрукти': '🥜', 'Гриби': '🍄',
  'М\'ясо': '🥩', 'Птиця': '🍗', 'Риба': '🐟', 'Морепродукти': '🦐', 'Яйця': '🥚',
  'Молочні продукти': '🥛', 'Сири': '🧀', 'Масло та маргарин': '🧈',
  'Хліб та випічка': '🍞', 'Кондитерські вироби': '🍪', 'Шоколад та цукерки': '🍫', 'Печиво та вафлі': '🧇', 'Жувальні цукерки та льодяники': '🍬', 'Снеки': '🍿',
  'Крупи': '🌾', 'Макаронні вироби': '🍝', 'Бобові': '🫘', 'Сухі сніданки': '🥣',
  'Консерви': '🥫', 'Соуси та кетчупи': '🥫', 'Спеції та приправи': '🌿', 'Трави': '🌿',
  'Сіль, цукор': '🧂', 'Мед та варення': '🍯', 'Олія та оцет': '🫒', 'Кава': '☕', 'Чай': '🍵', 'Напої': '🥤', 'Вода': '💧', 'Алкоголь': '🍷',
  'Заморожені продукти': '❄️', 'Готові страви': '🍱', 'Дитяче харчування': '🍼', 'Здорове харчування': '💚'
};

function catEmoji(c) {
  if (!c) return '';
  var m = c.match(/^(\S+)\s/);
  if (m && m[1].length > 1) return m[1] + ' ';
  return CATEGORY_EMOJI[c] || '';
}

// ========== INIT ==========
var foodP = fetch(FOOD_TSV).then(function(r) { return r.text(); }).catch(function() { return ''; });
var dishP = DISH_TSV ? fetch(DISH_TSV).then(function(r) { return r.text(); }).catch(function() { return ''; }) : Promise.resolve('');

Promise.all([foodP, dishP]).then(function(results) {
  var foodText = results[0];
  var dishText = results[1];
  items = [];
  if (foodText) {
    var lines = foodText.trim().split('\n');
    for (var i = 1; i < lines.length; i++) {
      var cols = lines[i].split('\t');
      if (cols[0] && cols[0].trim()) {
        items.push({ type: 'product', name: cols[0].trim(),
          kkal: parseFloat(cols[1]) || 0, prot: parseFloat(cols[2]) || 0,
          fat: parseFloat(cols[3]) || 0, carbs: parseFloat(cols[4]) || 0,
          code: cols[5] ? cols[5].trim() : '', category: cols[6] ? cols[6].trim() : '' });
      }
    }
  }
  if (dishText) {
    var lines = dishText.trim().split('\n');
    for (var i = 1; i < lines.length; i++) {
      var cols = lines[i].split('\t');
      if (cols[0] && cols[1] && cols[1].trim()) {
        items.push({ type: 'dish', name: cols[1].trim(),
          kkal: parseFloat(cols[2]) || 0, prot: parseFloat(cols[3]) || 0,
          fat: parseFloat(cols[4]) || 0, carbs: parseFloat(cols[5]) || 0, ingredients: cols[6] || '' });
      }
    }
  }
  var loadingEl = document.getElementById('loadingMsg');
  if (loadingEl) loadingEl.style.display = 'none';
  var contentEl = document.getElementById('content');
  if (contentEl) contentEl.style.display = 'block';
  if (items.length === 0) showToast('База порожня', 4000);
  autoLogin();

  initCalculator();
  initDiarySearch();
  initEventListeners();
}).catch(function(err) {
  var loadingEl = document.getElementById('loadingMsg');
  if (loadingEl) loadingEl.innerHTML = 'Помилка: ' + err.message;
});

// ========== EVENT LISTENERS ==========
function initEventListeners() {
  var el;
  el = document.getElementById('loginPass'); if (el) el.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleLogin(); });
  el = document.getElementById('loginNick'); if (el) el.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleLogin(); });
  el = document.getElementById('createPass'); if (el) el.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleCreatePass(); });
  el = document.getElementById('createPassConfirm'); if (el) el.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleCreatePass(); });
  el = document.getElementById('createNick'); if (el) el.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleCreatePass(); });
  el = document.getElementById('photoFileInput'); if (el) el.addEventListener('change', handlePhotoFile);
}
