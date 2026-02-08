#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { parseTtn1 } = require("../parser/ttn1_parser");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: ttn1-parse <path-to-ocr-text>");
  process.exit(1);
}

const absolutePath = path.resolve(process.cwd(), inputPath);
const text = fs.readFileSync(absolutePath, "utf8");
const result = parseTtn1(text);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
