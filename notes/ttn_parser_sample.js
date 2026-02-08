// TTN-1 (BY) -> JSON for 1C "Поступление" (Приход)
// Robust v1.2: fixes parties names extraction, basis cut, item row mapping by table logic.

function safeStr(v) { return (v === null || v === undefined) ? "" : String(v); }
function normalizeSpaces(s) {
  return safeStr(s).replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function looksLikeJsonString(s) {
  const t = safeStr(s).trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}
function clampRaw(text, maxLen) {
  const t = safeStr(text);
  return (t.length <= maxLen) ? t : t.slice(0, maxLen) + `\n...[TRUNCATED ${t.length - maxLen} chars]`;
}

// -------- Vision text extraction ----------
function extractTextFromVisionObject(obj) {
  try {
    const texts = [];
    const results = obj?.results || [];
    for (const r of results) {
      const inner = r?.results || [];
      for (const rr of inner) {
        if (rr?.error?.message) continue;
        const pages = rr?.textDetection?.pages || [];
        for (const p of pages) {
          const blocks = p?.blocks || [];
          for (const b of blocks) {
            const lines = b?.lines || [];
            for (const ln of lines) {
              const words = ln?.words || [];
              const lineText = words.map(w => w?.text).filter(Boolean).join(" ");
              if (lineText) texts.push(lineText);
            }
          }
        }
      }
    }
    return normalizeSpaces(texts.join("\n"));
  } catch { return ""; }
}
function getVisionError(inputJson) {
  try {
    const r0 = inputJson?.results?.[0]?.results?.[0];
    if (r0?.error?.message) return { code: r0.error.code ?? null, message: r0.error.message };
  } catch {}
  return null;
}
function extractPlainText(inputJson) {
  if (inputJson && typeof inputJson === "object") {
    const extracted = extractTextFromVisionObject(inputJson);
    if (extracted) return extracted;
  }
  let t = inputJson?.raw_text ?? inputJson?.text ?? inputJson?.ocr_text ?? "";
  t = safeStr(t);
  if (looksLikeJsonString(t) && t.length > 500) {
    try {
      const obj = JSON.parse(t);
      const extracted = extractTextFromVisionObject(obj);
      if (extracted) return extracted;
    } catch {}
  }
  return normalizeSpaces(t);
}

// -------- Date ----------
function parseRuDateToISO(text) {
  const months = {
    "января":"01","февраля":"02","марта":"03","апреля":"04","мая":"05","июня":"06",
    "июля":"07","августа":"08","сентября":"09","октября":"10","ноября":"11","декабря":"12",
    "январь":"01","февраль":"02","март":"03","апрель":"04","май":"05","июнь":"06",
    "июль":"07","август":"08","сентябрь":"09","октябрь":"10","ноябрь":"11","декабрь":"12"
  };
  const m = safeStr(text).match(/(\d{1,2})\s+([А-Яа-яёЁ]+)\s+(\d{4})/);
  if (!m) return null;
  const dd = String(m[1]).padStart(2, "0");
  const mm = months[m[2].toLowerCase().replace(/\./g,"")] || null;
  if (!mm) return null;
  return `${m[3]}-${mm}-${dd}`;
}

// -------- Header fields ----------
function findTTNNumber(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (/НАКЛАДНАЯ/i.test(lines[i])) {
      const win = [lines[i], lines[i+1] || "", lines[i+2] || ""].join(" ");
      const m7 = win.match(/\b\d{7}\b/); if (m7) return m7[0];
      const m6 = win.match(/\b\d{6}\b/); if (m6) return m6[0];
    }
  }
  const m7 = text.match(/\b\d{7}\b/);
  return m7 ? m7[0] : null;
}
function findAllUNP(text) {
  const re = /(?:\bУНП\b[\s:\-]*)?(\b\d{9}\b)/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return [...new Set(found)];
}
function parseTopHeaderUNPs(text) {
  const head = text.split("\n").slice(0, 25).join(" ");
  const unps = findAllUNP(head);
  if (unps.length >= 3) return { shipper: unps[0], receiver: unps[1], payer: unps[2] };
  const all = findAllUNP(text);
  return { shipper: all[0] || null, receiver: all[1] || null, payer: all[2] || (all[0] || null) };
}

