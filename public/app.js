let map;
let markers = [];
let infoWindow;
let parcelOverlays = [];

function loadKakaoMapScript(appKey) {
  return new Promise((resolve, reject) => {
    if (!appKey) {
      reject(new Error('Kakao JavaScript 키가 설정되지 않았습니다. 서버의 .env 파일을 확인하세요.'));
      return;
    }
    const script = document.createElement('script');
    script.src = `//dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false`;
    script.onload = () => kakao.maps.load(resolve);
    script.onerror = () => reject(new Error('Kakao 지도 스크립트를 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
}

function initMap() {
  const container = document.getElementById('map');
  const options = {
    center: new kakao.maps.LatLng(37.5665, 126.978), // 서울 시청
    level: 7,
  };
  map = new kakao.maps.Map(container, options);
  infoWindow = new kakao.maps.InfoWindow({ removable: true });
}

function clearMarkers() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
}

function clearParcels() {
  parcelOverlays.forEach((p) => p.setMap(null));
  parcelOverlays = [];
}

// GeoJSON 지오메트리(Polygon/MultiPolygon)에서 외곽선 좌표 배열만 추출 ([lng, lat][] 형태, 구멍은 무시)
function extractOuterRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates[0]];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((poly) => poly[0]);
  }
  return [];
}

function addParcelPolygon(item) {
  const rings = extractOuterRings(item.parcelPolygon);
  rings.forEach((ring) => {
    const path = ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
    const polygon = new kakao.maps.Polygon({
      map,
      path,
      strokeWeight: 2,
      strokeColor: '#3478f6',
      strokeOpacity: 0.9,
      fillColor: '#3478f6',
      fillOpacity: 0.35,
    });
    parcelOverlays.push(polygon);
  });
}

function addMarker(item) {
  const position = new kakao.maps.LatLng(item.lat, item.lng);
  const marker = new kakao.maps.Marker({ position, map });

  const content = `
    <div style="padding:8px; font-size:13px; max-width:220px;">
      <strong>${item.query}</strong><br/>
      ${item.roadAddress ? `도로명: ${item.roadAddress}<br/>` : ''}
      ${item.jibunAddress ? `지번: ${item.jibunAddress}` : ''}
    </div>`;

  kakao.maps.event.addListener(marker, 'click', () => {
    infoWindow.setContent(content);
    infoWindow.open(map, marker);
  });

  markers.push(marker);
  return marker;
}

function renderLandInfo(info) {
  if (!info) {
    return '<div class="land-info empty">토지 정보를 찾을 수 없습니다.</div>';
  }

  const rows = [
    ['면적', info.area ? `${Number(info.area).toLocaleString()} ㎡` : '-'],
    ['지목', info.landCategory || '-'],
    ['용도지역', info.useDistrict || '-'],
    ['이용상황', info.useStatus || '-'],
    ['소유구분', info.ownershipType || '-'],
    ['도로접면', info.roadSide || '-'],
    ['지형고저', info.terrainHeight || '-'],
    ['지형형상', info.terrainShape || '-'],
    ['개별공시지가', info.officialLandPrice ? `${Number(info.officialLandPrice).toLocaleString()} 원/㎡` : '-'],
  ];

  const rowsHtml = rows
    .map(([label, value]) => `
      <div class="land-row">
        <span class="label">${label}</span>
        <span class="value">${value}</span>
      </div>`)
    .join('');

  const plansHtml = info.landUsePlans && info.landUsePlans.length
    ? `<div class="land-plans">${info.landUsePlans
      .map((p) => {
        const cls = p.relation === '포함' ? 'in' : p.relation === '저촉' ? 'touch' : 'near';
        return `<span class="plan-chip ${cls}">${p.name}</span>`;
      })
      .join('')}</div>`
    : '';

  return `<div class="land-info"><div class="land-grid">${rowsHtml}</div>${plansHtml}</div>`;
}

function renderResults(results) {
  const list = document.getElementById('result-list');
  list.innerHTML = '';

  results.forEach((item) => {
    const li = document.createElement('li');
    li.className = `result-item ${item.found ? 'ok' : 'fail'}`;

    if (item.found) {
      li.innerHTML = `
        <div class="query">${item.query}</div>
        <div class="addr">
          ${item.roadAddress ? `도로명: ${item.roadAddress}<br/>` : ''}
          ${item.jibunAddress ? `지번: ${item.jibunAddress}` : ''}
        </div>
        ${renderLandInfo(item.landInfo)}`;
    } else {
      li.innerHTML = `
        <div class="query">${item.query}</div>
        <div class="addr">${item.message || '검색 결과 없음'}</div>`;
    }
    list.appendChild(li);
  });
}

let lastFoundResults = [];

// 지번주소에서 "동/리 + 지번"만 짧게 추출 (예: "서울 중구 태평로1가 31" -> "태평로1가 31")
function shortenAddress(item) {
  const addr = item.jibunAddress || item.query;
  const tokens = addr.trim().split(/\s+/);
  return tokens.length >= 2 ? tokens.slice(-2).join(' ') : addr;
}

