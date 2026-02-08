const assert = require("assert");
const { parseTtn1 } = require("../parser/ttn1_parser");

const fixtureWithTotals = `
ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ
Серия ЭН 0186905
24 мая 2018 г.
Грузоотправитель: ООО "Склад" УНП 123456789
Грузополучатель: ОАО "Покупатель" УНП 987654321
Заказчик автомобильной перевозки (плательщик): ЧУП "Клиент" УНП 555666777
Автомобиль МАН АА1234-5
Водитель Иванов И.И.
I. ТОВАРНЫЙ РАЗДЕЛ
Картон PRIME 2408 кг 5,90 14 207,20 2 841,44 17 048,64
ИТОГО 17 048,64
Всего масса груза 2408 кг
Всего количество грузовых мест 4
`;

const fixtureUnitsAndDate = `
Товарно-транспортная накладная № 1234567
10.10.2016
Грузоотправитель ООО "Ромашка" УНП 111222333
Грузополучатель ООО "Логистика" УНП 444555666
Заказчик автомобильной перевозки (плательщик) ООО "Клиент" УНП 777888999
I. ТОВАРНЫЙ РАЗДЕЛ
Бутыль 5л 10 3,50 35,00
Коробка шт 2 15,00 30,00
ИТОГО 65,00
`;

const fixtureUnknownUnit = `
Товарно-транспортная накладная № 7654321
10/10/2016
Грузоотправитель ООО "Сервис" УНП 101010101
Грузополучатель ООО "Торг" УНП 202020202
Заказчик автомобильной перевозки (плательщик) ООО "Партнер" УНП 303030303
I. ТОВАРНЫЙ РАЗДЕЛ
Лента 2 100 200
ИТОГО 200
`;

{
  const result = parseTtn1(fixtureWithTotals);
  assert.strictEqual(result.ttn_series, "ЭН");
  assert.strictEqual(result.ttn_number, "0186905");
  assert.strictEqual(result.ttn_date, "2018-05-24");
  assert.strictEqual(result.shipper.unp, "123456789");
  assert.ok(result.items.length >= 1);
  assert.strictEqual(result.totals.sum, 17048.64);
  assert.strictEqual(result.totals.mass, 2408);
  assert.strictEqual(result.totals.qty, 4);
}

{
  const result = parseTtn1(fixtureUnitsAndDate);
  assert.strictEqual(result.ttn_date, "2016-10-10");
  assert.strictEqual(result.items[0].unit, "л");
  assert.strictEqual(result.items[1].unit, "шт");
  assert.strictEqual(result.totals.sum, 65);
}

{
  const result = parseTtn1(fixtureUnknownUnit);
  assert.ok(result.warnings.some(warning => warning.includes("единицу измерения")));
}

console.log("ttn1_parser tests passed");
