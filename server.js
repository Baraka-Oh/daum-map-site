require('dotenv').config();
const path = require('path');
const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

// 브라우저에서 지도를 그리는 용도 (도메인 제한 키)
const KAKAO_JS_KEY = process.env.KAKAO_JS_KEY;
// 서버에서 주소 검색(Geocoding) API를 호출하는 용도
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
// 필지 경계/토지특성정보 조회(VWorld)용
const VWORLD_KEY = process.env.VWORLD_KEY;

// VWorld는 기본 axios User-Agent/헤더로 오는 요청을 막는 경우가 있어 브라우저처럼 위장
const vworldClient = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  },
});

async function vworldGet(url, params, retries = 1) {
  try {
    return await vworldClient.get(url, { params });
  } catch (err) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return vworldGet(url, params, retries - 1);
    }
    throw err;
  }
}
const VWORLD_DOMAIN = process.env.VWORLD_DOMAIN || 'localhost:3000';

if (!KAKAO_JS_KEY || !KAKAO_REST_API_KEY) {
  console.warn('[경고] .env 파일에 KAKAO_JS_KEY / KAKAO_REST_API_KEY 가 설정되지 않았습니다.');
}
if (!VWORLD_KEY) {
  console.warn('[경고] .env 파일에 VWORLD_KEY 가 설정되지 않았습니다. 필지/토지정보가 표시되지 않습니다.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 프론트엔드에서 Kakao 지도 JS SDK를 로드할 때 필요한 JavaScript 키 제공
app.get('/api/config', (req, res) => {
  res.json({ appKey: KAKAO_JS_KEY || '' });
});

// 단일 주소 지오코딩
async function geocodeAddress(query) {
  const { data } = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
    params: { query },
    headers: {
      Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`,
    },
  });

  if (!data.documents || data.documents.length === 0) {
    return { query, found: false, message: '검색 결과가 없습니다.' };
  }

  const top = data.documents[0];
  const result = {
    query,
    found: true,
    lat: parseFloat(top.y),
    lng: parseFloat(top.x),
    roadAddress: top.road_address ? top.road_address.address_name : '',
    jibunAddress: top.address ? top.address.address_name : '',
  };

  try {
    const { pnu, parcelPolygon, landInfo } = await getLandInfo(result.jibunAddress || query);
    result.pnu = pnu;
    result.parcelPolygon = parcelPolygon;
    result.landInfo = landInfo;
  } catch (err) {
    result.pnu = null;
    result.parcelPolygon = null;
    result.landInfo = null;
  }

  return result;
}

// 지번주소로 PNU(19자리 필지고유번호) 조회
async function getPnu(jibunAddress) {
  if (!jibunAddress || !VWORLD_KEY) return null;
  try {
    const { data } = await vworldGet('https://api.vworld.kr/req/address', {
      service: 'address',
      request: 'getcoord',
      version: '2.0',
      crs: 'epsg:4326',
      address: jibunAddress,
      refine: true,
      simple: false,
      format: 'json',
      type: 'parcel',
      key: VWORLD_KEY,
    });
    const pnu = data?.response?.refined?.structure?.level4LC;
    if (!pnu || pnu.length !== 19) {
      console.error('[VWorld getPnu] PNU 없음:', JSON.stringify(data));
    }
    return pnu && pnu.length === 19 ? pnu : null;
  } catch (err) {
    console.error('[VWorld getPnu] 요청 실패:', err.response?.data || err.message);
    return null;
  }
}

// 필지 경계(연속지적도) 폴리곤 조회
async function getParcelPolygon(pnu) {
  try {
    const { data } = await vworldGet('https://api.vworld.kr/req/data', {
      service: 'data',
      request: 'GetFeature',
      format: 'json',
      key: VWORLD_KEY,
      domain: VWORLD_DOMAIN,
      data: 'LP_PA_CBND_BUBUN',
      attrFilter: `pnu:=:${pnu}`,
      crs: 'EPSG:4326',
      geometry: true,
    });
    const feature = data?.response?.result?.featureCollection?.features?.[0];
    return feature ? feature.geometry : null;
  } catch (err) {
    console.error('[VWorld getParcelPolygon] 요청 실패:', err.response?.data || err.message);
    return null;
  }
}

// 토지특성정보(이용상황/지형/도로접면/용도지역/개별공시지가 등) 조회
async function getLandCharacteristics(pnu) {
  const thisYear = new Date().getFullYear();
  for (let year = thisYear; year >= thisYear - 3; year -= 1) {
    try {
      const { data } = await vworldGet('https://api.vworld.kr/ned/data/getLandCharacteristics', {
        format: 'json', key: VWORLD_KEY, domain: VWORLD_DOMAIN, pnu, stdrYear: year,
      });
      const field = data?.landCharacteristicss?.field?.[0];
      if (field) return field;
    } catch (err) {
      console.error('[VWorld getLandCharacteristics]', year, '요청 실패:', err.response?.data || err.message);
    }
  }
  return null;
}

// 토지(임야)대장 - 소유구분/지목/면적 조회
async function getLandOwnership(pnu) {
  try {
    const { data } = await vworldGet('https://api.vworld.kr/ned/data/ladfrlList', {
      format: 'json', key: VWORLD_KEY, domain: VWORLD_DOMAIN, pnu,
    });
    return data?.ladfrlVOList?.ladfrlVOList?.[0] || null;
  } catch (err) {
    console.error('[VWorld getLandOwnership] 요청 실패:', err.response?.data || err.message);
    return null;
  }
}

// 토지이용계획(용도지역/지구/구역 목록) 조회
async function getLandUsePlans(pnu) {
  try {
    const { data } = await vworldGet('https://api.vworld.kr/ned/data/getLandUseAttr', {
      format: 'json', key: VWORLD_KEY, domain: VWORLD_DOMAIN, pnu, numOfRows: 50,
    });
    const list = data?.landUses?.field || [];
    return list.map((item) => ({
      name: item.prposAreaDstrcCodeNm,
      relation: item.cnflcAtNm,
    }));
  } catch (err) {
    console.error('[VWorld getLandUsePlans] 요청 실패:', err.response?.data || err.message);
    return [];
  }
}

// 주소 하나에 대한 필지 경계 + 토지 기본정보를 한 번에 조회
async function getLandInfo(jibunAddress) {
  const pnu = await getPnu(jibunAddress);
  if (!pnu) {
    return { pnu: null, parcelPolygon: null, landInfo: null };
  }

  const [polygon, characteristics, ownership, usePlans] = await Promise.all([
    getParcelPolygon(pnu),
    getLandCharacteristics(pnu),
    getLandOwnership(pnu),
    getLandUsePlans(pnu),
  ]);

  const landInfo = characteristics || ownership
    ? {
      area: characteristics?.lndpclAr || ownership?.lndpclAr || null,
      landCategory: characteristics?.lndcgrCodeNm || ownership?.lndcgrCodeNm || null,
      useDistrict: characteristics?.prposArea1Nm || null,
      useStatus: characteristics?.ladUseSittnNm || null,
      ownershipType: ownership?.posesnSeCodeNm || null,
      roadSide: characteristics?.roadSideCodeNm || null,
      terrainHeight: characteristics?.tpgrphHgCodeNm || null,
      terrainShape: characteristics?.tpgrphFrmCodeNm || null,
      officialLandPrice: characteristics?.pblntfPclnd || null,
      landUsePlans: usePlans,
    }
    : null;

  return { pnu, parcelPolygon: polygon, landInfo };
}

app.get('/api/geocode', async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) {
    return res.status(400).json({ found: false, message: 'query 파라미터가 필요합니다.' });
  }
  try {
    const result = await geocodeAddress(query);
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ query, found: false, message: '지오코딩 요청 중 오류가 발생했습니다.' });
  }
});

// 여러 주소 동시 검색
app.post('/api/geocode/batch', async (req, res) => {
  const queries = Array.isArray(req.body.queries) ? req.body.queries : [];
  const trimmed = queries.map((q) => String(q).trim()).filter(Boolean);

  if (trimmed.length === 0) {
    return res.status(400).json({ results: [] });
  }

  const results = await Promise.all(
    trimmed.map(async (query) => {
      try {
        return await geocodeAddress(query);
      } catch (err) {
        console.error(err.response?.data || err.message);
        return { query, found: false, message: '지오코딩 요청 중 오류가 발생했습니다.' };
      }
    })
  );

  res.json({ results });
});

// 엑셀 시트에서 "주소" 헤더가 있는 열을 찾아 그 아래 값들을 전부 추출
function extractAddressesFromSheet(worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  let headerRow = -1;
  let headerCol = -1;
  for (let r = 0; r < rows.length && headerRow === -1; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      if (String(rows[r][c]).trim() === '주소') {
        headerRow = r;
        headerCol = c;
        break;
      }
    }
  }

  // "주소" 헤더를 못 찾으면 첫 번째 열을 그대로 사용
  if (headerRow === -1) {
    headerCol = 0;
    headerRow = -1;
  }

  const addresses = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const value = String(rows[r]?.[headerCol] ?? '').trim();
    if (value) addresses.push(value);
  }
  return addresses;
}

// 엑셀 파일 업로드 -> 파일 안의 모든 주소를 일괄 검색
app.post('/api/geocode/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ results: [], message: '업로드된 파일이 없습니다.' });
  }

  let addresses;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    addresses = extractAddressesFromSheet(firstSheet);
  } catch (err) {
    return res.status(400).json({ results: [], message: '엑셀 파일을 읽는 중 오류가 발생했습니다.' });
  }

  if (addresses.length === 0) {
    return res.status(400).json({ results: [], message: '파일에서 주소를 찾지 못했습니다.' });
  }

  const results = await Promise.all(
    addresses.map(async (query) => {
      try {
        return await geocodeAddress(query);
      } catch (err) {
        console.error(err.response?.data || err.message);
        return { query, found: false, message: '지오코딩 요청 중 오류가 발생했습니다.' };
      }
    })
  );

  res.json({ results });
});

// 지번주소에서 "동/리 + 지번"만 짧게 추출 (예: "서울 중구 태평로1가 31" -> "태평로1가 31")
function shortenAddress(item) {
  const addr = item.jibunAddress || item.query || '';
  const tokens = addr.trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 2 ? tokens.slice(-2).join(' ') : addr;
}

// 통합창(검색 결과 요약)을 엑셀 파일로 다운로드
app.post('/api/summary/xlsx', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) {
    return res.status(400).json({ message: '내려받을 데이터가 없습니다.' });
  }

  const rows = [['주소', '용도지역', '면적(㎡)', '개별공시지가(원/㎡)']];
  let totalArea = 0;

  items.forEach((item) => {
    const info = item.landInfo || {};
    const area = Number(info.area) || 0;
    totalArea += area;
    rows.push([
      shortenAddress(item),
      info.useDistrict || '',
      area || '',
      Number(info.officialLandPrice) || '',
    ]);
  });

  rows.push(['합계', '', totalArea || '', '']);

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 18 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '통합창');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = encodeURIComponent(`주소검색_통합창_${Date.now()}.xlsx`);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(buffer);
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
