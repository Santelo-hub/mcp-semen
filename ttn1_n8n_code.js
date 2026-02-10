// n8n Code node: TTN-1 (Belarus) parser for Yandex Vision OCR (model=table)

const monthMap = {
  'января': '01',
  'февраля': '02',
  'марта': '03',
  'апреля': '04',
  'мая': '05',
  'июня': '06',
  'июля': '07',
  'августа': '08',
  'сентября': '09',
  'октября': '10',
  'ноября': '11',
  'декабря': '12',
};

const headerExclusionDateWords = [
  'постанов',
  'министерств',
  'форма установлена',
  'республики беларусь',
  '№ 58',
  'no 58',
  'n 58',
  '30.06.2016',
];

function normText(v) {
  return String(v ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normLower(v) {
  return normText(v).toLowerCase();
}


function cyrLikeLower(v) {
  const map = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У', I: 'И' };
  const src = normText(v).toUpperCase();
  let out = '';
  for (const ch of src) out += map[ch] || ch;
  return out.toLowerCase();
}

function toCyrSeries(v) {
  const t = normText(v).toUpperCase().replace(/[^A-ZА-ЯЁ]/g, '');
  const map = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У', I: 'И' };
  return t
    .split('')
    .map((ch) => map[ch] || ch)
    .join('');
}

function parseNum(v) {
  if (v === null || v === undefined) return null;
  const s = normText(v)
    .replace(/\s+/g, '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function linesFromTextAnnotation(textAnnotation) {
  const out = [];

  function push(x) {
    const t = normText(x);
    if (t) out.push(t);
  }

  // Common simple text field
  if (textAnnotation?.text) {
    for (const l of String(textAnnotation.text).split(/\r?\n/)) push(l);
  }

  // Yandex-like recursive walk for lines/words/text
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }

    if (typeof node.text === 'string') push(node.text);
    if (typeof node.value === 'string') push(node.value);

    if (Array.isArray(node.words) && node.words.length) {
      const w = node.words.map((x) => normText(x?.text || x?.value || '')).filter(Boolean).join(' ');
      push(w);
    }

    for (const k of Object.keys(node)) {
      if (k === 'text' || k === 'value' || k === 'words') continue;
      walk(node[k]);
    }
  }

  walk(textAnnotation?.pages || textAnnotation?.blocks || textAnnotation?.entities || []);

  return out.filter((l) => normText(l));
}


function getCellText(cell) {
  if (!cell) return '';
  const parts = [];
  if (typeof cell.text === 'string') parts.push(cell.text);
  if (typeof cell.value === 'string') parts.push(cell.value);
  if (Array.isArray(cell.lines)) {
    for (const l of cell.lines) {
      if (typeof l?.text === 'string') parts.push(l.text);
      else if (typeof l?.value === 'string') parts.push(l.value);
    }
  }
  if (Array.isArray(cell.words) && cell.words.length) {
    parts.push(cell.words.map((w) => w?.text || w?.value || '').join(' '));
  }
  return normText(parts.join(' '));
}

function tableToMatrix(tbl) {
  const cells = Array.isArray(tbl?.cells) ? tbl.cells : [];
  let maxR = -1;
  let maxC = -1;
  for (const c of cells) {
    const r = Number(c?.rowIndex);
    const col = Number(c?.columnIndex);
    if (Number.isFinite(r) && Number.isFinite(col)) {
      if (r > maxR) maxR = r;
      if (col > maxC) maxC = col;
    }
  }
  if (maxR < 0 || maxC < 0) return [];

  const matrix = Array.from({ length: maxR + 1 }, () => Array.from({ length: maxC + 1 }, () => ''));
  for (const c of cells) {
    const r = Number(c?.rowIndex);
    const col = Number(c?.columnIndex);
    if (!Number.isFinite(r) || !Number.isFinite(col)) continue;
    const t = getCellText(c);
    if (!t) continue;
    matrix[r][col] = matrix[r][col] ? normText(`${matrix[r][col]} ${t}`) : t;
  }
  return matrix;
}

function detectGoodsTable(tables) {
  const targets = [
    'наименование товара',
    'единица измерения',
    'количество',
    'цена',
    'стоимость',
    'ндс',
    'стоимость с ндс',
  ];

  let best = null;
  for (const tbl of tables) {
    const m = tableToMatrix(tbl);
    if (!m.length) continue;
    const headText = normLower(m.slice(0, Math.min(6, m.length)).map((r) => r.join(' | ')).join(' '));
    let score = 0;
    for (const t of targets) if (headText.includes(t)) score += 1;
    // penalize UNP header table
    if (headText.includes('унп') && headText.length < 300) score -= 2;

    if (!best || score > best.score) best = { score, tbl, matrix: m };
  }

  return best && best.score >= 3 ? best : null;
}

function detectColumnMap(headerRows) {
  const colMap = {
    name: -1,
    unit: -1,
    qty: -1,
    price: -1,
    sum: -1,
    vat_rate: -1,
    vat_sum: -1,
    sum_with_vat: -1,
    places: -1,
    mass: -1,
  };

  const cols = Math.max(0, ...headerRows.map((r) => r.length));
  for (let c = 0; c < cols; c++) {
    const txt = normLower(headerRows.map((r) => r[c] || '').join(' '));
    if (colMap.name < 0 && txt.includes('наименование')) colMap.name = c;
    if (colMap.unit < 0 && txt.includes('единица')) colMap.unit = c;
    if (colMap.qty < 0 && txt.includes('колич')) colMap.qty = c;
    if (colMap.price < 0 && txt.includes('цена')) colMap.price = c;
    if (colMap.sum < 0 && txt.includes('стоимость') && !txt.includes('с ндс') && !txt.includes('ндс, руб')) colMap.sum = c;
    if (colMap.vat_rate < 0 && txt.includes('ставка') && txt.includes('ндс')) colMap.vat_rate = c;
    if (colMap.vat_sum < 0 && txt.includes('сумма ндс')) colMap.vat_sum = c;
    if (colMap.sum_with_vat < 0 && txt.includes('стоимость с ндс')) colMap.sum_with_vat = c;
    if (colMap.places < 0 && txt.includes('мест')) colMap.places = c;
    if (colMap.mass < 0 && txt.includes('масс')) colMap.mass = c;
  }
  return colMap;
}

function parseGoods(goodsMatrix, warnings) {
  const result = { items: [], totals: { qty: null, mass: null, sum: null, vat_sum: null, sum_with_vat: null, places: null } };
  if (!goodsMatrix?.length) {
    warnings.push('Товарная таблица не найдена.');
    return result;
  }

  // find header row by keyword
  let headerRow = goodsMatrix.findIndex((row) => normLower(row.join(' ')).includes('наименование товара'));
  if (headerRow < 0) headerRow = 0;

  const headerRows = goodsMatrix.slice(headerRow, Math.min(headerRow + 3, goodsMatrix.length));
  const colMap = detectColumnMap(headerRows);

  const hasAnyMap = Object.values(colMap).some((i) => i >= 0);
  if (!hasAnyMap) warnings.push('Колонки товарной таблицы определены неуверенно.');

  let totalRow = null;

  for (let r = headerRow + 1; r < goodsMatrix.length; r++) {
    const row = goodsMatrix[r] || [];
    const rowText = normLower(row.join(' '));
    if (!rowText) continue;

    const firstCell = cyrLikeLower(row[colMap.name >= 0 ? colMap.name : 0] || row[0] || '');
    const rowTextCyr = cyrLikeLower(row.join(' '));
    const isTotal = /^\s*итого/i.test(firstCell)
      || /итого/i.test(rowTextCyr)
      || row.some((c) => /^\s*итого/i.test(cyrLikeLower(c)));

    if (isTotal) {
      totalRow = row;
      continue;
    }

    const name = normText(row[colMap.name >= 0 ? colMap.name : 0] || '');
    if (!name) continue;
    if (/^итого\b/i.test(normLower(name))) continue;

    const item = {
      name,
      unit: normText(row[colMap.unit] || '') || 'UNKNOWN',
      qty: parseNum(row[colMap.qty]),
      price: parseNum(row[colMap.price]),
      sum: parseNum(row[colMap.sum]),
      vat_rate: normText(row[colMap.vat_rate] || '') || null,
      vat_sum: parseNum(row[colMap.vat_sum]),
      sum_with_vat: parseNum(row[colMap.sum_with_vat]),
      places: parseNum(row[colMap.places]),
      mass: parseNum(row[colMap.mass]),
    };

    // ignore obvious enumeration/header junk
    if (/^(\d+|x|х|№)$/i.test(normLower(item.name))) continue;

    result.items.push(item);
  }

  if (totalRow) {
    result.totals.qty = parseNum(totalRow[colMap.qty]);
    result.totals.mass = parseNum(totalRow[colMap.mass]);
    result.totals.sum = parseNum(totalRow[colMap.sum]);
    result.totals.vat_sum = parseNum(totalRow[colMap.vat_sum]);
    result.totals.sum_with_vat = parseNum(totalRow[colMap.sum_with_vat]);
    result.totals.places = parseNum(totalRow[colMap.places]);
  } else {
    warnings.push('Строка ИТОГО не найдена, totals рассчитаны по items.');
    const sumBy = (k) => {
      let has = false;
      const n = result.items.reduce((acc, it) => {
        if (typeof it[k] === 'number' && Number.isFinite(it[k])) {
          has = true;
          return acc + it[k];
        }
        return acc;
      }, 0);
      return has ? Number(n.toFixed(6)) : null;
    };

    result.totals.qty = sumBy('qty');
    result.totals.mass = sumBy('mass');
    result.totals.sum = sumBy('sum');
    result.totals.vat_sum = sumBy('vat_sum');
    result.totals.sum_with_vat = sumBy('sum_with_vat');
    result.totals.places = sumBy('places');
  }

  return result;
}

function extractSeries(lines, tables) {
  const allLines = lines.map(normText).filter(Boolean);

  // a) lines strict pattern
  for (let i = 0; i < allLines.length; i++) {
    const l = allLines[i];
    const lCyr = cyrLikeLower(l);
    let m = lCyr.match(/серия\s*[:№-]?\s*([a-zа-яё]{1,4})/i);
    if (m) return toCyrSeries(m[1]);

    if (/серия/i.test(lCyr)) {
      const tail = lCyr.replace(/.*серия\s*/i, '').trim();
      if (tail) {
        m = tail.match(/^([a-zа-яё]{1,4})/i);
        if (m) return toCyrSeries(m[1]);
      }
      const next = cyrLikeLower(allLines[i + 1] || '');
      m = next.match(/^([a-zа-яё]{1,4})/i);
      if (m) return toCyrSeries(m[1]);
    }

    m = lCyr.match(/серия\s*([a-zа-яё]{1,4})/i) || lCyr.match(/серия([a-zа-яё]{1,4})/i);
    if (m) return toCyrSeries(m[1]);
  }

  // b) fallback in non-goods tables
  for (const tbl of tables) {
    const mtx = tableToMatrix(tbl);
    if (!mtx.length) continue;
    const txt = normText(mtx.flat().join(' '));
    const mm = txt.match(/серия\s*[:№-]?\s*([A-ZА-ЯЁ]{1,4})/i) || txt.match(/серия([A-ZА-ЯЁ]{1,4})/i);
    if (mm) return toCyrSeries(mm[1]);
  }

  return null;
}

function parseDateFromText(t) {
  const s = normLower(t);

  // dd.mm.yyyy
  let m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (m) {
    const dd = String(Number(m[1])).padStart(2, '0');
    const mm = String(Number(m[2])).padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }

  // 24 мая 2018 г.
  m = s.match(/\b(\d{1,2})\s+([а-яё]+)\s+(\d{4})\b/i);
  if (m && monthMap[m[2]]) {
    const dd = String(Number(m[1])).padStart(2, '0');
    return `${m[3]}-${monthMap[m[2]]}-${dd}`;
  }

  return null;
}

function extractHeaderDate(lines) {
  const lns = lines.map(normText).filter(Boolean);
  const titleIdx = lns.findIndex((l) => /накладная/i.test(l));

  const candidateIdx = [];
  if (titleIdx >= 0) {
    for (let i = Math.max(0, titleIdx - 8); i <= Math.min(lns.length - 1, titleIdx + 20); i++) candidateIdx.push(i);
  }
  for (let i = 0; i < lns.length; i++) if (!candidateIdx.includes(i)) candidateIdx.push(i);

  for (const i of candidateIdx) {
    const text = lns[i];
    const low = normLower(text);
    if (headerExclusionDateWords.some((w) => low.includes(w))) continue;

    const d = parseDateFromText(text);
    if (!d) continue;

    // avoid obviously regulatory dates
    if (d === '2016-06-30') continue;
    return d;
  }

  return null;
}

function extractNumber(lines) {
  const lns = lines.map(normText).filter(Boolean);
  const titleIdx = lns.findIndex((l) => /накладная/i.test(l));

  const searchOrder = [];
  if (titleIdx >= 0) {
    for (let i = Math.max(0, titleIdx - 3); i <= Math.min(lns.length - 1, titleIdx + 15); i++) searchOrder.push(i);
  }
  for (let i = 0; i < lns.length; i++) if (!searchOrder.includes(i)) searchOrder.push(i);

  for (const i of searchOrder) {
    const s = lns[i];
    let m = s.match(/(?:№|N|No)?\s*(\d{6,10})\b/i);
    if (m) {
      const n = m[1];
      if (n === '58') continue;
      if (n.startsWith('20') && n.length === 8) continue;
      return n;
    }
  }

  return null;
}

function extractUNPs(lines, tables) {
  const values = [];

  const pushUnps = (txt) => {
    const all = normText(txt).match(/\b\d{9}\b/g) || [];
    for (const x of all) values.push(x);
  };

  // from lines after УНП
  const lns = lines.map(normText).filter(Boolean);
  const unpIdx = lns.findIndex((l) => /унп/i.test(l));
  if (unpIdx >= 0) {
    for (let i = unpIdx; i < Math.min(lns.length, unpIdx + 20); i++) {
      pushUnps(lns[i]);
      if (values.length >= 3) break;
    }
  }

  // fallback from non-goods tables
  if (values.length < 3) {
    for (const t of tables) {
      pushUnps(tableToMatrix(t).flat().join(' '));
      if (values.length >= 3) break;
    }
  }

  return [values[0] || null, values[1] || null, values[2] || null];
}


function valueByPrefix(lines, regex) {
  for (const l of lines) {
    const m = normText(l).match(regex);
    if (m) return normText(m[1]);
  }
  return null;
}

function parseTTN(inputJson) {
  const warnings = [];

  const textAnnotation = inputJson?.result?.textAnnotation || inputJson?.textAnnotation || null;
  if (!textAnnotation) {
    return {
      ttn_series: null,
      ttn_number: null,
      ttn_date: null,
      shipper: { name: null, unp: null },
      consignee: { name: null, unp: null },
      customer: { name: null, unp: null },
      carrier: { name: null, car: null, trailer: null, driver: null, waybill_no: null, car_owner: null },
      route: { loading_point: null, unloading_point: null },
      basis: { basis_text: null },
      items: [],
      totals: { qty: null, mass: null, sum: null, vat_sum: null, sum_with_vat: null, places: null },
      warnings: ['textAnnotation не найден во входных данных.'],
    };
  }

  const lines = linesFromTextAnnotation(textAnnotation);
  const tables = Array.isArray(textAnnotation?.tables) ? textAnnotation.tables : [];

  const goods = detectGoodsTable(tables);
  const nonGoodsTables = goods ? tables.filter((t) => t !== goods.tbl) : tables;

  const ttn_series = extractSeries(lines, nonGoodsTables);
  const ttn_number = extractNumber(lines);
  const ttn_date = extractHeaderDate(lines);

  const [shipperUnp, consigneeUnp, customerUnp] = extractUNPs(lines, nonGoodsTables);

  const shipperName = valueByPrefix(lines, /грузоотправитель\s*[:\-]?\s*(.+)$/i);
  const consigneeName = valueByPrefix(lines, /грузополучатель\s*[:\-]?\s*(.+)$/i);
  const customerName = valueByPrefix(lines, /заказчик\s+автомобильной\s+перевозки(?:\s*\(плательщик\))?\s*[:\-]?\s*(.+)$/i);

  const car = valueByPrefix(lines, /автомобиль\s*[:\-]?\s*(.+)$/i);
  const trailer = valueByPrefix(lines, /прицеп\s*[:\-]?\s*(.+)$/i);
  const driver = valueByPrefix(lines, /водитель\s*[:\-]?\s*(.+)$/i);
  const waybillNo = valueByPrefix(lines, /к\s*путевому\s*листу\s*№?\s*([0-9A-Za-zА-Яа-я\-/]+)/i);

  const loadingPoint = valueByPrefix(lines, /пункт\s+погрузки\s*[:\-]?\s*(.+)$/i);
  const unloadingPoint = valueByPrefix(lines, /пункт\s+разгрузки\s*[:\-]?\s*(.+)$/i);
  const basisText = valueByPrefix(lines, /основание\s+отпуска\s*[:\-]?\s*(.+)$/i);

  const goodsParsed = parseGoods(goods?.matrix || null, warnings);

  if (!ttn_series) warnings.push('Не найдена серия ТТН.');
  if (!ttn_number) warnings.push('Не найден номер ТТН.');
  if (!ttn_date) warnings.push('Не найдена дата ТТН.');

  if (!shipperName) warnings.push('Не найден грузоотправитель (name).');
  if (!consigneeName) warnings.push('Не найден грузополучатель (name).');
  if (!customerName) warnings.push('Не найден заказчик перевозки (name).');

  if (!shipperUnp) warnings.push('Не найден УНП грузоотправителя.');
  if (!consigneeUnp) warnings.push('Не найден УНП грузополучателя.');
  if (!customerUnp) warnings.push('Не найден УНП заказчика.');

  if (!car) warnings.push('Не найден автомобиль.');
  if (!trailer) warnings.push('Не найден прицеп.');
  if (!driver) warnings.push('Не найден водитель.');

  return {
    ttn_series: ttn_series || null,
    ttn_number: ttn_number || null,
    ttn_date: ttn_date || null,

    shipper: { name: shipperName || null, unp: shipperUnp || null },
    consignee: { name: consigneeName || null, unp: consigneeUnp || null },
    customer: { name: customerName || null, unp: customerUnp || null },

    carrier: {
      name: null,
      car: car || null,
      trailer: trailer || null,
      driver: driver || null,
      waybill_no: waybillNo || null,
      car_owner: null,
    },

    route: {
      loading_point: loadingPoint || null,
      unloading_point: unloadingPoint || null,
    },

    basis: {
      basis_text: basisText || null,
    },

    items: goodsParsed.items,
    totals: goodsParsed.totals,
    warnings,
  };
}

const input = $json;
const parsed = parseTTN(input);

const fileName = `ttn1_parsed_${parsed.ttn_number || Date.now()}.json`;
const jsonString = JSON.stringify(parsed, null, 2);
const base64JSON = Buffer.from(jsonString, 'utf8').toString('base64');

return [
  {
    json: parsed,
    binary: {
      data: {
        data: base64JSON,
        mimeType: 'application/json',
        fileName,
      },
    },
  },
];
