// n8n Code node (JavaScript) — TTN-1 BY parser (Merge Append: TEXT + TABLE)
// FIX v4:
// - Parties by UNP columns: prefer same-line-left value near UNP, then below-line fallback
// - Keep strict placeholder rejection
// - basis_text only from "Основание отпуска"
// - trailer normalization: move org-like value to car_owner if trailer is not plate-like
// - route point normalization: remove OCR-leading conjunctions like "и "

function s(v){ return (v===null||v===undefined) ? "" : String(v); }
function normText(v){ return s(v).replace(/\u00A0/g," ").replace(/\r/g,"").replace(/[ \t]+/g," ").trim(); }
function low(v){ return normText(v).toLowerCase(); }

const MONTH_MAP = {
  "января":"01","февраля":"02","марта":"03","апреля":"04","мая":"05","июня":"06",
  "июля":"07","августа":"08","сентября":"09","октября":"10","ноября":"11","декабря":"12",
};

function parseNum(raw){
  let t = normText(raw);
  if(!t) return null;
  t = t.replace(/[^\d,.\- ]+/g,"").replace(/\s+/g,"");
  if(!t) return null;
  const hasC = t.includes(","), hasD = t.includes(".");
  if(hasC && hasD){
    if(t.lastIndexOf(".") > t.lastIndexOf(",")) t = t.replace(/,/g,"");
    else { t = t.replace(/\./g,""); t = t.replace(/,/g,"."); }
  } else if(hasC && !hasD) t = t.replace(/,/g,".");
  t = t.replace(/[^0-9.\-]/g,"");
  if(!t || t==="-" || t==="." || t==="-.") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseDateISOFromText(text){
  const t = low(text);
  let m = t.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if(m){
    const dd = String(+m[1]).padStart(2,"0");
    const mm = String(+m[2]).padStart(2,"0");
    return `${m[3]}-${mm}-${dd}`;
  }
  m = t.match(/\b(\d{1,2})\s+([а-яё]+)\s+(\d{4})\b/);
  if(m && MONTH_MAP[m[2]]) return `${m[3]}-${MONTH_MAP[m[2]]}-${String(+m[1]).padStart(2,"0")}`;
  return null;
}
function isoToDMY(iso){ const m = s(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : null; }
function toCyrSeries(v){
  const map = { A:"А",B:"В",C:"С",E:"Е",H:"Н",K:"К",M:"М",O:"О",P:"Р",T:"Т",X:"Х",Y:"У",I:"И" };
  const up = s(v).toUpperCase();
  let out = "";
  for(const ch of up) out += (map[ch] || ch);
  out = out.replace(/[^A-ZА-ЯЁ]/g,"");
  return out || null;
}

function isPlaceholderLine(t){
  const l = low(t);
  if(/\(\s*марка[, ]+государствен/i.test(l)) return true;
  if(/\(\s*наименован/i.test(l) && l.includes("адрес")) return true;
  if(l.includes("фамилия") && l.includes("инициал")) return true;
  if(/^\(.*\)$/.test(normText(t)) && t.length < 80) return true;
  return false;
}
function isFormTitleLine(t){ const l = low(t); return l.includes("товарно") && l.includes("накладн"); }
function isDateLike(t){ return /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(normText(t)); }
function isGarbageName(t){
  const x = normText(t), l = low(t);
  if(!x || x.length < 8) return true;
  if(isFormTitleLine(x) || isDateLike(x) || isPlaceholderLine(x)) return true;
  if(l.includes("форма установлена") || l.includes("министерства финансов")) return true;
  if(/^\d{9}$/.test(x) || /^\d+$/.test(x)) return true;
  return false;
}
function isLabelish(t){
  const l = low(t);
  return l.includes("грузоотправ") || l.includes("грузополуч") || l.startsWith("унп") || l.startsWith("серия") || l.startsWith("пункт ") || l.startsWith("водитель") || l.startsWith("прицеп") || l.startsWith("автомобил");
}
function cleanupValue(v){
  let t = normText(v);
  if(!t) return null;
  t = t.replace(/^(?:[ьъюа]\s+)+/i,"").replace(/^[,.;:_—–-]+/g,"").trim();
  if(t.length < 2) return null;
  return t;
}

const inputs = $input.all().map(x => x.json || {});
const a = inputs[0] || {};
const b = inputs[1] || {};

function getTA(obj){ return obj?.textAnnotation || obj?.result?.textAnnotation || obj?.result?.results?.[0]?.textAnnotation || null; }
function getFullText(obj){
  const direct = obj?.result?.text || obj?.text || obj?.ocr_text || null;
  if(typeof direct === "string" && direct.trim()) return direct;
  const ta = getTA(obj);
  if(typeof ta?.text === "string" && ta.text.trim()) return ta.text;
  const out = [];
  for(const bl of (ta?.blocks || [])) for(const ln of (bl?.lines || [])){ const t = normText(ln?.text); if(t) out.push(t); }
  return out.join("\n");
}
const textAll = (()=>{ const t1=getFullText(a), t2=getFullText(b); return t1.length>=t2.length?t1:t2; })();
const fullLines = s(textAll).split("\n").map(normText).filter(Boolean);

function getLinesXY(obj){
  const out = [];
  const ta = getTA(obj);
  for(const bl of (ta?.blocks || [])){
    for(const ln of (bl?.lines || [])){
      const t = normText(ln?.text); if(!t) continue;
      const bb = ln?.boundingBox?.vertices || [];
      const xs=[], ys=[];
      for(const p of bb){ if(Number.isFinite(+p?.x)) xs.push(+p.x); if(Number.isFinite(+p?.y)) ys.push(+p.y); }
      const x0 = xs.length ? Math.min(...xs) : null;
      const x1 = xs.length ? Math.max(...xs) : null;
      const y0 = ys.length ? Math.min(...ys) : null;
      const y1 = ys.length ? Math.max(...ys) : null;
      out.push({ text:t, x0, x1, y0, y1, cx:(x0!==null&&x1!==null)?(x0+x1)/2:null, cy:(y0!==null&&y1!==null)?(y0+y1)/2:null });
    }
  }
  return out;
}
const linesXY = [...getLinesXY(a), ...getLinesXY(b)];

function headerBottomY(lines){
  let y = null;
  for(const ln of lines){
    const l = low(ln.text);
    if(ln.cy===null) continue;
    if((l.includes("товарно") && l.includes("накладн")) || (l.includes("товарный") && l.includes("раздел"))) y = (y===null)?ln.cy:Math.min(y,ln.cy);
  }
  return y===null ? 260 : y;
}

function extractUNPsFromHeader(text){
  const t = normText(text), l = low(t);
  const iUnp = l.indexOf("унп");
  if(iUnp < 0) return { shipper_unp:null, consignee_unp:null, customer_unp:null };
  let iEnd = l.indexOf("серия", iUnp);
  if(iEnd < 0) iEnd = Math.min(t.length, iUnp + 1600);
  const list = (t.slice(iUnp, iEnd).match(/\b\d{9}\b/g) || []);
  return { shipper_unp:list[0]||null, consignee_unp:list[1]||null, customer_unp:list[2]||null };
}
function extractSeriesNumber(text){
  const t = normText(text);
  const sM = t.match(/Серия\s+([A-Za-zА-ЯЁ]{1,4})/i);
  let nM = t.match(/НАКЛАДН\w*\s+(\d{6,8})/i);
  if(!nM){ const all = t.match(/\b\d{6,8}\b/g)||[]; nM = all[0] ? ["",all[0]] : null; }
  return { series: sM ? toCyrSeries(sM[1]) : null, number: nM ? nM[1] : null };
}

function findTopmostLineContainingUNP(lines, unp, yCutoff){
  if(!unp) return null;
  let best = null;
  for(const ln of lines){
    if(ln.cy===null || ln.cy > yCutoff) continue;
    if(!normText(ln.text).includes(unp)) continue;
    if(!best || ln.cy < best.cy) best = ln;
  }
  return best;
}
function pickNameSameLineLeft(lines, unpLine){
  if(!unpLine || unpLine.y0===null || unpLine.y1===null || unpLine.x0===null) return null;
  const cands = [];
  for(const ln of lines){
    if(ln.x1===null || ln.y0===null || ln.y1===null) continue;
    const overlap = Math.min(ln.y1, unpLine.y1) - Math.max(ln.y0, unpLine.y0);
    if(overlap < 3) continue;
    if(ln.x1 >= unpLine.x0 - 8) continue;
    const v = cleanupValue(ln.text);
    if(!v || isLabelish(v) || isGarbageName(v)) continue;
    if(!/[А-Яа-яЁё]/.test(v)) continue;
    cands.push({ln, v, dist: Math.abs((ln.x1||0) - (unpLine.x0||0))});
  }
  cands.sort((a,b)=>a.dist-b.dist);
  return cands[0]?.v || null;
}
function pickNameBelowUNP(lines, unpLine, yCutoff){
  if(!unpLine || unpLine.cy===null) return null;
  const yMin = unpLine.cy + 8;
  const yMax = Math.min(unpLine.cy + 70, yCutoff - 6);
  const xL = (unpLine.x0!==null) ? (unpLine.x0 - 80) : null;
  const xR = (unpLine.x1!==null) ? (unpLine.x1 + 160) : null;
  const cand = [];
  for(const ln of lines){
    if(ln.cy===null || ln.cy < yMin || ln.cy > yMax || ln.cy > yCutoff) continue;
    if(xL!==null && ln.x1!==null && ln.x1 < xL) continue;
    if(xR!==null && ln.x0!==null && ln.x0 > xR) continue;
    const v = cleanupValue(ln.text);
    if(!v || isLabelish(v) || isGarbageName(v)) continue;
    cand.push({ ...ln, val: v });
  }
  cand.sort((a,b)=> (a.cy-b.cy) || ((a.cx||0)-(b.cx||0)));
  return cand[0]?.val || null;
}
function extractPartiesByUNP(lines, shipper_unp, consignee_unp, customer_unp){
  const yCutoff = headerBottomY(lines);
  const one = (unp)=>{
    const ln = findTopmostLineContainingUNP(lines, unp, yCutoff);
    if(!ln) return null;
    return pickNameSameLineLeft(lines, ln) || pickNameBelowUNP(lines, ln, yCutoff) || null;
  };
  return { shipper_name:one(shipper_unp), consignee_name:one(consignee_unp), customer_name:one(customer_unp) };
}

function extractByLabelSmart(lines, labelMatcher, stripRe, maxLookahead = 10){
  const test = (l)=> labelMatcher instanceof RegExp ? labelMatcher.test(l) : false;
  for(let i=0;i<lines.length;i++){
    const ln = normText(lines[i]);
    if(!test(low(ln))) continue;
    let after = stripRe ? ln.replace(stripRe, "") : ln;
    after = cleanupValue(after);
    if(after && !isLabelish(after) && !isGarbageName(after)) return after;
    for(let k=i+1;k<Math.min(lines.length, i+maxLookahead);k++){
      const cand = cleanupValue(lines[k]);
      if(cand && !isLabelish(cand) && !isGarbageName(cand)) return cand;
    }
    return null;
  }
  return null;
}
function extractWaybill(lines){
  const t = lines.join("\n");
  const m = t.match(/к\s+путев\w*\s+лист\w*\s*№\s*([0-9]{1,12})/i);
  return m ? m[1] : null;
}
function normalizeRoutePoint(v){
  let t = cleanupValue(v);
  if(!t) return null;
  t = t.replace(/^и\s+/i, "").replace(/^пункт\s+/i, "").trim();
  return t || null;
}
function isTrailerPlateLike(v){
  const t = low(v);
  return /[а-яa-z]{1,3}\s?\d{3,4}[-– ]\d/.test(t) || t.includes("гос") || t.includes("номер");
}
function looksLikeOrg(v){
  const l = low(v);
  return l.includes("индивидуальн") || l.includes("ооо") || l.includes("зао") || l.includes("унитар") || l.includes("предпринимател");
}

const { shipper_unp, consignee_unp, customer_unp } = extractUNPsFromHeader(textAll);
const { series, number } = extractSeriesNumber(textAll);
const dIso = parseDateISOFromText(textAll);
const parties = extractPartiesByUNP(linesXY, shipper_unp, consignee_unp, customer_unp);

const waybill_no = extractWaybill(fullLines);
const car = extractByLabelSmart(fullLines, /^автомобил/i, /^Автомобил\w*[:\s-]*/i, 12);
const driver = extractByLabelSmart(fullLines, /^водител/i, /^Водител\w*[:\s-]*/i, 12);
let trailer = extractByLabelSmart(fullLines, /^прицеп/i, /^Прицеп[:\s-]*/i, 12);
let car_owner = null;
if(trailer && !isTrailerPlateLike(trailer) && looksLikeOrg(trailer)){
  car_owner = trailer;
  trailer = null;
}

const loading_point = normalizeRoutePoint(extractByLabelSmart(fullLines, /^пункт\s+погрузк/i, /^Пункт\s+погрузк\w*[:\s-]*/i, 14));
const unloading_point = normalizeRoutePoint(extractByLabelSmart(fullLines, /^пункт\s+разгрузк/i, /^Пункт\s+разгрузк\w*[:\s-]*/i, 14));
let basis_text = extractByLabelSmart(fullLines, /основан\w*\s+отпуск/i, /^Основани\w*\s+отпуск\w*[:\s-]*/i, 14);
if(basis_text && low(basis_text) === "основание отпуска") basis_text = null;

const has_manual_corrections = /исправлен|подчист|зачерк/i.test(low(textAll));
const has_redirection = /переадрес|переадр/i.test(low(textAll));

const warnings = [];
if(!parties.shipper_name) warnings.push("Не найден грузоотправитель (name).");
if(!parties.consignee_name) warnings.push("Не найден грузополучатель (name).");
if(!parties.customer_name) warnings.push("Не найден заказчик перевозки (name).");
if(!customer_unp) warnings.push("Не найден УНП заказчика.");
if(!waybill_no && /к\s+путев/i.test(low(textAll))) warnings.push("Путевой лист упомянут, но номер не извлечён (OCR шум).");

return [{
  ttn_series: series,
  ttn_number: number,
  ttn_date: isoToDMY(dIso),
  ttn_date_iso: dIso,
  shipper: { name: parties.shipper_name || null, unp: shipper_unp || null },
  consignee: { name: parties.consignee_name || null, unp: consignee_unp || null },
  customer: { name: parties.customer_name || null, unp: customer_unp || null },
  carrier: { name: null, car: car || null, trailer: trailer || null, driver: driver || null, waybill_no: waybill_no || null, car_owner },
  route: { loading_point: loading_point || null, unloading_point: unloading_point || null },
  basis: { basis_text: basis_text || null },
  flags: { has_manual_corrections, has_redirection },
  items: [],
  totals: { qty: null, mass: null, sum: null, vat_sum: null, sum_with_vat: null, places: null },
  warnings
}];
