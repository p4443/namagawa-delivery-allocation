const KEY = 'delivery-desk-v4';
const SHARED_STATE_URL = '/api/state';
const ROUTE_MATRIX_URL = '/api/route-matrix';
const MAX_ROUTE_STOPS = 18;

// スタイル・ダイアログの追加
const manualStyle = document.createElement('style');
manualStyle.textContent = `.app-footer{margin-top:18px;padding:14px 0 4px;border-top:1px solid var(--line);text-align:center}.manual-dialog{width:min(640px,calc(100% - 24px));max-height:84vh;border:0;border-radius:8px;padding:0;color:var(--ink);box-shadow:0 22px 60px rgba(20,40,45,.28)}.manual-dialog::backdrop{background:rgba(20,40,45,.48)}.manual-content{padding:20px}.manual-content h2{font-size:1.1rem;color:var(--teal)}.manual-content h3{margin:16px 0 6px;font-size:.95rem;border-bottom:1px solid var(--line);padding-bottom:4px}.manual-content p,.manual-content li{font-size:.82rem;line-height:1.65}.manual-content ol{padding-left:20px}.manual-close{float:right}@media(max-width:540px){.manual-content{padding:17px}}@media print{.app-footer,.manual-dialog{display:none!important}}`;
document.head.append(manualStyle);

const manualDialog = document.createElement('dialog');
manualDialog.className = 'manual-dialog';
manualDialog.innerHTML = `<div class="manual-content">
<button class="btn manual-close" type="button">閉じる</button>
<h2>配送運用デスク 運用マニュアル</h2>
<h3>1. 音声入力と自動解析能力の向上</h3>
<p>「🎤 音声」ボタンを押して「坂戸市千代田1-2 コンテナ大2個 クーラー小ひとつ」のように話しかけてください。「ひとつ」「ふたつ」等の音声特有の数詞や「かける」「ケース」「箱」も自動識別されます。</p>
<h3>2. 店舗拠点発着の最適ルート・AB配分</h3>
<ol>
<li>対象便の配送先を追加します。</li>
<li>「店舗拠点発着 最適ルート・AB配分を施行」を押すと、Google Maps APIより道路距離を取得します。</li>
<li>店舗（拠点）を出発し、すべての配送先を巡回して店舗へ帰還する最短巡回ルート（TSP）を自前計算します。</li>
<li>ドライバーA・B間の往復走破距離および負担が均等になるよう自動配分し、巡回順（①, ②, ③…）に並べ替えます。</li>
</ol>
<h3>3. 一括Google Maps巡回ナビ</h3>
<p>配分後、ドライバー列のヘッダーに表示される「🗺️ 一括巡回ナビ」を押すと、店舗発〜経由地〜店舗帰還までの全ルートがGoogle Mapsに一括読み込みされます。</p>
<h3>4. 担当・状態の調整と端末共有</h3>
<p>カードをドラッグ＆ドロップして手動移動したり、「上へ」「下へ」で順番を微調整できます。設定・実走状態はリアルタイムに端末間で共有されます。</p>
</div>`;
document.body.append(manualDialog);
manualDialog.querySelector('.manual-close').onclick = () => manualDialog.close();

const footer = document.createElement('footer');
footer.className = 'app-footer';
footer.innerHTML = '<button class="btn" type="button">運用マニュアル</button>';
footer.querySelector('button').onclick = () => manualDialog.showModal();
document.querySelector('.shell').append(footer);

const driverTheme = document.createElement('style');
driverTheme.textContent = `
  .column.driver-a .chead { background:#eaf2ff; border-bottom:3px solid #3377e8; } .column.driver-a .cap { color:#2056b7; } .column.driver-a .card { border-left-color:#3377e8; }
  .column.driver-b .chead { background:#fff0ed; border-bottom:3px solid #f05d5e; } .column.driver-b .cap { color:#b94343; } .column.driver-b .card { border-left-color:#f05d5e; }
  .column.driver-c .chead { background:#f2edff; border-bottom:3px solid #7a58c8; } .column.driver-c .cap { color:#6940b6; } .column.driver-c .card { border-left-color:#7a58c8; }
  .column.driver-d .chead { background:#e9f8ef; border-bottom:3px solid #28814b; } .column.driver-d .cap { color:#216d40; } .column.driver-d .card { border-left-color:#28814b; }
`;
document.head.append(driverTheme);

