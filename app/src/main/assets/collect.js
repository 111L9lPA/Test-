/*
 * Chat Saver: прокручивает страницу порциями и собирает текст.
 * Запускается из MainActivity; __TOKEN__ и __OPTS__ подставляет приложение.
 *   OPTS.mode   "chat" — только область с сообщениями, "page" — вся страница
 *   OPTS.md     true — сохранять форматирование (Markdown), false — простой текст
 *   OPTS.roles  true — подписывать реплики «Пользователь / Ассистент» на известных сайтах
 *   OPTS.scroll false — без прокрутки, только то, что сейчас на странице
 * Результат уходит в приложение через window.ChatSaver (progress / chunk / done / error).
 */
(function () {
  var TOKEN = "__TOKEN__";
  var OPTS = __OPTS__;
  var B = window.ChatSaver;
  if (!B) return;
  if (window.__chatSaverRunning) { try { B.error(TOKEN, "Сбор уже идёт"); } catch (e) {} return; }
  window.__chatSaverRunning = true;
  var cancelled = false;
  window.__chatSaverCancel = function () { cancelled = true; };

  var CHUNK = 200000;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var progress = function (pct, msg) { try { B.progress(TOKEN, Math.round(pct), String(msg)); } catch (e) {} };
  var SE = document.scrollingElement || document.documentElement;

  /* ------------------------------------------------------------ где прокручивать */

  function viewport() {
    return { w: window.innerWidth || document.documentElement.clientWidth, h: window.innerHeight || document.documentElement.clientHeight };
  }
  function overflowScrolls(el) {
    var oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }
  function isScrollable(el) {
    return el.scrollHeight - el.clientHeight > 50 && el.clientHeight > 100 && overflowScrolls(el);
  }
  function scrollableAncestor(el) {
    for (var e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (isScrollable(e)) return e;
    }
    return null;
  }
  function visibleArea(el) {
    var r = el.getBoundingClientRect(), v = viewport();
    var w = Math.min(r.right, v.w) - Math.max(r.left, 0), h = Math.min(r.bottom, v.h) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }
  // Самая заметная прокручиваемая область: большая видимая площадь и много содержимого.
  // Скрытое боковое меню (за краем экрана) площади не имеет и не выбирается.
  function pickScroller() {
    var v = viewport(), vp = v.w * v.h, best = null, bestScore = 0;
    var seExtra = SE.scrollHeight - SE.clientHeight;
    if (seExtra > 50) { best = SE; bestScore = vp * Math.log(seExtra + 1); }
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i], extra = el.scrollHeight - el.clientHeight;
      if (extra <= 50 || el.clientHeight < 100) continue;
      var area = visibleArea(el);
      if (area < vp * 0.1) continue;
      if (!overflowScrolls(el) || getComputedStyle(el).visibility === "hidden") continue;
      var score = area * Math.log(extra + 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best || SE;
  }

  /* ------------------------------------------------------------ HTML → Markdown */

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1, BUTTON: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, OPTION: 1, IFRAME: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, DIALOG: 1 };
  var INLINE = { SPAN: 1, SMALL: 1, SUB: 1, SUP: 1, MARK: 1, U: 1, ABBR: 1, TIME: 1, LABEL: 1, Q: 1, CITE: 1, KBD: 1,
    FONT: 1, VAR: 1, SAMP: 1, DFN: 1, BDI: 1, BDO: 1, WBR: 1, DATA: 1, OUTPUT: 1 };
  var BLOCKY = "p,div,li,pre,ul,ol,table,h1,h2,h3,h4,h5,h6,br,blockquote,section,article";

  // Реплики на сайтах ИИ-чатов (если разметка не совпала — подписей просто не будет)
  function roleOf(el) {
    var r = el.getAttribute("data-message-author-role");            // ChatGPT
    if (r === "user") return "user";
    if (r === "assistant") return "ai";
    if (el.getAttribute("data-testid") === "user-message") return "user"; // Claude
    var t = el.tagName;
    if (t === "USER-QUERY") return "user";                            // Gemini
    if (t === "MODEL-RESPONSE") return "ai";
    var c = el.classList;
    if (c && (c.contains("font-claude-message") || c.contains("font-claude-response"))) return "ai";
    return null;
  }

  function toMarkdown(root) {
    var lines = [], cur = "", curPre = "", stack = [], marker = null;
    var roleDepth = 0, needAi = false, listDepth = 0;

    function pre() { return stack.join(""); }
    function flush() {
      var s = cur.replace(/\s+$/, "");
      if (s) lines.push(curPre + s);
      cur = "";
    }
    function para() {
      flush();
      if (stack.length) return; // внутри списков и цитат пустых строк не ставим
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    }
    function raw(line) { flush(); lines.push(pre() + line); }
    function heading(h) {
      para();
      var i = lines.length - 1;
      while (i >= 0 && lines[i] === "") i--;
      if (i >= 0 && lines[i] === h) return; // не дублируем подпись
      lines.push(h);
      lines.push("");
    }
    function emit(t) {
      if (!t) return;
      if (cur === "") {
        t = t.replace(/^\s+/, "");
        if (!t) return;
        if (needAi && roleDepth === 0) { needAi = false; heading("### Ассистент"); }
        if (marker !== null) { curPre = stack.slice(0, -1).join("") + marker; marker = null; }
        else curPre = pre();
      }
      cur += t;
    }
    function squash(s) { return (s || "").replace(/[\s ]+/g, " "); }
    function around(rawText, core) {
      return (/^\s/.test(rawText) ? " " : "") + core + (/\s$/.test(rawText) ? " " : "");
    }
    function hidden(el) {
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
      if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") return true;
      if (OPTS.roles && el.classList && (el.classList.contains("sr-only") || el.classList.contains("visually-hidden"))) return true;
      if (el.offsetParent === null && el !== root && el.tagName !== "BODY" && el.tagName !== "HTML") {
        var cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      }
      return false;
    }
    function kids(el) { for (var c = el.firstChild; c; c = c.nextSibling) walk(c); }
    function wrap(el, l, r) {
      if (el.querySelector(BLOCKY)) { kids(el); return; }
      var t = squash(el.textContent);
      if (t.trim()) emit(around(t, l + t.trim() + r));
    }
    function link(el) {
      if (el.querySelector(BLOCKY)) { kids(el); return; }
      var t = squash(el.textContent), core = t.trim(), href = el.getAttribute("href") || "";
      if (!core) return;
      if (!href || /^(javascript:|#)/i.test(href)) { emit(t); return; }
      try { href = new URL(href, location.href).href; } catch (e) {}
      emit(around(t, core === href ? href : "[" + core + "](" + href + ")"));
    }
    function inlineCode(el) {
      var t = (el.textContent || "").replace(/\n/g, " ");
      if (!t.trim()) return;
      emit(t.indexOf("`") >= 0 ? "`` " + t + " ``" : "`" + t + "`");
    }
    function codeBlock(el) {
      var code = el.querySelector("code") || el;
      var m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec((code.className || "") + " " + (el.className || ""));
      var text = (code.textContent || "").replace(/\r/g, "").replace(/\n+$/, "");
      var fence = text.indexOf("```") >= 0 ? "~~~~" : "```";
      para();
      raw(fence + (m ? m[1] : ""));
      text.split("\n").forEach(function (l) { raw(l); });
      raw(fence);
      para();
    }
    function tex(el) {
      var a = el.querySelector('annotation[encoding="application/x-tex"]');
      var t = (a ? a.textContent : el.textContent || "").trim();
      if (!t) return;
      var p = el.parentElement;
      if (el.classList.contains("katex-display") || (p && p.classList.contains("katex-display"))) {
        para(); raw("$$"); raw(t); raw("$$"); para();
      } else emit(" $" + t + "$ ");
    }
    function table(el) {
      para();
      var rows = el.querySelectorAll("tr"), first = true;
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll("th,td");
        if (!cells.length) continue;
        var vals = [];
        for (var j = 0; j < cells.length; j++) vals.push(squash(cells[j].innerText || cells[j].textContent).trim().replace(/\|/g, "\\|"));
        raw("| " + vals.join(" | ") + " |");
        if (first) { raw("|" + vals.map(function () { return " --- "; }).join("|") + "|"); first = false; }
      }
      para();
    }
    function listItem(li, mk) {
      flush();
      stack.push(new Array(mk.length + 1).join(" "));
      marker = mk;
      kids(li);
      flush();
      marker = null;
      stack.pop();
    }
    function list(el, ordered) {
      listDepth > 0 ? flush() : para();
      listDepth++;
      var n = ordered ? (parseInt(el.getAttribute("start") || "1", 10) || 1) : 0;
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.tagName === "LI") {
          if (!hidden(c)) listItem(c, ordered ? (n++) + ". " : "- ");
        } else walk(c);
      }
      listDepth--;
      listDepth > 0 ? flush() : para();
    }
    function block(el, tag) {
      switch (tag) {
        case "BR": flush(); return;
        case "HR": para(); raw("---"); para(); return;
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          para(); emit(new Array(+tag[1] + 1).join("#") + " "); kids(el); para(); return;
        case "P": para(); kids(el); para(); return;
        case "PRE": codeBlock(el); return;
        case "CODE": inlineCode(el); return;
        case "B": case "STRONG": wrap(el, "**", "**"); return;
        case "I": case "EM": wrap(el, "*", "*"); return;
        case "S": case "DEL": case "STRIKE": wrap(el, "~~", "~~"); return;
        case "A": link(el); return;
        case "IMG": {
          var alt = (el.getAttribute("alt") || "").trim();
          if (alt) emit(" [Изображение: " + alt + "] ");
          return;
        }
        case "UL": case "OL": list(el, tag === "OL"); return;
        case "LI": listItem(el, "- "); return;
        case "BLOCKQUOTE": para(); stack.push("> "); kids(el); flush(); stack.pop(); para(); return;
        case "TABLE": table(el); return;
      }
      if (INLINE[tag]) { kids(el); return; }
      flush(); kids(el); flush(); // div и прочие блоки
    }
    function walk(n) {
      if (n.nodeType === 3) { if (n.nodeValue) emit(squash(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      var el = n, tag = el.tagName;
      if (SKIP[tag] || hidden(el)) return;
      if (el.classList && el.classList.contains("katex")) { tex(el); return; }
      var role = OPTS.roles && roleDepth === 0 ? roleOf(el) : null;
      if (role) {
        needAi = false;
        heading(role === "user" ? "### Пользователь" : "### Ассистент");
        roleDepth++;
        block(el, tag);
        roleDepth--;
        para();
        if (role === "user") needAi = true; // ответ ИИ без своей разметки подпишем сами
        return;
      }
      block(el, tag);
    }

    walk(root);
    flush();
    return lines.join("\n");
  }

  /* ------------------------------------------------------------ склейка снимков */

  function eq(a, ai, b, bi, n) {
    for (var k = 0; k < n; k++) if (a[ai + k] !== b[bi + k]) return false;
    return true;
  }
  // Страницы с «виртуальным» списком держат в DOM только видимую часть,
  // поэтому текст снимаем на каждом шаге и сшиваем по перекрытию строк.
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

  // Убираем лишние пустые строки (кроме блоков кода) и пустые заголовки
  function tidy(text) {
    var out = [], inFence = false, blank = 0, maxBlank = OPTS.md ? 1 : 2;
    text.split("\n").forEach(function (l) {
      var t = l.replace(/[ \t ]+$/, "");
      if (/^\s*(```|~~~~)/.test(t)) inFence = !inFence;
      else if (!inFence) {
        if (t.trim() === "") { if (++blank <= maxBlank) out.push(""); return; }
        if (/^#{1,6}$/.test(t.trim())) return;
      }
      blank = 0;
      out.push(t);
    });
    return out.join("\n").trim();
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

  /* ------------------------------------------------------------ сбор */

  async function run() {
    progress(0, "Ищу область с текстом…");
    var target = window.__chatSaverTarget;
    if (target && !document.documentElement.contains(target)) target = null;
    var el = target ? (isScrollable(target) ? target : (scrollableAncestor(target) || pickScroller())) : pickScroller();
    var root = target ||
      (OPTS.mode === "page" ? document.body
        : (el !== SE && el !== document.body ? el : (document.querySelector("main") || document.body)));

    var acc = [];
    function snap() {
      var t = OPTS.md ? toMarkdown(root) : (root.innerText || "");
      acc = merge(acc, t.replace(/\r/g, "").split("\n"));
    }

    var startTop = el.scrollTop;
    var wasBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 50;

    if (OPTS.scroll !== false && el.scrollHeight - el.clientHeight > 5) {
      // 1) вверх: подгружаем старые сообщения
      var stable = 0, lastH = -1;
      for (var i = 0; i < 80 && !cancelled && stable < 3; i++) {
        el.scrollTop = 0;
        await sleep(600);
        if (el.scrollHeight === lastH && el.scrollTop <= 1) stable++; else stable = 0;
        lastH = el.scrollHeight;
        progress(Math.min(10, i / 2), "Загружаю начало страницы…");
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
          await sleep(800); // дно: ждём, не подгрузится ли ещё
          var h2 = el.scrollHeight;
          if (h2 > prevH + 2) noGrow = 0; else { noGrow++; if (noGrow >= 2) break; }
          prevH = h2;
        }
        pos = Math.min(pos + step, Math.max(0, el.scrollHeight - el.clientHeight));
      }
    }
    if (cancelled) { B.error(TOKEN, "cancelled"); return; }
    await sleep(OPTS.scroll === false ? 0 : 300);
    snap();
    // возвращаем страницу туда, где она была
    el.scrollTop = wasBottom ? el.scrollHeight : startTop;
    progress(100, "Готовлю файл…");
    send(tidy(acc.join("\n")));
  }

  run().catch(function (e) {
    try { B.error(TOKEN, String(e && e.message || e)); } catch (x) {}
  }).then(function () { window.__chatSaverRunning = false; });
})();
