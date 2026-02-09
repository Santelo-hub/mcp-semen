// TTN-1 (BY) parser for n8n (Yandex OCR recognizeText "table")
// INPUT: $json.result.textAnnotation.blocks[].lines[].text
// OUTPUT: parsed JSON + $binary.data (base64) for Read/Write Files from Disk

const MONTHS = {
  января: "01", февраля: "02", марта: "03", апреля: "04", мая: "05", июня: "06",
  июля: "07", августа: "08", сентября: "09", октября: "10", ноября: "11", декабря: "12",
};

function safeStr(v) { return v === null || v === undefined ? "" : String(v); }
function norm(s) { return safeStr(s).replace(/[ \t]+/g, " ").trim(); }

function getLines(root) {
  const blocks = root?.result?.textAnnotation?.blocks || [];
  const lines = [];
  for (const b of blocks) {
    for (const l of (b.lines || [])) {
      if (typeof l.text === "string") {
        const t = l.text.trim();
        if (t) lines.push(t);
      }
    }
  }
  return lines;
}

function parseRuDateToISO_fromLine(line) {
  const v = safeStr(line);

  const numeric = v.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (numeric) {
    const dd = String(numeric[1]).padStart(2, "0");
    const mm = String(numeric[2]).padStart(2, "0");
    return `${numeric[3]}-${mm}-${dd}`;
  }

  const words = v.match(
    /\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\b/iu
  );
  if (!words) return "";
  const dd = String(words[1]).padStart(2, "0");
  const mm = MONTHS[words[2].toLowerCase()] || "";
  if (!mm) return "";
  return `${words[3]}-${mm}-${dd}`;
}

function isPureDigits(s) { return /^\d+$/.test(norm(s)); }
function extractFirst9Digits(s) {
  const m = safeStr(s).match(/\b(\d{9})\b/);
  return m ? m[1] : "";
}

function findHeaderZone(lines) {
  const idx = lines.findIndex(l => /ТОВАРНЫЙ\s+РАЗДЕЛ/iu.test(l));
  const end = idx === -1 ? Math.min(lines.length, 160) : idx;
  return lines.slice(0, end);
}

function findTtnNumber(headerLines, warnings) {
  for (const l of headerLines) {
    const m = l.match(/\b(\d{6,7})\b/);
    if (m) return m[1];
  }
  warnings.push("Не найден номер ТТН (ожидаю 6–7 цифр в шапке).");
  return "";
}

function findTtnSeries(headerLines, warnings) {
  for (const l of headerLines) {
    const m = l.match(/Серия\s*([A-ZА-ЯЁ]{1,4})/iu);
    if (m) {
      const s = m[1].trim();
      if (s && !/^Сер$/iu.test(s)) return s;
    }
  }
  warnings.push("Не найдена серия (ожидаю строку вида: 'Серия АИ').");
  return "";
}

function findTtnDate(headerLines, warnings) {
  for (const l of headerLines) {
    const d = parseRuDateToISO_fromLine(l);
    if (d && d !== "2016-06-30") return d;
  }
  warnings.push("Не найдена дата ТТН в шапке (ожидаю '24 мая 2018' или '24.05.2018').");
  return "";
}

function parseUnpTriple(headerLines) {
  const idx = headerLines.findIndex(l => /^УНП$/iu.test(norm(l)) || /\bУНП\b/iu.test(l));
  if (idx === -1) return { shipper: "", consignee: "", customer: "" };

  const found = [];
  for (let i = idx + 1; i < Math.min(idx + 12, headerLines.length); i++) {
    const v = extractFirst9Digits(headerLines[i]);
    if (v) found.push(v);
    if (found.length >= 3) break;
  }

  return {
    shipper: found[0] || "",
    consignee: found[1] || "",
    customer: found[2] || "",
  };
}

function isMeaningfulName(s) {
  const t = norm(s);
  if (!t) return false;
  if (/^УНП$/iu.test(t)) return false;
  if (/\bСерия\b/iu.test(t)) return false;
  if (/ТОВАРНО\s*-\s*ТРАНСПОРТНАЯ/iu.test(t)) return false;
  if (isPureDigits(t)) return false;
  return true;
}