function findVehicle(text) {
  const m = text.match(/Автомобиль\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}
function findTrailer(text) {
  const m = text.match(/Прицеп\s+([^\n]+)/i);
  if (!m) return null;
  const v = m[1].trim();
  if (!v) return null;
  if (/^К путевому листу/i.test(v)) return null;
  return v;
}
function findWaybillNo(text) {
  const m = text.match(/К путевому листу\s*№\s*([0-9A-Za-zА-Яа-я\-\/…]+)/i);
  return m ? m[1].replace(/…/g,"").trim() : null;
}
function findDriver(text) {
  const m = text.match(/Водитель\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}
function findCarOwner(text) {
  const m = text.match(/Владелец автомобиля\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}
function findPayerRaw(text) {
  const m = text.match(/Заказчик автомобильной перевозки\s*\(плательщик\)\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}

// -------- Parties names (FIX) ----------
function isBadPartyValue(v) {
  if (!v) return true;
  const t = v.trim();
  if (!t) return true;
  if (/^(Грузоотправитель|Грузополучатель|Заказчик)/i.test(t)) return true;
  if (t.length < 8) return true;
  return false;
}

function findPartyNameByLabel(text, label) {
  // We look for the "lower" filled section: it often repeats labels and then has full names/addresses.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const labelRe = new RegExp(`^${label}$`, "i");
  const candidate = (s) => {
    const t = safeStr(s).trim();
    if (!t) return null;
    if (new RegExp(label, "i").test(t)) return null;
    if (/^УНП$/i.test(t)) return null;
    if (/^Пункт погрузки|^Пункт разгрузки|^Основание отпуска|^Переадресовка|^I\./i.test(t)) return null;
    if (t.length < 10) return null;
    // want something org-like
    if (/(ООО|ОАО|ЧУП|ИП|Индивидуальный предприниматель|УП|РУП|ЗАО|АО|филиал|г\.)/i.test(t)) return t;
    // or contains quotes/commas (address)
    if (/[",]/.test(t) && /[А-Яа-яЁё]/.test(t)) return t;
    return t;
  };

  // find ALL occurrences of label, prefer the later one
  const idxs = [];
  for (let i = 0; i < lines.length; i++) if (labelRe.test(lines[i])) idxs.push(i);
  if (!idxs.length) return null;

  for (let k = idxs.length - 1; k >= 0; k--) {
    const i = idxs[k];
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const c = candidate(lines[j]);
      if (c) return c;
    }
  }
  return null;
}

function findShipperName(text) {
  return findPartyNameByLabel(text, "Грузоотправитель");
}
function findReceiverName(text) {
  return findPartyNameByLabel(text, "Грузополучатель");
}
function findPayerName(text) {
  // payer line is often on one long line already
  const p = findPayerRaw(text);
  if (p && !isBadPartyValue(p)) return p;
  return findPartyNameByLabel(text, "Заказчик автомобильной перевозки \\(плательщик\\)");
}

// -------- Logistics ----------
function findBasis(text) {
  const m = text.match(/Основание отпуска\s+([\s\S]{0,220})/i);
  if (!m) return null;
  let chunk = m[1];
  // cut by stop words
  chunk = chunk.split(/Пункт погрузки|Пункт разгрузки|Переадресовка|I\.\s*ТОВАРНЫЙ/i)[0];
  chunk = chunk.replace(/\n+/g, " ").trim();
  return chunk || null;
}
function findLoadPoint(text) {
  const m = text.match(/Пункт погрузки\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}
function findUnloadPoint(text) {
  const m = text.match(/Пункт разгрузки\s+([^\n]+)/i);
  return m ? m[1].trim() : null;
}
function findRedirection(text) {
  const m = text.match(/Переадресовка\s+([^\n]+)/i);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v.length < 8) return null;
  if (/I\.\s*ТОВАРНЫЙ/i.test(v)) return null;
  return v;
}
function findCorrections(text) {
  const idx = text.search(/Исправлено верно/i);
  if (idx === -1) return null;
  const tail = text.slice(idx, idx + 220);
  return normalizeSpaces(tail).split("\n").slice(0, 2).join(" ").trim() || "Исправлено верно";
}

// -------- UOM ----------
const UOM_MAP = [
  { re: /\bкг\b/i, norm: "кг", base: "кг", coef: 1 },
  { re: /\bг\b/i,  norm: "г",  base: "кг", coef: 0.001 },
  { re: /\bт\b/i,  norm: "т",  base: "кг", coef: 1000 },
  { re: /\bл\b|\bлитр/i,  norm: "л",  base: "л", coef: 1 },
  { re: /\bмл\b/i, norm: "мл", base: "л", coef: 0.001 },
  { re: /\bшт\b|\bштук/i, norm: "шт", base: "шт", coef: 1 },
  { re: /\bуп\b|\bупак/i, norm: "уп", base: "уп", coef: 1 },
  { re: /\bпач\b/i, norm: "пач", base: "пач", coef: 1 },
  { re: /\bкор\b|\bкороб/i, norm: "кор", base: "кор", coef: 1 },
  { re: /\bм2\b/i, norm: "м2", base: "м2", coef: 1 },
  { re: /\bм3\b/i, norm: "м3", base: "м3", coef: 1 },
  { re: /\bпог\.?\s*м\b/i, norm: "пог.м", base: "пог.м", coef: 1 },
];
function detectUom(s) {
  const line = safeStr(s);
  for (const u of UOM_MAP) {
    if (u.re.test(line)) return { raw: line.match(u.re)[0], norm: u.norm, base: u.base, coef_to_base: u.coef, confidence: 0.9 };
  }
  return { raw: null, norm: null, base: null, coef_to_base: null, confidence: 0.4 };
}
function parseNumberRU(s) {
  let t = safeStr(s).trim();
  if (!t) return null;
  t = t.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

// -------- Items table mapping (FIX) ----------
function parseItemsFromText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const startIdx = lines.findIndex(l => /I\.\s*ТОВАРНЫЙ РАЗДЕЛ/i.test(l) || /^ТОВАРНЫЙ РАЗДЕЛ$/i.test(l));
  if (startIdx === -1) return [];

  let endIdx = lines.findIndex((l, idx) => idx > startIdx && (/^II\./i.test(l) || /ПОГРУЗОЧНО/i.test(l)));
  if (endIdx === -1) endIdx = lines.length;

  const section = lines.slice(startIdx, endIdx);

  const isHeader = (l) => /Наименование товара|Единица|Количество|Цена|Стоимость|Ставка|НДС|Сумма НДС|Стоимость с НДС|Масса/i.test(l);
  const isGarbageName = (name) => {
    const t = safeStr(name).toLowerCase();
    if (!t) return true;
    if (t.includes("товарный раздел")) return true;
    if (t.includes("руб.коп")) return true;
    if (t.includes("чество грузовых")) return true;
    if (t.length < 5) return true;
    return false;
  };

  const grabNums = (str) => {
    const re = /(\d{1,3}(?:[ \u00A0]?\d{3})*(?:[.,]\d+)?)/g;
    const out = [];
    let m;
    while ((m = re.exec(str)) !== null) out.push(m[1]);
    return out;
  };

  const items = [];
  let nameBuf = [];

  for (let i = 0; i < section.length; i++) {
    const l = section[i];
    if (/^итого\b/i.test(l)) break;
    if (isHeader(l)) continue;

    const digitCount = (l.match(/\d/g) || []).length;
    const letterCount = (l.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;

    // likely name line
    if (letterCount >= 6 && digitCount <= 2) {
      nameBuf.push(l);
      continue;
    }

    if (!nameBuf.length) continue;

    const name = nameBuf.join(" ").replace(/\s+/g, " ").trim();
    nameBuf = [];
    if (isGarbageName(name)) continue;

    // collect numeric tokens from current and maybe next line
    let tokens = grabNums(l);
    if (tokens.length < 5 && i + 1 < section.length && !isHeader(section[i+1])) {
      const more = grabNums(section[i+1]);
      if (more.length) { tokens = tokens.concat(more); i++; }
    }
    const nums = tokens.map(parseNumberRU).filter(v => v !== null);

    // VAT rate can appear in text line itself (20%)
    const vatRate = (l.match(/\b(0|10|20)\s*%/i) || "")?.[0] || null;

    // Table logic for typical TTN row:
    // qty, price, cost, vat_amount, total_with_vat, places, mass_kg
    const bigInt = (v) => Number.isFinite(v) && v >= 1 && v <= 100000000 && Math.abs(v - Math.round(v)) < 1e-9;
    const money = (v) => Number.isFinite(v) && v >= 0 && v <= 100000000;

    let qty = null;
    let price = null;
    let cost = null;
    let vatAmount = null;
    let total = null;
    let places = null;
    let massKg = null;

    // qty: first large integer (often > 1)
    qty = nums.find(v => bigInt(v) && v >= 1) ?? null;

    // price: first fractional <= 100000
    price = nums.find(v => money(v) && Math.abs(v - Math.round(v)) > 1e-9 && v <= 100000) ?? null;

    // For cost/vat/total: take the largest three "money-like" values that are not qty and not price (prefer with decimals)
    const candidates = nums.filter(v => money(v) && v !== qty && v !== price);
    const dec = candidates.filter(v => Math.abs(v - Math.round(v)) > 1e-9);
    const pool = (dec.length >= 3) ? dec : candidates;

    // sort descending
    const sorted = [...pool].sort((a,b)=>b-a);

    // total should be max, cost second, vat third usually (total >= cost >= vat)
    if (sorted.length >= 1) total = sorted[0];
    if (sorted.length >= 2) cost = sorted[1];
    if (sorted.length >= 3) vatAmount = sorted[2];

    // places: small integer (1..999) somewhere after big money; pick smallest positive int <= 999 that isn't qty
    const ints = nums.filter(v => bigInt(v) && v > 0 && v <= 999 && v !== qty);
    places = ints.length ? ints[ints.length - 1] : null;

    // massKg: if we see another big integer close to qty and uom like "кг" in row context, choose that.
    // Often mass equals qty for kg, but can differ. Pick the largest bigInt besides qty if exists.
    const bigInts = nums.filter(v => bigInt(v) && v !== qty);
    massKg = bigInts.length ? bigInts[bigInts.length - 1] : null;

    // UOM: detect from name or raw line; if massKg exists and looks like kg, hint kg
    let uom = detectUom(name + " " + l);
    if (uom.confidence < 0.8 && massKg !== null) {
      // many TTN show "Масса груза, кг" => assume kg if nothing else
      uom = { raw: "кг", norm: "кг", base: "кг", coef_to_base: 1, confidence: 0.6 };
    }

    items.push({
      name,
      qty,
      uom,
      vat_rate: vatRate,
      price,
      cost,
      vat_amount: vatAmount,
      amount: total,
      places,
      mass_kg: massKg
    });
  }

  return items;
}

// ===== Main =====
const input = $input.item.json || {};
const visionErr = getVisionError(input);
const rawPlain = extractPlainText(input);

const out = {
  meta: {
    doc_type: "TTN-1",
    country: "BY",
    created_at: new Date().toISOString(),
    source: "n8n",
    mode: "receipt",
    parser_version: "1.2.0",
    status: visionErr ? "ocr_error" : "ok",
    ocr_error: visionErr || null
  },
  doc: { type: "TTN-1", number: null, date: null },
  parties: {
    shipper: { raw: null, unp: null, name: null },
    receiver: { raw: null, unp: null, name: null },
    payer: { raw: null, unp: null, name: null }
  },
  transport: { vehicle: null, trailer: null, waybill_no: null, car_owner: null, driver: null },
  logistics: { basis: null, load_point: null, unload_point: null, redirection: null, corrections_note: null },
  items: [],
  totals: { amount: 0, currency: "BYN", total_mass_kg: 0 },
  raw_text: ""
};

if (visionErr && !rawPlain) {
  out.raw_text = "";
} else {
  out.doc.number = findTTNNumber(rawPlain);
  out.doc.date = parseRuDateToISO(rawPlain.split("\n").slice(0, 50).join("\n"));

  const unpTop = parseTopHeaderUNPs(rawPlain);

  const shipperName = findShipperName(rawPlain);
  const receiverName = findReceiverName(rawPlain);
  const payerName = findPayerName(rawPlain);

  out.parties.shipper = { raw: shipperName || null, unp: unpTop.shipper || null, name: shipperName || null };
  out.parties.receiver = { raw: receiverName || null, unp: unpTop.receiver || null, name: receiverName || null };
  out.parties.payer = { raw: payerName || null, unp: unpTop.payer || (unpTop.shipper || null), name: payerName || null };

  out.transport.vehicle = findVehicle(rawPlain);
  out.transport.trailer = findTrailer(rawPlain);
  out.transport.waybill_no = findWaybillNo(rawPlain);
  out.transport.car_owner = findCarOwner(rawPlain);
  out.transport.driver = findDriver(rawPlain);

  out.logistics.basis = findBasis(rawPlain);
  out.logistics.load_point = findLoadPoint(rawPlain);
  out.logistics.unload_point = findUnloadPoint(rawPlain);
  out.logistics.redirection = findRedirection(rawPlain);
  out.logistics.corrections_note = findCorrections(rawPlain);

  out.items = parseItemsFromText(rawPlain);

  // totals from items: use "amount" (total with VAT) and total mass
  let totalAmount = 0;
  let totalMass = 0;
  for (const it of out.items) {
    if (typeof it.amount === "number") totalAmount += it.amount;
    if (typeof it.mass_kg === "number") totalMass += it.mass_kg;
  }
  out.totals.amount = Number.isFinite(totalAmount) ? Number(totalAmount.toFixed(2)) : 0;
  out.totals.total_mass_kg = Number.isFinite(totalMass) ? Number(totalMass.toFixed(3)) : 0;

  out.raw_text = clampRaw(rawPlain, 2000);
}

const content = JSON.stringify(out, null, 2);

return [{
  json: out,
  binary: {
    data: {
      data: Buffer.from(content, "utf8"),
      mimeType: "application/json",
      fileName: "TTN1_ready.json"
    }
  }
}];
