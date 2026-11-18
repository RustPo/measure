#!/usr/bin/env node
// Замер скорости скачивания: N последовательных запросов к одному адресу.
// Запуск: node measure.mjs <url> [количество_запросов]

import { performance } from "node:perf_hooks";

const DEFAULT_REQUESTS = 10;
const TIMEOUT_MS = 30_000;

/**
 * Печатает сообщение об ошибке в stderr и завершает процесс с кодом 1.
 * @param {string} message Текст ошибки.
 * @returns {never}
 */
function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

/**
 * Разбирает аргументы командной строки и проверяет их.
 * При некорректных аргументах завершает процесс через {@link fail}.
 * @param {string[]} argv Массив process.argv (первые два элемента пропускаются).
 * @returns {{ url: URL, count: number }} Адрес и количество запросов.
 */
function parseArgs(argv) {
  const [rawUrl, rawCount] = argv.slice(2);
  if (!rawUrl) {
    fail(
      "не указан адрес.\nИспользование: node measure.mjs <url> [количество_запросов]",
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(`некорректный адрес: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("поддерживаются только http:// и https://");
  }

  const count = rawCount === undefined ? DEFAULT_REQUESTS : Number(rawCount);
  if (!Number.isInteger(count) || count < 1) {
    fail("количество запросов должно быть целым числом >= 1");
  }

  return { url, count };
}

/**
 * Один запрос: ждёт, пока тело ответа придёт целиком, и считает байты.
 * Тело читается потоком и не копится в памяти, чтобы большие файлы не раздували RAM.
 * @param {URL} url Адрес, к которому делается запрос.
 * @returns {Promise<{ bytes: number, ms: number }>} Размер тела в байтах и время запроса в миллисекундах.
 * @throws {Error} При ответе не 2xx, сетевой ошибке или таймауте (TimeoutError).
 */
async function downloadOnce(url) {
  const start = performance.now();

  const res = await fetch(url, {
    // Просим данные без сжатия: считаем реально переданные байты, а не распакованные.
    headers: { "Accept-Encoding": "identity" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Не читаем тело ошибки, но закрываем поток, чтобы соединение освободилось.
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  let bytes = 0;
  for await (const chunk of res.body ?? []) {
    bytes += chunk.length;
  }

  return { bytes, ms: performance.now() - start };
}

/**
 * Точка входа: делает запросы последовательно и печатает статистику.
 * Код выхода: 0 все запросы успешны, 2 были ошибки, 1 неверные аргументы или ни один запрос не удался.
 * @returns {Promise<void>}
 */
async function main() {
  const { url, count } = parseArgs(process.argv);
  console.log(`Адрес: ${url.href}`);
  console.log(`Запросов: ${count} (последовательно)\n`);

  const results = [];
  let failed = 0;

  // Запросы намеренно последовательные (по условию задания): параллельность
  // искажала бы время каждого запроса, так как они делили бы один канал.
  for (let i = 1; i <= count; i++) {
    try {
      const r = await downloadOnce(url);
      results.push(r);
      console.log(
        `#${String(i).padStart(2)}: ${r.ms.toFixed(0).padStart(6)} мс, ${(r.bytes / 1024).toFixed(1)} КиБ`,
      );
    } catch (err) {
      failed++;
      const reason =
        err.name === "TimeoutError"
          ? `таймаут ${TIMEOUT_MS / 1000} с`
          : (err.cause?.code ?? err.message);
      console.log(`#${String(i).padStart(2)}: ошибка (${reason})`);
    }
  }

  if (results.length === 0) {
    fail("ни один запрос не завершился успешно");
  }

  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  const avgMs = totalMs / results.length;
  const seconds = totalMs / 1000;

  // Скорость = всего байт / всего времени (а не среднее из скоростей отдельных запросов,
  // иначе быстрые маленькие ответы искажали бы результат).
  const mbitPerSec = (totalBytes * 8) / seconds / 1_000_000;
  const mbytePerSec = totalBytes / seconds / 1_000_000;

  console.log("\n--- Итог ---");
  console.log(
    `Успешных запросов:     ${results.length} из ${count}${failed ? ` (ошибок: ${failed})` : ""}`,
  );
  console.log(`Среднее время запроса: ${avgMs.toFixed(0)} мс`);
  console.log(
    `Скачано всего:         ${(totalBytes / 1_000_000).toFixed(2)} МБ (${totalBytes} байт)`,
  );
  console.log(
    `Скорость скачивания:   ${mbitPerSec.toFixed(2)} Мбит/с (${mbytePerSec.toFixed(2)} МБ/с)`,
  );

  if (failed > 0) process.exitCode = 2;
}

main();
