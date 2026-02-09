// STRICT TTN-1 parser + binary.data output for n8n

const MONTHS = {
  января: "01", февраля: "02", марта: "03", апреля: "04", мая: "05", июня: "06",
  июля: "07", августа: "08", сентября: "09", октября: "10", ноября: "11", декабря: "12",
};

function safeStr(v) { return v === null || v === undefined ? "" : String(v); }
function normalizeSpaces(text) {
  return safeStr(text).replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractOcrTextFromResults(results) {
  if (!results) return "";
  const parts = [];
  (function walk(x) {
    if (x === null || x === undefined) return;
    if (typeof x === "string") { const s = x.trim(); if (s) parts.push(s); return; }
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === "object") {
      if (typeof x.text === "string") parts.push(x.text.trim());
      if (typeof x.value === "string") parts.push(x.value.trim());
      for (const v of Object.values(x)) walk(v);
    }
  })(results);
  return parts.join(" ").trim();
}

function cleanupYandexOcrText(raw) {
  let t = safeStr(raw);
  t = t.replace(/\bru\b/giu, " ");
  t = t.replace(/\b(\d{1,4}\s+){7,}\d{1,4}\b/g, " ");
  t = t.replace(/\b(\d{1,4}\s+){3}\d{1,4}\b/g, " ");
  t = t.replace(/\s-\s*1\b/g, " ");
  t = t.replace(/[ \t]+/g, " ").trim();
  t = t.replace(/\s+(ТОВАРНО\s*-\s*ТРАНСПОРТН.*?\s+НАКЛАДН.*?)\s+/giu, "\n$1\n");
  t = t.replace(/\s+(Серия|Грузоотправитель|Грузополучатель|Заказчик|Плательщик|Автомобиль|Прицеп|Водитель|ТОВАРНЫЙ\s+РАЗДЕЛ|ИТОГО)\s+/giu, "\n$1 ");
  return normalizeSpaces(t);
}

function parseRuDateToISO_strict(s) {
  const v = safeStr(s);

  const numeric = v.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (numeric) {
    const dd = String(numeric[1]).padStart(2, "0");
    const mm = String(numeric[2]).padStart(2, "0");
    return `${numeric[3]}-${mm}-${dd}`;
  }

  const words = v.match(/\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\b/iu);
  if (!words) return "";
  const dd = String(words[1]).padStart(2, "0");
  const mm = MONTHS[words[2].toLowerCase()] || "";
  if (!mm) return "";
  return `${words[3]}-${mm}-${dd}`;
}

function getHeaderWindowStrict(text) {
  const lines = normalizeSpaces(text).split("\n");
  const idx = lines.findIndex(l => /ТОВАРНО\s*-\s*ТРАНСПОРТН.*НАКЛАДН/iu.test(l));
  if (idx === -1) return { found: false, window: "" };
  const from = Math.max(0, idx - 25);
  const to = Math.min(lines.length, idx + 40);
  return { found: true, window: lines.slice(from, to).join("\n") };
}

function findTtnNumberAndSeries_STRICT(text, warnings) {
  const header = getHeaderWindowStrict(text);
  if (!header.found) {
    warnings.push("Не найден заголовок 'ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ' — номер/серия недоступны.");
    return { series: "", number: "" };
  }

  const mSeries = header.window.match(/(?:^|\n)\s*Серия\s*([A-ZА-Я]{1,3})\b/iu);
  let series = mSeries ? mSeries[1] : "";

  if (!series || /^Сер$/iu.test(series)) {
    warnings.push("Не найдена серия в шапке (ожидаю строку вида: 'Серия AI').");
    series = "";
  }

  const mNum = header.window.match(/№\s*(\d{6,7})\b/u);
  const number = mNum ? mNum[1] : "";
  if (!number) warnings.push("Не найден номер ТТН в шапке (ожидаю '№' и 6–7 цифр рядом с шапкой).");

  return { series, number };
}

function findTtnDate_STRICT(text, warnings) {
  const header = getHeaderWindowStrict(text);
  if (!header.found) {
    warnings.push("Не найден заголовок 'ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ' — дата недоступна.");
    return "";
  }

  const wordDate = header.window.match(/\b\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}\b/iu);
  if (wordDate) return parseRuDateToISO_strict(wordDate[0]);

  const numDates = header.window.match(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g) || [];
  const filtered = numDates.filter(d => d !== "30.06.2016" && d !== "30/06/2016");
  if (filtered.length) return parseRuDateToISO_strict(filtered[0]);

  warnings.push("Не найдена дата ТТН в шапке (ожидаю дату рядом с заголовком ТТН).");
  return "";
}

