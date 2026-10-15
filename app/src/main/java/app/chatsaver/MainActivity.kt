package app.chatsaver

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class MainActivity : Activity() {

    private enum class Mode { SAVE, COPY }

    private lateinit var web: WebView
    private lateinit var urlField: EditText
    private lateinit var pageProgress: ProgressBar
    private lateinit var fabs: View
    private lateinit var saveOverlay: View
    private lateinit var saveStatus: TextView
    private lateinit var saveBar: ProgressBar
    private lateinit var resultBar: View
    private lateinit var resultText: TextView
    private lateinit var btnParts: Button

    private val ui = Handler(Looper.getMainLooper())

    // состояние сбора
    @Volatile private var token: String? = null
    private val chunks = HashMap<Int, String>()
    private var mode = Mode.SAVE
    private var lastProgressAt = 0L

    // результат последнего сохранения
    private var lastParts: List<String> = emptyList()
    private var lastUris: List<Uri> = emptyList()
    private var lastTitle = ""
    private var lastFull = ""

    private val watchdog = object : Runnable {
        override fun run() {
            if (token != null && System.currentTimeMillis() - lastProgressAt > 45_000) {
                failSave("Страница не отвечает. Попробуйте ещё раз.")
            }
            if (token != null) ui.postDelayed(this, 4_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        urlField = findViewById(R.id.urlField)
        pageProgress = findViewById(R.id.pageProgress)
        fabs = findViewById(R.id.fabs)
        saveOverlay = findViewById(R.id.saveOverlay)
        saveStatus = findViewById(R.id.saveStatus)
        saveBar = findViewById(R.id.saveBar)
        resultBar = findViewById(R.id.resultBar)
        resultText = findViewById(R.id.resultText)
        btnParts = findViewById(R.id.btnParts)

        setupWebView()

        findViewById<Button>(R.id.btnOpen).setOnClickListener { openFromField() }
        urlField.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            ) { openFromField(); true } else false
        }
        findViewById<Button>(R.id.btnSave).setOnClickListener { startCollect(Mode.SAVE) }
        findViewById<Button>(R.id.btnCopy).setOnClickListener { startCollect(Mode.COPY) }
        findViewById<Button>(R.id.btnCancel).setOnClickListener { cancelSave() }
        findViewById<Button>(R.id.btnShareAgain).setOnClickListener { share(lastUris, lastTitle) }
        btnParts.setOnClickListener { showPartsDialog() }
        findViewById<Button>(R.id.btnResultClose).setOnClickListener { resultBar.visibility = View.GONE }

        val last = getPreferences(MODE_PRIVATE).getString("last_url", null)
        if (!last.isNullOrBlank()) {
            urlField.setText(last)
            web.loadUrl(last)
        }
    }

    // ---------------------------------------------------------------- WebView

    private fun setupWebView() {
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportMultipleWindows(false)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        // Часть сайтов (вход через Google и др.) отказывает встроенным WebView: убираем метку "wv".
        s.userAgentString = s.userAgentString.replace("; wv", "").replace(Regex(" Version/\\d+\\.\\d+"), "")

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        web.addJavascriptInterface(Bridge(), "ChatSaver")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme ?: return true
                return !(scheme == "http" || scheme == "https")
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (!urlField.hasFocus()) urlField.setText(url)
                if (token != null) failSave("Страница сменилась во время сбора текста.")
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!urlField.hasFocus()) urlField.setText(url)
                getPreferences(MODE_PRIVATE).edit().putString("last_url", url).apply()
                CookieManager.getInstance().flush()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                toast("Страница аварийно закрылась. Откройте её снова.")
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                pageProgress.progress = newProgress
                pageProgress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }
        }
    }

    private fun normalize(input: String): String {
        val t = input.trim()
        if (t.isEmpty()) return ""
        if (t.startsWith("http://") || t.startsWith("https://")) return t
        if (!t.contains(' ') && t.contains('.')) return "https://$t"
        return "https://duckduckgo.com/?q=" + Uri.encode(t)
    }

    private fun openFromField() {
        val url = normalize(urlField.text.toString())
        if (url.isEmpty()) return
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(urlField.windowToken, 0)
        urlField.clearFocus()
        urlField.setText(url)
        web.loadUrl(url)
    }

    // ---------------------------------------------------------------- сбор текста

    private inner class Bridge {
        @JavascriptInterface fun progress(t: String, pct: Int, msg: String) {
            if (t != token) return
            lastProgressAt = System.currentTimeMillis()
            ui.post { if (t == token) { saveBar.progress = pct; saveStatus.text = msg } }
        }

        @JavascriptInterface fun chunk(t: String, idx: Int, s: String) {
            if (t != token) return
            synchronized(chunks) { chunks[idx] = s }
        }

        @JavascriptInterface fun done(t: String, n: Int, title: String, url: String) {
            if (t != token) return
            val sb = StringBuilder()
            synchronized(chunks) { for (i in 0 until n) sb.append(chunks[i] ?: "") }
            ui.post { if (t == token) onCollected(sb.toString(), title, url) }
        }

        @JavascriptInterface fun error(t: String, msg: String) {
            if (t != token) return
            ui.post { if (t == token) failSave(if (msg == "cancelled") null else "Ошибка: $msg") }
        }
    }

    private fun startCollect(m: Mode) {
        if (token != null) return
        val script = try {
            assets.open("collect.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        } catch (e: Exception) {
            toast("Не найден collect.js"); return
        }
        mode = m
        val t = UUID.randomUUID().toString()
        synchronized(chunks) { chunks.clear() }
        token = t
        lastProgressAt = System.currentTimeMillis()
        resultBar.visibility = View.GONE
        saveBar.progress = 0
        saveStatus.text = "Запускаю…"
        saveOverlay.visibility = View.VISIBLE
        fabs.visibility = View.GONE
        ui.removeCallbacks(watchdog)
        ui.postDelayed(watchdog, 4_000)
        val opts = org.json.JSONObject().put("mode", "chat").put("md", true).put("roles", true).put("scroll", true).toString()
        web.evaluateJavascript(script.replace("__TOKEN__", t).replace("__OPTS__", opts), null)
    }

    private fun cancelSave() {
        web.evaluateJavascript("window.__chatSaverCancel&&window.__chatSaverCancel()", null)
        endSaveUi()
        toast("Отменено")
    }

    private fun failSave(msg: String?) {
        web.evaluateJavascript("window.__chatSaverCancel&&window.__chatSaverCancel()", null)
        endSaveUi()
        if (msg != null) toast(msg)
    }

    private fun endSaveUi() {
        token = null
        ui.removeCallbacks(watchdog)
        saveOverlay.visibility = View.GONE
        fabs.visibility = View.VISIBLE
    }

    private fun onCollected(text: String, title: String, url: String) {
        endSaveUi()
        if (text.isBlank()) {
            toast("Текст на странице не найден")
            return
        }
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
        val md = buildString {
            append("# ").append(title.ifBlank { "Без названия" }).append("\n\n")
            append("Источник: ").append(url).append("\n")
            append("Сохранено: ").append(stamp).append("\n\n---\n\n")
            append(text).append("\n")
        }
        lastFull = md
        lastTitle = title.ifBlank { "Chat Saver" }

        if (mode == Mode.COPY) {
            copyToClipboard(md)
            return
        }
        if (md.length > PART_SIZE) {
            AlertDialog.Builder(this)
                .setTitle("Большой текст")
                .setMessage("Всего ${spaced(md.length)} символов. Разбить на части по ${spaced(PART_SIZE)} символов?")
                .setPositiveButton("Разбить") { _, _ -> saveAndShare(md, url, true) }
                .setNegativeButton("Одним файлом") { _, _ -> saveAndShare(md, url, false) }
                .setNeutralButton("Отмена", null)
                .show()
        } else {
            saveAndShare(md, url, false)
        }
    }

    // ---------------------------------------------------------------- файл, «Поделиться», буфер

    private fun saveAndShare(md: String, url: String, split: Boolean) {
        val parts = if (split) splitText(md, PART_SIZE) else listOf(md)
        val host = (Uri.parse(url).host ?: "page").replace(Regex("[^A-Za-z0-9.-]"), "_")
        val base = "chat-saver_" + host + "_" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val shareDir = ShareProvider.dir(this)
        shareDir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 24 * 3600_000L) it.delete() }

        val uris = ArrayList<Uri>()
        var where = ""
        val contents = ArrayList<String>()
        parts.forEachIndexed { i, p ->
            val name = if (parts.size > 1) "${base}_part${i + 1}of${parts.size}.md" else "$base.md"
            val content = if (parts.size > 1) "(Часть ${i + 1} из ${parts.size})\n\n$p" else p
            contents.add(content)
            where = saveToDocuments(name, content)
            File(shareDir, name).writeText(content, Charsets.UTF_8)
            uris.add(ShareProvider.uriFor(this, name))
        }
        lastParts = contents
        lastUris = uris
        resultText.text = "Сохранено: $where" +
            (if (parts.size > 1) "\nФайлов: ${parts.size} (по ≤ ${spaced(PART_SIZE)} символов)" else "") +
            "\nСимволов: ${spaced(md.length)}"
        btnParts.visibility = if (parts.size > 1) View.VISIBLE else View.GONE
        resultBar.visibility = View.VISIBLE
        share(uris, lastTitle)
    }

    /** Возвращает путь для показа пользователю. */
    private fun saveToDocuments(name: String, content: String): String {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val v = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, "text/markdown")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/ChatSaver")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Files.getContentUri("external"), v)
                    ?: throw IllegalStateException("insert failed")
                contentResolver.openOutputStream(uri)!!.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                v.clear()
                v.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, v, null, null)
                return "Документы/ChatSaver/$name"
            }
        } catch (e: Exception) {
            // ниже запасной вариант
        }
        return try {
            val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "ChatSaver").apply { mkdirs() }
            File(dir, name).writeText(content, Charsets.UTF_8)
            "Android/data/$packageName/files/Documents/ChatSaver/$name"
        } catch (e: Exception) {
            "не удалось сохранить в «Документы» (файл всё равно можно отправить)"
        }
    }

    private fun share(uris: List<Uri>, title: String) {
        if (uris.isEmpty()) return
        val i = if (uris.size == 1) {
            Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        }
        i.type = "text/plain"
        i.putExtra(Intent.EXTRA_SUBJECT, title)
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val clip = ClipData.newRawUri("Chat Saver", uris[0])
        for (k in 1 until uris.size) clip.addItem(ClipData.Item(uris[k]))
        i.clipData = clip
        startActivity(Intent.createChooser(i, "Поделиться"))
    }

    private fun copyToClipboard(text: String) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Chat Saver", text))
            toast("Скопировано: ${spaced(text.length)} символов")
        } catch (e: Exception) {
            toast("Текст слишком большой для буфера. Используйте «Сохранить текст».")
        }
    }

    private fun showPartsDialog() {
        if (lastParts.size < 2) return
        val items = lastParts.mapIndexed { i, p -> "Часть ${i + 1} из ${lastParts.size} (${spaced(p.length)} симв.) — копировать" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Копировать по частям")
            .setItems(items) { _, which -> copyToClipboard(lastParts[which]) }
            .setPositiveButton("Копировать всё") { _, _ -> copyToClipboard(lastFull) }
            .setNegativeButton("Закрыть", null)
            .show()
    }

    // ---------------------------------------------------------------- прочее

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    private fun spaced(n: Int): String = "%,d".format(Locale.US, n).replace(',', ' ')

    override fun onPause() {
        CookieManager.getInstance().flush()
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            token != null -> cancelSave()
            web.canGoBack() -> web.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        web.removeJavascriptInterface("ChatSaver")
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val PART_SIZE = 20_000

        /** Режет по границе строки (если она есть во второй половине куска), иначе жёстко. Эмодзи не рвёт. */
        fun splitText(t: String, max: Int): List<String> {
            val out = ArrayList<String>()
            var i = 0
            while (i < t.length) {
                var end = minOf(i + max, t.length)
                if (end < t.length) {
                    val nl = t.lastIndexOf('\n', end - 1)
                    if (nl > i + max / 2) end = nl + 1
                    else if (Character.isHighSurrogate(t[end - 1])) end--
                }
                out.add(t.substring(i, end))
                i = end
            }
            return out
        }
    }
}
