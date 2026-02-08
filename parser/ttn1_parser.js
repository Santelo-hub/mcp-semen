const UNIT_ALIASES = {
  кг: ["кг", "kg", "кg"],
  т: ["т"],
  л: ["л", "l", "литр", "литра", "литров"],
  м3: ["м3", "m3"],
  м2: ["м2", "m2"],
  м: ["м", "m", "метр", "метра", "метров"],
  шт: ["шт", "штук", "штука", "штуки"],
  уп: ["уп", "упак", "упаковка", "упаковки"],
  пач: ["пач", "пачка", "пачки"],
  кор: ["кор", "короб", "коробка", "коробки"]
};

const MONTHS = {
  января: "01",
  февраля: "02",
  марта: "03",
  апреля: "04",
  мая: "05",
  июня: "06",
  июля: "07",
  августа: "08",
  сентября: "09",
  октября: "10",
  ноября: "11",
  декабря: "12"
};

function safeStr(value) {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeSpaces(text) {
  return safeStr(text)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeNumericToken(token) {
  if (!token) return token;
  let normalized = token;
  normalized = normalized.replace(/[ОO]/g, "0").replace(/[ІI|l]/g, "1");
  normalized = normalized.replace(/\s/g, "").replace(",", ".");
  return normalized;
}

function parseNumberRU(value) {
  const normalized = normalizeNumericToken(safeStr(value).trim());
  if (!normalized) return null;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

function parseRuDateToISO(text) {
  const value = safeStr(text);
  const numeric = value.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (numeric) {
    const dd = String(numeric[1]).padStart(2, "0");
    const mm = String(numeric[2]).padStart(2, "0");
    return `${numeric[3]}-${mm}-${dd}`;
  }
  const words = value.match(/(\d{1,2})\s+([А-Яа-яёЁ]+)\s+(\d{4})/);
  if (!words) return null;
  const dd = String(words[1]).padStart(2, "0");
  const mm = MONTHS[words[2].toLowerCase().replace(/\./g, "")] || null;
  if (!mm) return null;
  return `${words[3]}-${mm}-${dd}`;
}

function findTtnNumberAndSeries(text) {
  const lines = normalizeSpaces(text).split("\n");
  const top = lines.slice(0, 30).join(" ");
  const seriesWithLabel = /(?:серия|сер\.)\s*([A-ZА-Я]{1,3})\s*№?\s*(\d{6,7})/iu;
  const seriesPlain = /\b([A-ZА-Я]{1,3})\s+(\d{6,7})\b/u;
  const seriesMatch =
    top.match(seriesWithLabel) ||
    text.match(seriesWithLabel) ||
    top.match(seriesPlain) ||
    text.match(seriesPlain);
  if (seriesMatch) {
    return { series: seriesMatch[1], number: seriesMatch[2] };
  }
  const numberMatch = top.match(/\b№?\s*(\d{6,7})\b/);
  return { series: "", number: numberMatch ? numberMatch[1] : "" };
}

function extractNumbersFromLine(line) {
  const matches = [];
  const re = /(\d[\d \u00A0.,]*)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const raw = match[1];
    const parts = raw.trim().split(/[ \u00A0]+/).filter(Boolean);
    const hasDecimal = /[.,]/.test(raw);
    if (!hasDecimal && parts.length >= 3) {
      for (const part of parts) {
        const value = parseNumberRU(part);
        if (value !== null) {
          matches.push({ value, raw: part, index: match.index });
        }
      }
      continue;
    }
    const value = parseNumberRU(raw);
    if (value !== null) {
      matches.push({ value, raw, index: match.index });
    }
  }
  return matches;
}

function detectUnit(text) {
  const tokens = safeStr(text)
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/iu)
    .filter(Boolean);
  for (const [unit, aliases] of Object.entries(UNIT_ALIASES)) {
    if (aliases.some(alias => tokens.includes(alias))) return unit;
  }
  return "UNKNOWN";
}

function cleanNameFromLine(line) {
  if (!line) return "";
  return line.replace(/\s{2,}/g, " ").trim();
}

function splitNameAndNumbers(line) {
  const numbers = extractNumbersFromLine(line);
  let name = line;
  for (const token of numbers) {
    name = name.replace(token.raw, " ");
  }
  name = name.replace(/\s{2,}/g, " ").trim();
  return { name, numbers };
}

function pickQtyPriceSum(tokens) {
  if (!tokens.length) return { qty: null, price: null, sum: null };
  let sumToken = tokens[0];
  for (const token of tokens) {
    if (token.value >= sumToken.value) sumToken = token;
  }
  const candidates = tokens.filter(token => token !== sumToken);
  let qtyToken =
    candidates.find(token => Number.isInteger(token.value) && token.value > 0) ||
    candidates[0] ||
    null;
  let priceToken =
    candidates.find(token => token !== qtyToken && !Number.isInteger(token.value)) ||
    candidates.find(token => token !== qtyToken) ||
    null;
  if (!qtyToken && candidates.length === 1) qtyToken = candidates[0];
  return {
    qty: qtyToken ? qtyToken.value : null,
    price: priceToken ? priceToken.value : null,
    sum: sumToken ? sumToken.value : null
  };
}

function parseItemsFromText(text, warnings) {
  const lines = normalizeSpaces(text).split("\n").map(line => line.trim()).filter(Boolean);
  const startIdx = lines.findIndex(line =>
    /I\.\s*ТОВАРНЫЙ РАЗДЕЛ/i.test(line) || /^ТОВАРНЫЙ РАЗДЕЛ$/i.test(line)
  );
  if (startIdx === -1) return [];
  let endIdx = lines.findIndex((line, idx) => idx > startIdx && (/^II\./i.test(line) || /ПОГРУЗОЧНО/i.test(line)));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx);

  const items = [];
  let nameBuffer = [];

  for (let i = 0; i < section.length; i++) {
    const line = section[i];
    if (line.toLowerCase().startsWith("итого")) break;
    if (/Наименование|Единица|Количество|Цена|Стоимость|НДС|Сумма|Масса/i.test(line)) continue;

    const hasDigits = /\d/.test(line);
    const hasLetters = /[A-Za-zА-Яа-яЁё]/.test(line);

    if (!hasDigits && hasLetters) {
      nameBuffer.push(line);
      continue;
    }

    if (!hasDigits) continue;

    let { name, numbers } = splitNameAndNumbers(line);
    if (nameBuffer.length) {
      name = cleanNameFromLine(`${nameBuffer.join(" ")} ${name}`.trim());
    }
    if (!name && i + 1 < section.length) {
      const next = splitNameAndNumbers(section[i + 1]);
      if (next.name && !/\d/.test(next.name)) {
        name = next.name;
        i += 1;
      }
    }
    nameBuffer = [];
    if (!name) continue;

    if (numbers.length < 2 && i + 1 < section.length) {
      const extraNumbers = extractNumbersFromLine(section[i + 1]);
      if (extraNumbers.length) {
        numbers = numbers.concat(extraNumbers);
        i += 1;
      }
    }

    const unit = detectUnit(`${name} ${line}`);
    if (unit === "UNKNOWN") {
      warnings.push(`Не удалось определить единицу измерения для "${name}".`);
    }

    const { qty, price, sum } = pickQtyPriceSum(numbers);
    items.push({
      name,
      unit,
      qty: qty ?? 0,
      price: price ?? 0,
      sum: sum ?? 0
    });
  }
  return items;
}