function extractUnpFromLine(line) {
  const m = line.match(/УНП\s*[:№]?\s*(\d{9})/iu) || line.match(/\b(\d{9})\b/u);
  return m ? m[1] : "";
}

function extractPartyInfo_STRICT(text, labelRegex, warnings, labelName) {
  const lines = normalizeSpaces(text).split("\n").map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    if (!labelRegex.test(lines[i])) continue;

    let unp = extractUnpFromLine(lines[i]);
    let name = "";

    const inline = lines[i].replace(labelRegex, "").replace(/[:\-–—]/g, " ").trim().replace(/УНП.*$/iu, "").trim();
    if (inline && inline !== lines[i] && !labelRegex.test(inline)) name = inline;

    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const cand = lines[j];
      if (!unp) unp = extractUnpFromLine(cand);
      if (!name && cand && !labelRegex.test(cand)) {
        const cleaned = cand.replace(/УНП.*$/iu, "").trim();
        if (cleaned && !labelRegex.test(cleaned)) name = cleaned;
      }
      if (name && unp) break;
    }

    // запрещаем возвращать саму метку как "name"
    if (name && labelRegex.test(name)) name = "";

    return { found: true, name: name || "", unp: unp || "" };
  }

  warnings.push(`Не найден якорь '${labelName}' — поле пустое.`);
  return { found: false, name: "", unp: "" };
}

function parseItems_STRICT(text, warnings) {
  const lines = normalizeSpaces(text).split("\n").map(l => l.trim()).filter(Boolean);
  const startIdx = lines.findIndex(l => /ТОВАРНЫЙ\s+РАЗДЕЛ/iu.test(l));
  if (startIdx === -1) {
    warnings.push("Не найден 'ТОВАРНЫЙ РАЗДЕЛ' — товары не распознаны OCR, items=[].");
    return [];
  }
  // здесь намеренно пусто: только строгий режим, без реконструкции таблицы
  return [];
}

function findCarrierInfo_STRICT(text, warnings) {
  const car = (text.match(/Автомобиль\s+([^\n]+)/iu) || [])[1] || "";
  const trailer = (text.match(/Прицеп\s+([^\n]+)/iu) || [])[1] || "";
  const driver = (text.match(/Водитель\s+([^\n]+)/iu) || [])[1] || "";
  if (!car && !trailer && !driver) {
    warnings.push("Не найдены якоря 'Автомобиль/Прицеп/Водитель' — данные перевозчика пустые.");
  }
  return { name: "", car: car.trim(), trailer: trailer.trim(), driver: driver.trim() };
}

function parseTtn1_STRICT(cleanText) {
  const warnings = [];
  const text = normalizeSpaces(cleanText);

  const { series, number } = findTtnNumberAndSeries_STRICT(text, warnings);
  const date = findTtnDate_STRICT(text, warnings);

  const shipper = extractPartyInfo_STRICT(text, /Грузоотправитель/iu, warnings, "Грузоотправитель");
  const consignee = extractPartyInfo_STRICT(text, /Грузополучатель/iu, warnings, "Грузополучатель");
  const customer = extractPartyInfo_STRICT(text, /Заказчик автомобильной перевозки|Плательщик/iu, warnings, "Заказчик автомобильной перевозки/Плательщик");

  const carrier = findCarrierInfo_STRICT(text, warnings);
  const items = parseItems_STRICT(text, warnings);

  return {
    ttn_number: number,
    ttn_series: series,
    ttn_date: date,
    shipper: { name: shipper.name, unp: shipper.unp },
    consignee: { name: consignee.name, unp: consignee.unp },
    customer: { name: customer.name, unp: customer.unp },
    carrier,
    items,
    totals: { qty: null, mass: null, sum: null },
    warnings,
  };
}

// ---- ENTRY ----
const rawOcr = extractOcrTextFromResults($json.results);
const cleanOcr = cleanupYandexOcrText(rawOcr);

const parsed = parseTtn1_STRICT(cleanOcr);

// binary JSON for Read/Write Files from Disk (expects $binary.data)
const fileName = `TTN1_${parsed.ttn_series || "NA"}_${parsed.ttn_number || "NO_NUMBER"}.json`;
const jsonString = JSON.stringify(parsed, null, 2);
const base64 = Buffer.from(jsonString, "utf8").toString("base64");

return [{
  json: {
    ...parsed,
    _debug_clean_len: cleanOcr.length,
    _debug_clean_preview: cleanOcr.slice(0, 500),
  },
  binary: { data: { data: base64, mimeType: "application/json", fileName } }
}];