const defaults = {
  origin: { name: 'ベイシアなめがわモール店', address: '埼玉県比企郡滑川町羽尾2780' },
  drivers: [{ id: 'a', name: 'ドライバー A', limit: 350 }, { id: 'b', name: 'ドライバー B', limit: 350 }],
  master: [
    { id: 'water', label: '飲料ケース', terms: ['水', '飲料', 'ドリンク', 'お茶', 'ケース'], pt: 2, weight: 13 },
    { id: 'cl', label: 'クーラー大', terms: ['クーラー大', '保冷大'], pt: 1.5, weight: 9 },
    { id: 'cs', label: 'クーラー小', terms: ['クーラー小', '保冷小'], pt: .8, weight: 4.5 },
    { id: 'xl', label: 'コンテナ大', terms: ['コンテナ大', '箱大'], pt: 1, weight: 6.5 },
    { id: 'xs', label: 'コンテナ小', terms: ['コンテナ小', '箱小', 'コンテナ'], pt: .5, weight: 3 }
  ],
  days: {}
};

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
let state;
try { state = { ...clone(defaults), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { state = clone(defaults); }
let workDate = new Date().toISOString().slice(0, 10);
let slot = '10時便';
let draggedId = null;
let remoteRevision = Number(state.revision) || 0;
const sharedMode = location.protocol === 'http:' || location.protocol === 'https:';

function isSharedState(value) { return value && typeof value === 'object' && value.origin && Array.isArray(value.drivers) && Array.isArray(value.master) && value.days && typeof value.days === 'object'; }

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  if (sharedMode) void saveSharedState();
}

async function saveSharedState() {
  try {
    const response = await fetch(SHARED_STATE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!response.ok) throw new Error();
    const saved = await response.json();
    remoteRevision = Number(saved.revision) || remoteRevision;
    state.revision = remoteRevision;
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    $('message').textContent = '共有サーバーへ接続できません。端末内には保存されています。';
  }
}

async function loadSharedState() {
  if (!sharedMode) return;
  try {
    const response = await fetch(SHARED_STATE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const shared = await response.json();
    const revision = Number(shared.revision) || 0;
    if (isSharedState(shared) && revision > remoteRevision) {
      state = shared;
      remoteRevision = revision;
      localStorage.setItem(KEY, JSON.stringify(state));
      render();
    } else if (revision === 0) {
      await saveSharedState();
    }
  } catch { /* Local state remains usable. */ }
}

function deliveries() {
  state.days[workDate] ??= {};
  state.days[workDate][slot] ??= [];
  return state.days[workDate][slot];
}

function totals(items) {
  return items.reduce((result, item) => ({ pt: result.pt + item.totalPt, weight: result.weight + item.weight }), { pt: 0, weight: 0 });
}

// 改善された音声・テキスト正規化処理
function normalizeSpeechText(rawText) {
  if (!rawText) return '';
  let text = String(rawText).trim();
  
  const kanjiMap = {
    '一つ': '1個', 'ひとつ': '1個', '二つ': '2個', 'ふたつ': '2個', '三つ': '3個', 'みっつ': '3個',
    '四つ': '4個', 'よっつ': '4個', '五つ': '5個', 'いつつ': '5個', '六つ': '6個', 'むっつ': '6個',
    '七つ': '7個', 'ななつ': '7個', '八つ': '8個', 'やつ': '8個', '九つ': '9個', 'ここのつ': '9個',
    '十': '10個', 'とお': '10個', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
    '六': '6', '七': '7', '八': '8', '九': '9'
  };

  text = text.replace(/(?:カケル|かける|×|\*)/gi, 'かける');
  text = text.replace(/([0-9０-９一二三四五六七八九十]+)\s*(?:ケース|箱|個|本|つ)/g, 'かける$1');

  Object.keys(kanjiMap).forEach((key) => {
    text = text.split(key).join(kanjiMap[key]);
  });

  text = text.replace(/(.+?)(?:に|へ|の)\s+([0-9０-９1-9一二三四五六七八九十]|コンテナ|クーラー|ケース|水|保冷)/g, '$1 $2');

  return text;
}

function quantity(value) {
  const match = String(value).match(/(?:(?:[×xX*]|かける)\s*)?([0-9０-９]+|[一二三四五六七八九十]+)(?:個|つ|本|ケース|箱)?$/);
  if (!match) return 1;
  const kanji = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const normalized = match[1].replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  return Number(normalized) || kanji[normalized] || 1;
}

function parseCargoes(text) {
  const normalizedText = normalizeSpeechText(text);
  const cargoText = normalizedText.replace(/[0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:km|ＫＭ|キロ|كيلومتر)/gi, '');
  const compact = cargoText.replace(/[\s、,，。.．/]/g, '');
  const found = [];
  const add = (item, term) => found.push({ masterId: item.id, label: item.label, qty: quantity(term), pt: Number(item.pt), weight: Number(item.weight) });

  state.master.forEach((item) => item.terms.forEach((term) => {
    const matches = compact.match(new RegExp(`${term}${term === 'コンテナ' ? '(?![大小])' : ''}(?:(?:[×xX*]|かける)?(?:[0-9０-９]+|[一二三四五六七八九十]+))?`, 'g')) || [];
    matches.forEach((match) => add(item, match));
  }));

  if (/コンテナ大小|コンテナ小大/.test(compact)) {
    ['コンテナ大', 'コンテナ小'].forEach((label) => {
      const item = state.master.find((entry) => entry.label === label);
      if (item && !found.some((entry) => entry.masterId === item.id)) add(item, label);
    });
  }
  return found;
}

function distanceFrom(raw, fallback = null) {
  const match = raw.match(/([0-9０-９]+(?:[.．][0-9０-９]+)?)\s*(?:km|ＫＭ|キロ|كيلومتر)/i);
  if (!match) return fallback;
  return Number(match[1].replace(/[０-９．]/g, (character) => character === '．' ? '.' : String.fromCharCode(character.charCodeAt(0) - 0xfee0)));
}

function addressFrom(raw) {
  const normalized = normalizeSpeechText(raw);
  const matches = [
    normalized.search(/[、,，。.．/]/),
    normalized.search(/([0-9０-９]+(?:[.．][0-9０-９]+)?)\s*(?:km|ＫＭ|キロ)/i),
    ...state.master.flatMap((item) => item.terms.map((term) => normalized.indexOf(term)))
  ].filter((index) => index >= 0);
  const end = matches.length ? Math.min(...matches) : normalized.length;
  return normalized.slice(0, end).replace(/[、,，。.．/\s]+$/, '').trim();
}

function parseDelivery(raw, previous = {}) {
  const address = addressFrom(raw);
  if (!address) return null;
  const cargoes = parseCargoes(raw);
  const cargoPt = cargoes.reduce((sum, item) => sum + item.pt * item.qty, 0);
  const weight = cargoes.reduce((sum, item) => sum + item.weight * item.qty, 0);
  const distanceKm = distanceFrom(raw, previous.distanceKm ?? null);
  const distancePt = distanceKm ?? 1.5;
  return {
    id: previous.id || crypto.randomUUID(),
    raw,
    name: address,
    address,
    cargoes,
    cargoPt,
    weight,
    distanceKm,
    distancePt,
    totalPt: distancePt + cargoPt,
    driverId: previous.driverId || null,
    status: previous.status || '未配達',
    routeOrder: previous.routeOrder || null
  };
}

function mapsUrl(address) {
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', origin: `${state.origin.name} ${state.origin.address}`, destination: address, travelmode: 'driving' })}`;
}

function multiRouteUrl(assignedItems) {
  if (!assignedItems.length) return '#';
  const originStr = `${state.origin.name} ${state.origin.address}`;
  const waypoints = assignedItems.map(item => item.address).join('|');
  return `https://www.google.com/maps/dir/?${new URLSearchParams({
    api: '1',
    origin: originStr,
    destination: originStr,
    waypoints: waypoints,
    travelmode: 'driving'
  })}`;
}

function roundTripKm(item) {
  return (Number.isFinite(item.distanceKm) && item.distanceKm >= 0 ? item.distanceKm : 1.5) * 2;
}

function routeKm(items) {
  return items.reduce((sum, item) => sum + roundTripKm(item), 0);
}

function solveTSP(matrix, itemIndexes) {
  if (!itemIndexes.length) return { route: [], meters: 0 };
  if (itemIndexes.length === 1) {
    const idx = itemIndexes[0];
    const meters = matrix[0][idx + 1] + matrix[idx + 1][0];
    return { route: [idx], meters };
  }
  let bestRoute = [...itemIndexes];
  let minMeters = Infinity;

  function permute(arr, memo = []) {
    if (arr.length === 0) {
      let meters = matrix[0][memo[0] + 1];
      for (let i = 0; i < memo.length - 1; i++) {
        meters += matrix[memo[i] + 1][memo[i + 1] + 1];
      }
      meters += matrix[memo[memo.length - 1] + 1][0];
      if (meters < minMeters) {
        minMeters = meters;
        bestRoute = [...memo];
      }
    } else {
      for (let i = 0; i < arr.length; i++) {
        const curr = arr.slice();
        const next = curr.splice(i, 1);
        permute(curr, memo.concat(next));
      }
    }
  }

  permute(itemIndexes);
  return { route: bestRoute, meters: minMeters };
}

async function optimizeRoutes() {
  const items = deliveries();
  if (state.drivers.length !== 2) {
    $('message').textContent = '実走行距離での再配分は、ドライバーをA・Bの2名に設定して実行してください。';
    return;
  }
  if (items.length < 2 || items.length > MAX_ROUTE_STOPS) {
    $('message').textContent = `実走行距離での再配分は、配送先2件から${MAX_ROUTE_STOPS}件で実行できます。`;
    return;
  }
  const button = $('optimizeRoutes');
  button.disabled = true;
  button.textContent = '店舗発着の道路距離を取得中…';

  try {
    const response = await fetch(ROUTE_MATRIX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: `${state.origin.name} ${state.origin.address}`,
        destinations: items.map((item) => item.address)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '道路距離を取得できませんでした。');

    const allMasks = (1 << items.length) - 1;
    let bestPlan = null;
    let minScore = Infinity;

    const limitA = state.drivers[0].limit || 350;
    const limitB = state.drivers[1].limit || 350;

    for (let mask = 1; mask < allMasks; mask += 1) {
      const idxsA = items.map((_, i) => i).filter((i) => mask & (1 << i));
      const idxsB = items.map((_, i) => i).filter((i) => !(mask & (1 << i)));

      const weightA = idxsA.reduce((sum, i) => sum + items[i].weight, 0);
      const weightB = idxsB.reduce((sum, i) => sum + items[i].weight, 0);

      const tspA = solveTSP(result.matrix, idxsA);
      const tspB = solveTSP(result.matrix, idxsB);

      const diffMeters = Math.abs(tspA.meters - tspB.meters);
      const totalMeters = tspA.meters + tspB.meters;
      const countDiff = Math.abs(idxsA.length - idxsB.length);

      let penalty = 0;
      if (weightA > limitA) penalty += (weightA - limitA) * 10000;
      if (weightB > limitB) penalty += (weightB - limitB) * 10000;

      const score = totalMeters + diffMeters * 1.5 + countDiff * 500 + penalty;

      if (score < minScore) {
        minScore = score;
        bestPlan = { mask, tspA, tspB, diffMeters, countDiff };
      }
    }

    if (!bestPlan) throw new Error('最適配分計算に失敗しました。');

    const driverA_Id = state.drivers[0].id;
    const driverB_Id = state.drivers[1].id;

    const orderedItems = [];

    bestPlan.tspA.route.forEach((itemIdx, seq) => {
      const item = items[itemIdx];
      item.driverId = driverA_Id;
      item.routeOrder = seq + 1;
      orderedItems.push(item);
    });

    bestPlan.tspB.route.forEach((itemIdx, seq) => {
      const item = items[itemIdx];
      item.driverId = driverB_Id;
      item.routeOrder = seq + 1;
      orderedItems.push(item);
    });

    const currentList = deliveries();
    currentList.length = 0;
    currentList.push(...orderedItems);

    save();
    render();
    $('message').textContent = `店舗起点で最適巡回ルート・AB配分を完了しました！ (A: ${(bestPlan.tspA.meters / 1000).toFixed(1)} km / B: ${(bestPlan.tspB.meters / 1000).toFixed(1)} km)`;
  } catch (error) {
    $('message').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '店舗拠点発着 最適ルート・AB配分を施行';
  }
}

function move(item, direction) {
  const items = deliveries();
  const from = items.indexOf(item), to = from + direction;
  if (to < 0 || to >= items.length) return;
  [items[from], items[to]] = [items[to], items[from]];
  save();
  render();
}

function card(item) {
  const element = document.createElement('article');
  element.className = 'card';
  element.draggable = true;
  element.innerHTML = `<div class="top"><div>${item.routeOrder ? `<span class="seq-badge">巡回 ${item.routeOrder}</span>` : ''}<strong></strong></div><button class="mini danger delete">削除</button></div><div class="cargo"></div><div class="meta"></div><div class="actions"><a class="mini map" target="_blank" rel="noopener noreferrer">地図</a><button class="mini address-edit">住所編集</button><input class="distance-input" type="number" min="0" step="0.1" aria-label="走行距離 km" placeholder="距離 km"><button class="mini edit">編集・再解析</button><button class="mini up">上へ</button><button class="mini down">下へ</button><select class="smallselect"><option>未配達</option><option>配達完了</option><option>不在</option><option>持ち戻り</option></select></div>`;
  element.querySelector('strong').textContent = item.name;
  element.querySelector('.cargo').textContent = item.cargoes.length ? `荷物: ${item.cargoes.map((cargo) => `${cargo.label} ${cargo.qty}個`).join(' / ')}` : '荷物: 未入力';
  element.querySelector('.meta').textContent = `距離 ${item.distanceKm === null || item.distanceKm === undefined ? '概算' : `${item.distanceKm.toFixed(1)} km`} ${item.distancePt.toFixed(1)} pt + 荷物 ${item.cargoPt.toFixed(1)} pt / ${item.weight.toFixed(1)} kg`;
  element.querySelector('.map').href = mapsUrl(item.address);
  element.querySelector('.address-edit').onclick = () => {
    const address = prompt('Google Maps で確認した配送先住所を入力してください。', item.address);
    if (address?.trim()) {
      item.address = address.trim();
      item.name = item.address;
      save();
      render();
    }
  };
  const distanceInput = element.querySelector('.distance-input');
  distanceInput.value = item.distanceKm ?? '';
  distanceInput.onchange = () => {
    const value = Number(distanceInput.value);
    item.distanceKm = Number.isFinite(value) && value >= 0 ? value : null;
    item.distancePt = item.distanceKm ?? 1.5;
    item.totalPt = item.distancePt + item.cargoPt;
    save();
    render();
  };
  const select = element.querySelector('select');
  select.value = item.status;
  select.onchange = () => {
    item.status = select.value;
    save();
    render();
  };
  element.querySelector('.delete').onclick = () => {
    const items = deliveries();
    items.splice(items.indexOf(item), 1);
    save();
    render();
  };
  element.querySelector('.edit').onclick = () => {
    const raw = prompt('住所と荷物を修正してください。', item.raw);
    const updated = raw !== null && parseDelivery(raw, item);
    if (updated) {
      Object.assign(item, updated);
      save();
      render();
    }
  };
  element.querySelector('.up').onclick = () => move(item, -1);
  element.querySelector('.down').onclick = () => move(item, 1);
  element.ondragstart = () => { draggedId = item.id; };
  return element;
}

function render() {
  const items = deliveries(), total = totals(items);
  $('date').value = workDate;
  $('slot').value = slot;
  $('origin').textContent = `店舗拠点: ${state.origin.name}`;
  $('originAddress').textContent = state.origin.address;
  $('count').textContent = items.length;
  $('points').textContent = `${total.pt.toFixed(1)} pt`;
  $('weight').textContent = `${total.weight.toFixed(1)} kg`;
  $('attention').textContent = items.filter((item) => !item.driverId || ['不在', '持ち戻り'].includes(item.status)).length;
  
  const dispatch = $('dispatch');
  dispatch.style.setProperty('--drivers', state.drivers.length);
  dispatch.replaceChildren();

  [{ id: null, name: '未配車' }, ...state.drivers].forEach((driver, index) => {
    const assigned = items.filter((item) => item.driverId === driver.id);
    const total = totals(assigned);
    const route = routeKm(assigned);
    const over = driver.limit && total.weight > driver.limit;
    
    const column = document.createElement('section');
    column.className = `column ${driver.id ? `driver-${String.fromCharCode(97 + index - 1)}` : ''}`;
    
    const navUrl = driver.id ? multiRouteUrl(assigned) : '#';
    const navBtnHtml = (driver.id && assigned.length > 0) ? `<a class="mini nav-btn" href="${navUrl}" target="_blank" rel="noopener noreferrer">🗺️ 一括巡回ナビ</a>` : '';

    column.innerHTML = `<div class="chead">
      <div class="chead-title"><h2></h2>${navBtnHtml}</div>
      <div class="chead-sub"><span class="cap"></span></div>
    </div><div class="zone"></div>`;
    
    column.querySelector('h2').textContent = driver.name;
    const cap = column.querySelector('.cap');
    cap.textContent = driver.id ? `往復 ${route.toFixed(1)} km / ${total.weight.toFixed(1)} kg${over ? ' 上限超過' : ''}` : `${assigned.length} 件`;
    if (over) cap.classList.add('over');
    
    const zone = column.querySelector('.zone');
    zone.ondragover = (event) => { event.preventDefault(); zone.classList.add('hover'); };
    zone.ondragleave = () => zone.classList.remove('hover');
    zone.ondrop = (event) => {
      event.preventDefault();
      const item = items.find((entry) => entry.id === draggedId);
      if (item) {
        item.driverId = driver.id;
        save();
        render();
      }
    };
    assigned.length ? assigned.forEach((item) => zone.append(card(item))) : zone.innerHTML = `<p class="empty">${driver.id ? 'ここへドラッグ' : '追加した配送先が表示されます'}</p>`;
    dispatch.append(column);
  });
  renderHistory();
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  Object.keys(state.days).sort().reverse().forEach((date) => {
    const count = Object.values(state.days[date]).reduce((sum, items) => sum + items.length, 0);
    const button = document.createElement('button');
    button.textContent = `${date} (${count} 件)`;
    button.onclick = () => { workDate = date; render(); };
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  });
}

function renderSettings() {
  const drivers = $('drivers'), master = $('master');
  drivers.replaceChildren();
  master.replaceChildren();
  state.drivers.forEach((driver) => {
    const row = document.createElement('div');
    row.className = 'row driverrow';
    row.innerHTML = `<input value="${driver.name}"><input type="number" value="${driver.limit}"><button class="mini danger">削除</button>`;
    row.querySelector('button').onclick = () => {
      if (state.drivers.length > 1) {
        state.drivers = state.drivers.filter((entry) => entry !== driver);
        renderSettings();
      }
    };
    drivers.append(row);
  });
  state.master.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<input value="${item.label}" title="品目名"><input value="${item.terms.join(',')}" title="認識語（カンマ区切り）"><input type="number" step=".1" value="${item.pt}" title="ポイント"><input type="number" step=".1" value="${item.weight}" title="重量"><button class="mini danger">削除</button>`;
    row.querySelector('button').onclick = () => {
      state.master = state.master.filter((entry) => entry !== item);
      renderSettings();
    };
    master.append(row);
  });
}

function saveSettings() {
  state.origin.name = $('shopName').value.trim() || defaults.origin.name;
  state.origin.address = $('shopAddress').value.trim() || defaults.origin.address;
  state.drivers = [...$('drivers').children].map((row, index) => ({
    id: state.drivers[index]?.id || crypto.randomUUID(),
    name: row.children[0].value.trim() || `ドライバー ${index + 1}`,
    limit: Number(row.children[1].value) || 350
  }));
  state.master = [...$('master').children].map((row, index) => ({
    ...state.master[index],
    id: state.master[index]?.id || crypto.randomUUID(),
    label: row.children[0].value.trim() || '荷物',
    terms: row.children[1].value.split(',').map((term) => term.trim()).filter(Boolean),
    pt: Number(row.children[2].value) || 0,
    weight: Number(row.children[3].value) || 0
  }));
  save();
  $('settings').hidden = true;
  render();
}

function add() {
  const item = parseDelivery($('input').value.trim());
  if (!item) {
    $('message').textContent = '住所を入力してください。';
    return;
  }
  deliveries().push(item);
  $('input').value = '';
  save();
  render();
  $('message').textContent = '配送先を追加しました。すべて追加後に最適ルート・AB配分を実行してください。';
}

function copyPrevious() {
  const source = Object.keys(state.days).filter((date) => date < workDate).sort().reverse().map((date) => state.days[date][slot]).find((items) => items?.length);
  if (!source) {
    $('message').textContent = '複製できる過去の同一便がありません。';
    return;
  }
  deliveries().push(...clone(source).map((item) => ({ ...item, id: crypto.randomUUID(), driverId: null, status: '未配達' })));
  save();
  render();
}

function csv() {
  const rows = [
    ['日付', '便', '担当', '巡回順', '配送先', '荷物', 'ポイント', '重量kg', '状態'],
    ...deliveries().map((item) => [
      workDate,
      slot,
      state.drivers.find((driver) => driver.id === item.driverId)?.name || '未配車',
      item.routeOrder ? `巡回${item.routeOrder}` : '',
      item.name,
      item.cargoes.map((cargo) => `${cargo.label}${cargo.qty}個`).join(' / '),
      item.totalPt.toFixed(1),
      item.weight.toFixed(1),
      item.status
    ])
  ];
  const blob = new Blob(['\uFEFF' + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `配送_${workDate}_${slot}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function initSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('mic');
  if (!Recognition || !window.isSecureContext) {
    if (micBtn) micBtn.disabled = true;
    return;
  }
  let activeRecognition = null;

  micBtn.onclick = () => {
    if (activeRecognition) {
      activeRecognition.stop();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = false;

    micBtn.classList.add('mic-listening');
    micBtn.textContent = '⏹ 録音中…';
    $('message').textContent = '音声認識中… 住所・荷物をお話しください。';

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      $('input').value = transcript;
      if (event.results[0].isFinal) {
        const normalized = normalizeSpeechText(transcript);
        $('input').value = normalized;
        $('message').textContent = '音声認識が完了しました。確認して「解析して追加」を押すかEnterキーを押してください。';
      }
    };

    recognition.onerror = (event) => {
      $('message').textContent = `音声取得エラー (${event.error || '不明'})。住所を手入力してください。`;
    };

    recognition.onend = () => {
      micBtn.classList.remove('mic-listening');
      micBtn.textContent = '🎤 音声';
      activeRecognition = null;
    };

    activeRecognition = recognition;
    recognition.start();
  };
}

$('input').placeholder = '例: 高坂、ケース2、コンテナ大小、クーラー大2';
$('add').onclick = add;
$('input').onkeydown = (event) => { if (event.key === 'Enter') add(); };
$('date').onchange = (event) => { workDate = event.target.value; render(); };
$('slot').onchange = (event) => { slot = event.target.value; render(); };
$('copy').onclick = copyPrevious;
$('csv').onclick = csv;
$('print').onclick = () => print();
$('optimizeRoutes').onclick = optimizeRoutes;
$('openSettings').onclick = () => {
  $('settings').hidden = false;
  $('shopName').value = state.origin.name;
  $('shopAddress').value = state.origin.address;
  renderSettings();
};
$('closeSettings').onclick = () => { $('settings').hidden = true; };
$('saveSettings').onclick = saveSettings;
$('addDriver').onclick = () => {
  state.drivers.push({ id: crypto.randomUUID(), name: '新しいドライバー', limit: 350 });
  renderSettings();
};
$('addMaster').onclick = () => {
  state.master.push({ id: crypto.randomUUID(), label: '新しい荷物', terms: [], pt: 0, weight: 0 });
  renderSettings();
};

initSpeech();
render();
void loadSharedState();
if (sharedMode) setInterval(loadSharedState, 3000);