function extractUnpFromLine(line) {
  const match = line.match(/УНП\s*[:№]?\s*(\d{9})/i) || line.match(/\b(\d{9})\b/);
  return match ? match[1] : "";
}

function extractPartyInfo(text, labelRegex) {
  const lines = normalizeSpaces(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!labelRegex.test(line)) continue;
    const inline = line
      .replace(labelRegex, "")
      .replace(/\(.*?\)/g, " ")
      .replace(/[:\-–—]/g, " ")
      .trim();
    const inlineName = inline.replace(/УНП.*$/i, "").trim();
    const inlineUnp = extractUnpFromLine(line);
    let name = inlineName;
    let unp = inlineUnp;

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (!name) {
        const candidate = lines[j].trim();
        if (candidate && !labelRegex.test(candidate)) {
          name = candidate.replace(/УНП.*$/i, "").trim();
        }
      }
      if (!unp) {
        unp = extractUnpFromLine(lines[j]);
      }
    }
    return { name: name || "", unp: unp || "" };
  }
  return { name: "", unp: "" };
}

function findCarrierInfo(text) {
  const lines = normalizeSpaces(text).split("\n");
  const car = (text.match(/Автомобиль\s+([^\n]+)/i) || [])[1] || "";
  const trailer = (text.match(/Прицеп\s+([^\n]+)/i) || [])[1] || "";
  const driver = (text.match(/Водитель\s+([^\n]+)/i) || [])[1] || "";
  let name = "";
  for (const line of lines) {
    if (/Владелец автомобиля|Перевозчик/i.test(line)) {
      name = line.replace(/Владелец автомобиля|Перевозчик/gi, "").replace(/[:\-–—]/g, " ").trim();
      if (name) break;
    }
  }
  return {
    name,
    car: car.trim(),
    trailer: trailer.replace(/К путевому листу.*$/i, "").trim(),
    driver: driver.trim()
  };
}