function afterLabelValue(lines, labelRegex, stopRegex, maxLook = 25) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!labelRegex.test(line)) continue;

    const inline = norm(line.replace(labelRegex, "").replace(/[:\-–—]/g, " "));
    if (inline && !stopRegex.test(inline) && isMeaningfulName(inline)) return inline;

    for (let j = i + 1; j < Math.min(i + 1 + maxLook, lines.length); j++) {
      const t = norm(lines[j]);
      if (!t) continue;
      if (stopRegex.test(t)) break;
      if (!isMeaningfulName(t)) continue;
      return t;
    }
    return "";
  }
  return "";
}

function extractCarrier(lines) {
  function nextNonEmpty(i, max = 8) {
    for (let k = i + 1; k < Math.min(i + 1 + max, lines.length); k++) {
      const t = norm(lines[k]);
      if (!t) continue;
      if (/^\(.*\)$/.test(t)) continue;
      if (/^К путевому листу/iu.test(t)) continue;
      if (/марка/i.test(t) && t.length <= 40) continue;
      return t;
    }
    return "";
  }

  let car = "";
  let trailer = "";
  let driver = "";

  for (let i = 0; i < lines.length; i++) {
    const t = norm(lines[i]);

    if (!car && /^Автомобиль$/iu.test(t)) car = nextNonEmpty(i, 8);

    if (!trailer && /^Прицеп\b/iu.test(t)) {
      const inline = norm(t.replace(/^Прицеп\b/iu, "").replace(/[:\-–—]/g, " "));
      if (inline && !/^\(.*\)$/.test(inline) && !/марка/i.test(inline)) {
        trailer = inline;
      } else {
        trailer = nextNonEmpty(i, 8);
      }
    }

    if (!driver && /^Водитель\b/iu.test(t)) {
      const inline = norm(t.replace(/^Водитель\b/iu, "").replace(/[:\-–—]/g, " "));
      driver = inline || nextNonEmpty(i, 8);
    }
  }

  return { name: "", car, trailer, driver };
}

function parseNumberRU(s) {
  const v = norm(s).replace(/\s/g, "").replace(",", ".").replace(/[ОO]/g, "0");
  if (!v) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Number(v);
}

