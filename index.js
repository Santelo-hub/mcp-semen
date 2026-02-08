const fs = require("fs");
const { parseTtn1 } = require("./parser/ttn1_parser");

function parseFromText(text) {
  return parseTtn1(text);
}

function parseFromFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parseFromText(text);
}

module.exports = {
  parseFromText,
  parseFromFile
};