function parseTotalsFromText(text) {
  const lines = normalizeSpaces(text).split("\n");
  const totals = { qty: null, mass: null, sum: null };

  for (const line of lines) {
    const numbers = extractNumbersFromLine(line);
    if (/итого|всего стоимость|всего с ндс/iu.test(line)) {
      if (numbers.length) {
        const max = Math.max(...numbers.map(n => n.value));
        totals.sum = totals.sum ?? max;
      }
    }
    if (/всего количество|кол-во|количество грузовых мест/iu.test(line)) {
      if (numbers.length) {
        const qty = numbers.find(n => Number.isInteger(n.value))?.value || numbers[0].value;
        totals.qty = totals.qty ?? qty;
      }
    }
    if (/масса груза|общая масса|масса,?\s*кг/iu.test(line)) {
      if (numbers.length) {
        const max = Math.max(...numbers.map(n => n.value));
        totals.mass = totals.mass ?? max;
      }
    }
  }
  return totals;
}

function summarizeItemTotals(items) {
  let qty = 0;
  let sum = 0;
  for (const item of items) {
    if (typeof item.qty === "number") qty += item.qty;
    if (typeof item.sum === "number") sum += item.sum;
  }
  return {
    qty: items.length ? qty : null,
    sum: items.length ? sum : null
  };
}

function mergeTotals(items, textTotals, warnings) {
  const itemTotals = summarizeItemTotals(items);
  const totals = {
    qty: textTotals.qty ?? itemTotals.qty ?? null,
    mass: textTotals.mass ?? null,
    sum: textTotals.sum ?? itemTotals.sum ?? null
  };
  if (itemTotals.sum !== null && textTotals.sum !== null) {
    const diff = Math.abs(itemTotals.sum - textTotals.sum);
    if (diff > 0.01) {
      warnings.push(`Несовпадение суммы: позиции=${itemTotals.sum.toFixed(2)}, итого=${textTotals.sum.toFixed(2)}.`);
    }
  }
  if (itemTotals.qty !== null && textTotals.qty !== null) {
    const diff = Math.abs(itemTotals.qty - textTotals.qty);
    if (diff > 0) {
      warnings.push(`Несовпадение количества: позиции=${itemTotals.qty}, итого=${textTotals.qty}.`);
    }
  }
  return totals;
}

function parseTtn1(rawText) {
  const warnings = [];
  const text = normalizeSpaces(rawText);
  const { series, number } = findTtnNumberAndSeries(text);
  const date = parseRuDateToISO(text) || "";

  const shipper = extractPartyInfo(text, /Грузоотправитель/iu);
  const consignee = extractPartyInfo(text, /Грузополучатель/iu);
  const customer = extractPartyInfo(text, /Заказчик автомобильной перевозки|Плательщик/iu);
  const carrier = findCarrierInfo(text);

  const items = parseItemsFromText(text, warnings);
  const totalsFromText = parseTotalsFromText(text);
  const totals = mergeTotals(items, totalsFromText, warnings);

  return {
    ttn_number: number,
    ttn_series: series,
    ttn_date: date,
    shipper,
    consignee,
    customer,
    carrier,
    items,
    totals,
    warnings
  };
}

module.exports = {
  parseTtn1
};