function buildSummaryTable(found) {
  const tbody = document.getElementById('summary-tbody');
  tbody.innerHTML = '';

  let totalArea = 0;
  found.forEach((item) => {
    const info = item.landInfo || {};
    const area = Number(info.area) || 0;
    totalArea += area;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${shortenAddress(item)}</td>
      <td>${info.useDistrict || '-'}</td>
      <td>${area ? area.toLocaleString() : '-'}</td>
      <td>${info.officialLandPrice ? Number(info.officialLandPrice).toLocaleString() : '-'}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('summary-total-area').textContent = totalArea ? totalArea.toLocaleString() : '-';
}

function openSummaryModal() {
  document.getElementById('summary-modal').classList.remove('hidden');
}

function closeSummaryModal() {
  document.getElementById('summary-modal').classList.add('hidden');
}

async function downloadSummaryXlsx() {
  if (lastFoundResults.length === 0) {
    alert('다운로드할 검색 결과가 없습니다.');
    return;
  }

  const downloadBtn = document.getElementById('download-summary-btn');
  downloadBtn.disabled = true;
  downloadBtn.textContent = '다운로드 중...';

  try {
    const res = await fetch('/api/summary/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lastFoundResults }),
    });
    if (!res.ok) {
      throw new Error('다운로드 요청이 실패했습니다.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `주소검색_통합창_${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('엑셀 다운로드 중 오류가 발생했습니다.');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = '⬇ 엑셀 다운로드';
  }
}

function applySearchResults(results) {
  clearMarkers();
  clearParcels();
  renderResults(results);

  const found = results.filter((r) => r.found);
  lastFoundResults = found;

  const summaryBtn = document.getElementById('open-summary-btn');
  if (found.length >= 2) {
    buildSummaryTable(found);
    summaryBtn.hidden = false;
    openSummaryModal();
  } else {
    summaryBtn.hidden = true;
    closeSummaryModal();
  }

  if (found.length === 0) {
    alert('검색된 주소가 없습니다. 입력값을 확인해주세요.');
    return;
  }

  const bounds = new kakao.maps.LatLngBounds();
  found.forEach((item) => {
    addMarker(item);
    addParcelPolygon(item);
    bounds.extend(new kakao.maps.LatLng(item.lat, item.lng));
  });

  if (found.length === 1) {
    map.setCenter(new kakao.maps.LatLng(found[0].lat, found[0].lng));
    map.setLevel(3);
  } else {
    map.setBounds(bounds);
  }
}

// 주소 입력창들을 결과의 검색어(query)로 다시 채운다 (업로드 결과 반영용)
function fillAddressInputs(queries) {
  const list = document.getElementById('address-list');
  list.innerHTML = '';
  queries.forEach((q) => {
    const row = document.createElement('div');
    row.className = 'address-row';
    row.innerHTML = `
      <input type="text" class="address-input" placeholder="주소 또는 지번을 입력하세요" />
      <button type="button" class="remove-btn" title="삭제">✕</button>
    `;
    row.querySelector('.address-input').value = q;
    list.appendChild(row);
  });
}

async function searchAddresses() {
  const inputs = Array.from(document.querySelectorAll('.address-input'));
  const queries = inputs.map((i) => i.value.trim()).filter(Boolean);

  if (queries.length === 0) {
    alert('검색할 주소를 하나 이상 입력하세요.');
    return;
  }

  const searchBtn = document.getElementById('search-btn');
  searchBtn.disabled = true;
  searchBtn.textContent = '검색 중...';

  try {
    const res = await fetch('/api/geocode/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
    });
    const data = await res.json();
    applySearchResults(data.results || []);
  } catch (err) {
    console.error(err);
    alert('검색 중 오류가 발생했습니다.');
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '검색';
  }
}

async function uploadAddressFile(file) {
  const uploadBtn = document.getElementById('upload-btn');
  uploadBtn.disabled = true;
  uploadBtn.textContent = '업로드 중...';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/geocode/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.message || '엑셀 파일을 처리하지 못했습니다.');
      return;
    }

    const results = data.results || [];
    fillAddressInputs(results.map((r) => r.query));
    applySearchResults(results);
  } catch (err) {
    console.error(err);
    alert('엑셀 업로드 중 오류가 발생했습니다.');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = '📁 엑셀 업로드';
  }
}

function addAddressRow() {
  const list = document.getElementById('address-list');
  const row = document.createElement('div');
  row.className = 'address-row';
  row.innerHTML = `
    <input type="text" class="address-input" placeholder="주소 또는 지번을 입력하세요" />
    <button type="button" class="remove-btn" title="삭제">✕</button>
  `;
  list.appendChild(row);
  row.querySelector('.address-input').focus();
}

function setupUI() {
  document.getElementById('add-row-btn').addEventListener('click', addAddressRow);
  document.getElementById('search-btn').addEventListener('click', searchAddresses);

  document.getElementById('address-list').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-btn')) {
      const rows = document.querySelectorAll('.address-row');
      if (rows.length > 1) {
        e.target.closest('.address-row').remove();
      } else {
        e.target.closest('.address-row').querySelector('.address-input').value = '';
      }
    }
  });

  document.getElementById('address-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('address-input')) {
      e.preventDefault();
      searchAddresses();
    }
  });

  document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('upload-input').click();
  });

  document.getElementById('upload-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      uploadAddressFile(file);
    }
    e.target.value = '';
  });

  document.getElementById('open-summary-btn').addEventListener('click', () => {
    if (lastFoundResults.length >= 2) {
      buildSummaryTable(lastFoundResults);
      openSummaryModal();
    }
  });

  document.getElementById('close-summary-btn').addEventListener('click', closeSummaryModal);
  document.getElementById('download-summary-btn').addEventListener('click', downloadSummaryXlsx);

  document.getElementById('summary-modal').addEventListener('click', (e) => {
    if (e.target.id === 'summary-modal') {
      closeSummaryModal();
    }
  });
}

async function bootstrap() {
  setupUI();
  try {
    const res = await fetch('/api/config');
    const { appKey } = await res.json();
    await loadKakaoMapScript(appKey);
    initMap();
  } catch (err) {
    console.error(err);
    document.getElementById('map').innerHTML = `
      <div style="padding:24px; color:#a00;">
        ${err.message}
      </div>`;
  }
}

bootstrap();
