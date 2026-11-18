// Тесты скрипта measure.mjs. Запуск: node --test
// Скрипт запускается как отдельный процесс против локального HTTP-сервера,
// поэтому результат не зависит от сети.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./measure.mjs", import.meta.url));
const BODY_SIZE = 1000;

/**
 * Поднимает локальный сервер, который отдаёт BODY_SIZE байт или ошибку.
 * @param {(n: number) => number} statusFor Возвращает HTTP-статус для n-го запроса (с 1).
 * @returns {Promise<{ url: string, hits: () => number, close: () => Promise<void> }>}
 */
async function startServer(statusFor = () => 200) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const status = statusFor(hits);
    res.writeHead(status, { "Content-Length": status === 200 ? BODY_SIZE : 0 });
    res.end(status === 200 ? Buffer.alloc(BODY_SIZE) : undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => hits,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/**
 * Запускает measure.mjs с аргументами и собирает вывод.
 * @param {string[]} args Аргументы командной строки скрипта.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("по умолчанию делает 10 запросов и считает объём", async () => {
  const srv = await startServer();
  try {
    const { code, stdout } = await run([srv.url]);
    assert.equal(code, 0);
    assert.equal(srv.hits(), 10);
    assert.match(stdout, /Успешных запросов:\s+10 из 10/);
    assert.match(stdout, /\(10000 байт\)/);
    assert.match(stdout, /Скорость скачивания:\s+[\d.]+ Мбит\/с/);
  } finally {
    await srv.close();
  }
});

test("количество запросов берётся из второго аргумента", async () => {
  const srv = await startServer();
  try {
    const { code, stdout } = await run([srv.url, "3"]);
    assert.equal(code, 0);
    assert.equal(srv.hits(), 3);
    assert.match(stdout, /\(3000 байт\)/);
  } finally {
    await srv.close();
  }
});

test("часть запросов с ошибкой: код выхода 2, ошибки не входят в статистику", async () => {
  // Чётные запросы отвечают 500.
  const srv = await startServer((n) => (n % 2 === 0 ? 500 : 200));
  try {
    const { code, stdout } = await run([srv.url, "4"]);
    assert.equal(code, 2);
    assert.equal(srv.hits(), 4);
    assert.match(stdout, /ошибка \(HTTP 500/);
    assert.match(stdout, /Успешных запросов:\s+2 из 4 \(ошибок: 2\)/);
    assert.match(stdout, /\(2000 байт\)/);
  } finally {
    await srv.close();
  }
});

test("все запросы с ошибкой: код выхода 1", async () => {
  const srv = await startServer(() => 404);
  try {
    const { code, stderr } = await run([srv.url, "2"]);
    assert.equal(code, 1);
    assert.match(stderr, /ни один запрос/);
  } finally {
    await srv.close();
  }
});

test("без аргументов: код выхода 1 и подсказка по использованию", async () => {
  const { code, stderr } = await run([]);
  assert.equal(code, 1);
  assert.match(stderr, /не указан адрес/);
});

test("некорректный адрес и неподдерживаемый протокол отклоняются", async () => {
  for (const bad of ["not-a-url", "ftp://example.com/file"]) {
    const { code, stderr } = await run([bad]);
    assert.equal(code, 1, bad);
    assert.match(stderr, /Ошибка:/, bad);
  }
});

test("некорректное количество запросов отклоняется", async () => {
  for (const bad of ["0", "-1", "abc", "2.5"]) {
    const { code, stderr } = await run(["http://127.0.0.1:1/", bad]);
    assert.equal(code, 1, bad);
    assert.match(stderr, /целым числом >= 1/, bad);
  }
});
