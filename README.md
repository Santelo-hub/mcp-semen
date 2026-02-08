# TTN-1 Parser (BY)

Production-ready TTN-1 (Беларусь) parser that converts OCR text into a strict JSON format for 1C “Поступление”.

## Usage

### As a function
```js
const { parseFromText } = require("./index");

const rawText = `ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ
Серия ЭН 0186905
24 мая 2018 г.
Грузоотправитель: ООО "Склад" УНП 123456789
Грузополучатель: ОАО "Покупатель" УНП 987654321
Заказчик автомобильной перевозки (плательщик): ЧУП "Клиент" УНП 555666777
I. ТОВАРНЫЙ РАЗДЕЛ
Картон PRIME 2408 кг 5,90 14 207,20 2 841,44 17 048,64
ИТОГО 17 048,64`;

const result = parseFromText(rawText);
console.log(result);
```

### CLI
```bash
node bin/ttn1_parse.js path/to/ocr.txt
```

## Output JSON
```json
{
  "ttn_number": "0186905",
  "ttn_series": "ЭН",
  "ttn_date": "2018-05-24",
  "shipper": {"name":"ООО \"Склад\"", "unp":"123456789"},
  "consignee": {"name":"ОАО \"Покупатель\"", "unp":"987654321"},
  "customer": {"name":"ЧУП \"Клиент\"", "unp":"555666777"},
  "carrier": {"name":"", "car":"", "trailer":"", "driver":""},
  "items": [{"name":"Картон PRIME", "unit":"кг", "qty":2408, "price":5.9, "sum":17048.64}],
  "totals": {"qty": 4, "mass": 2408, "sum": 17048.64},
  "warnings": []
}
```
