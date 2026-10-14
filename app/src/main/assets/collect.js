/*
 * Chat Saver: прокручивает страницу порциями и собирает видимый текст.
 * Запускается из MainActivity; __TOKEN__ подставляется приложением.
 * Результат уходит в приложение через window.ChatSaver (progress / chunk / done / error).
 */
(function () {
  var TOKEN = "__TOKEN__";
  var B = window.ChatSaver;
  if (!B) return;
  if (window.__chatSaverRunning) { try { B.error(TOKEN, "Сбор уже идёт"); } catch (e) {} return; }
  window.__chatSaverRunning = true;
  var cancelled = false;
  window.__chatSaverCancel = function () { cancelled = true; };

  var CHUNK = 200000;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var progress = function (pct, msg) { try { B.progress(TOKEN, Math.round(pct), String(msg)); } catch (e) {} };

  function bodyText() { return (document.body && document.body.innerText) || ""; }
  function toLines(s) { return s.replace(/\r/g, "").split("\n"); }

  // Область, которая реально прокручивается (у чатов это обычно внутренний блок, а не окно)
  function pickScroller() {
    var se = document.scrollingElement || document.documentElement;
    var best = se, bestScroll = se.scrollHeight - se.clientHeight;
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var extra = el.scrollHeight - el.clientHeight;
      if (extra > 50 && el.clientHeight > 100 && extra > bestScroll) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "overlay") { best = el; bestScroll = extra; }
      }
    }
    return best;
  }

  function eq(a, ai, b, bi, n) {
    for (var k = 0; k < n; k++) if (a[ai + k] !== b[bi + k]) return false;
    return true;
  }

  // Склейка снимков: страницы с «виртуальным» списком держат в DOM только видимую часть,
  // поэтому текст собираем на каждом шаге и сшиваем по перекрытию строк.
  function merge(acc, cur) {
    if (!acc.length) return cur;
    var as = acc.join("\n"), cs = cur.join("\n");
    if (cs === as || as.indexOf(cs) !== -1) return acc;
    if (cs.indexOf(as) !== -1) return cur;
    var max = Math.min(acc.length, cur.length), k;
    for (k = max; k > 0; k--) {
      if (acc[acc.length - k] === cur[0] && eq(acc, acc.length - k, cur, 0, k)) return acc.concat(cur.slice(k));
    }
    for (k = max; k > 0; k--) {
      if (cur[cur.length - k] === acc[0] && eq(cur, cur.length - k, acc, 0, k)) return cur.concat(acc.slice(k));
    }
    return acc.concat([""], cur);
  }

  function send(text) {
    var parts = [], i = 0;
    while (i < text.length) {
      var end = Math.min(i + CHUNK, text.length);
      if (end < text.length) {
        var c = text.charCodeAt(end - 1);
        if (c >= 0xD800 && c <= 0xDBFF) end--; // не рвём суррогатную пару (эмодзи)
      }
      parts.push(text.substring(i, end));
      i = end;
    }
    if (!parts.length) parts.push("");
    for (var p = 0; p < parts.length; p++) B.chunk(TOKEN, p, parts[p]);
    B.done(TOKEN, parts.length, document.title || "", location.href);
  }

  async function run() {
    var acc = [];
    function snap() { acc = merge(acc, toLines(bodyText())); }

    progress(0, "Ищу область прокрутки…");
    var el = pickScroller();

    if (el.scrollHeight - el.clientHeight > 5) {
      // 1) вверх: подгружаем старые сообщения
      var stable = 0, lastH = -1;
      for (var i = 0; i < 80 && !cancelled && stable < 3; i++) {
        el.scrollTop = 0;
        await sleep(600);
        if (el.scrollHeight === lastH && el.scrollTop <= 1) stable++; else stable = 0;
        lastH = el.scrollHeight;
        progress(Math.min(10, i / 2), "Загружаю начало страницы…");
      }
      if (!cancelled) {
        // область могла смениться после подгрузки
        var again = pickScroller();
        if (again.scrollHeight - again.clientHeight > el.scrollHeight - el.clientHeight) el = again;
      }

      // 2) вниз порциями, на каждом шаге снимаем текст
      var pos = 0, noGrow = 0, prevH = el.scrollHeight, iter = 0;
      while (!cancelled && iter < 4000) {
        iter++;
        var step = Math.max(150, Math.floor(el.clientHeight * 0.7));
        el.scrollTop = pos;
        await sleep(350);
        snap();
        var max = el.scrollHeight - el.clientHeight;
        var pct = max > 0 ? Math.min(100, 10 + 90 * pos / max) : 100;
        progress(pct, "Прокручиваю и собираю текст… " + Math.round(pct) + "%");
        if (pos >= max - 2) {
          await sleep(800);          // дно: ждём, не подгрузится ли ещё
          var h2 = el.scrollHeight;
          if (h2 > prevH + 2) noGrow = 0; else { noGrow++; if (noGrow >= 2) break; }
          prevH = h2;
        }
        pos = Math.min(pos + step, Math.max(0, el.scrollHeight - el.clientHeight));
      }
    }
    if (cancelled) { B.error(TOKEN, "cancelled"); return; }
    await sleep(300);
    snap();
    progress(100, "Готовлю файл…");
    var text = acc.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
    send(text);
  }

  run().catch(function (e) {
    try { B.error(TOKEN, String(e && e.message || e)); } catch (x) {}
  }).then(function () { window.__chatSaverRunning = false; });
})();