function extractNumbers(line) {
  const res = [];
  const re = /(\d[\d \u00A0.,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const raw = m[1];
    const val = parseNumberRU(raw);
    if (val !== null) res.push({ raw, val });
  }
  return res;
}

function sliceGoodsZone(lines, warnings) {
  const start = lines.findIndex(l => /ТОВАРНЫЙ\s+РАЗДЕЛ/iu.test(l));
  if (start === -1) {
    warnings.push("Не найден 'ТОВАРНЫЙ РАЗДЕЛ' — товары не распознаны.");
    return [];
  }

  const stopIdx = lines.findIndex((l, idx) =>
    idx > start && (
      /^ИТОГО\b/iu.test(norm(l)) ||
      /^II[\.\s]/iu.test(norm(l)) ||
      /ПОГРУЗОЧНО\s*-\s*РАЗГРУЗОЧН/iu.test(l) ||
      /^III[\.\s]/iu.test(norm(l)) ||
      /ПРОЧИЕ\s+СВЕДЕНИЯ/iu.test(l) ||
      /Отпуск\s+разрешил/iu.test(l) ||
      /Товар\s+к\s+перевозке\s+принял/iu.test(l)
    )
  );

  const end = stopIdx === -1 ? lines.length : stopIdx;
  return lines.slice(start + 1, end);
}

function isHeaderGarbage(line) {
  const t = norm(line).toLowerCase();
  if (!t) return false;
  const headerParts = [
    "наименование", "товара", "единиц", "изме", "рения", "колич", "цена",
    "стоим", "ставк", "ндс", "масса", "грузовых", "мест", "руб", "код",
    "номер", "примеч",
  ];
  if (headerParts.some(p => t.includes(p))) return true;
  if (/^единиц$/iu.test(t)) return true;
  if (/^изме-?$/iu.test(t)) return true;
  if (/^рения$/iu.test(t)) return true;
  if (/^изме-?\s*рения$/iu.test(t)) return true;
  return false;
}

function parseItems(lines, warnings) {
  const section = sliceGoodsZone(lines, warnings);
  if (!section.length) return [];

  const items = [];
  let nameBuf = [];

  for (let i = 0; i < section.length; i++) {
    const l = norm(section[i]);
    if (!l) continue;

    if (isHeaderGarbage(l)) continue;

    const hasDigits = /\d/.test(l);
    const hasLetters = /[А-Яа-яЁёA-Za-z]/.test(l);

    if (!hasDigits && hasLetters) {
      nameBuf.push(l);
      continue;
    }

    if (hasDigits) {
      let nums = extractNumbers(l);
      let namePart = "";
      if (nums.length) {
        const beforeFirst = l.split(nums[0].raw)[0];
        if (/[А-Яа-яЁёA-Za-z]/.test(beforeFirst)) namePart = beforeFirst.trim();
      }

      let j = i;
      while (nums.length < 2 && j + 1 < section.length) {
        const next = norm(section[j + 1]);
        if (!next || isHeaderGarbage(next)) break;
        if (!/\d/.test(next)) break;
        const nextNums = extractNumbers(next);
        if (!nextNums.length) break;
        nums = nums.concat(nextNums);
        j += 1;
      }
      i = j;

      if (nums.length < 2) continue;

      const name = norm(`${nameBuf.join(" ")} ${namePart}`.trim());
      nameBuf = [];

      if (!name) continue;

      const values = nums.map(x => x.val);
      const qty = values[0] ?? 0;
      const price = values[1] ?? 0;
      const sum = values[values.length - 1] ?? 0;

      if (sum > 1e9) continue;

      items.push({ name, unit: "UNKNOWN", qty, price, sum });
    }
  }

  return items;
}

function parseTotals(lines) {
  let sum = null, mass = null, qty = null;

  for (const l of lines) {
    const t = norm(l);

    if (/Всего стоимость/iu.test(t) || /Стоимость с НДС/iu.test(t) || /Всего с НДС/iu.test(t)) {
      const nums = extractNumbers(t).map(x => x.val);
      if (nums.length) sum = Math.max(...nums);
    }
    if (/Масса груза/iu.test(t) || /Всего масса/iu.test(t)) {
      const nums = extractNumbers(t).map(x => x.val);
      if (nums.length) mass = Math.max(...nums);
    }
    if (/Количество грузовых мест/iu.test(t)) {
      const nums = extractNumbers(t).map(x => x.val);
      if (nums.length) qty = Math.max(...nums);
    }
  }

  return { qty, mass, sum };
}

function parseTtn(lines) {
  const warnings = [];
  const header = findHeaderZone(lines);

  const ttn_series = findTtnSeries(header, warnings);
  const ttn_number = findTtnNumber(header, warnings);
  const ttn_date = findTtnDate(header, warnings);

  const unp3 = parseUnpTriple(header);

  const stop = /^(Грузоотправитель|Грузополучатель|Заказчик|УНП|Серия|ТОВАРНО|Автомобиль|Прицеп|Водитель|ТОВАРНЫЙ|ИТОГО)\b/iu;

  const shipperName = afterLabelValue(
    lines,
    /\bГрузоотправитель\b/iu,
    stop,
    30
  );
  const consigneeName = afterLabelValue(
    lines,
    /\bГрузополучатель\b/iu,
    stop,
    30
  );
  const customerName = afterLabelValue(
    lines,
    /\bЗаказчик\b.*\bперевозки\b|\bПлательщик\b/iu,
    stop,
    35
  );

  const carrier = extractCarrier(lines);

  const items = parseItems(lines, warnings);
  const totals = parseTotals(lines);

  return {
    ttn_number,
    ttn_series,
    ttn_date,
    shipper: { name: shipperName || "", unp: unp3.shipper || "" },
    consignee: { name: consigneeName || "", unp: unp3.consignee || "" },
    customer: { name: customerName || "", unp: unp3.customer || "" },
    carrier,
    items,
    totals,
    warnings,
  };
}

// ---- RUN ----
const lines = getLines($json);
const result = parseTtn(lines);

// binary JSON for Read/Write Files from Disk (Input Binary Field = data)
const fileName = `TTN1_${result.ttn_series || "NA"}_${result.ttn_number || "NO_NUMBER"}.json`;
const jsonString = JSON.stringify(result, null, 2);
const base64 = Buffer.from(jsonString, "utf8").toString("base64");

return [{
  json: {
    ...result,
    _debug_goods_zone_preview: (() => {
      const w = [];
      const zone = sliceGoodsZone(lines, w);
      return zone.slice(0, 25).join("\n");
    })(),
    _debug_lines_count: lines.length,
  },
  binary: {
    data: { data: base64, mimeType: "application/json", fileName }
  }
}];
